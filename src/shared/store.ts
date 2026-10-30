/**
 * DSHBar · 进程无关的 JSON 存储适配器。
 *
 * 主进程与 MCP 服务器是两个独立进程，只通过同一个 JSON 文件共享任务状态。
 * 任何写入都必须原子化（写 `<file>.tmp` 后 rename），避免任何进程读到半写状态。
 *
 * 设计要点：
 * - mutate()：读磁盘最新 → 深拷贝 → 应用 TaskAction → 原子写回 → 返回新副本。
 *   每次写入前都重新读盘，避免基于陈旧快照覆盖另一个进程刚写入的内容。
 * - watch()：监听 store 所在目录的 fs.watch 事件并按文件名过滤；原子写引起的
 *   rename 会让 fs.watch 失效，因此每次事件后重新 attach。
 *
 * 本文件只依赖 Node 内置模块，且被排除在 tsconfig.renderer.json 之外
 * （仅主进程 / preload / MCP 使用，保证 dist/shared 下保持 CommonJS）。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StoreFile, TaskAction, Task } from './types';

export const STORE_FILE_NAME = 'store.json';

export const DEFAULT_SETTINGS = {
  lang: 'system' as const,
  hotkey: 'Alt+W',
  launchAtLogin: false,
};

/** 构造一个空 StoreFile（未落盘）。 */
export function createEmptyStore(): StoreFile {
  return {
    version: 1,
    tasks: [],
    settings: { ...DEFAULT_SETTINGS },
  };
}

/**
 * 默认 store 路径：Windows 为 %APPDATA%/DSHBar/store.json（APPDATA 缺失时回退用户主目录）。
 *
 * 优先读取环境变量 `DSHBAR_STORE`（完整路径指向 store.json），便于冒烟测试与
 * 用户目录被重定向/只读时的逃生通道：`set DSHBAR_STORE=E:\path\to\store.json`。
 */
export function defaultStorePath(): string {
  const override = process.env.DSHBAR_STORE;
  if (typeof override === 'string' && override.trim() !== '') {
    return override;
  }
  const base = process.env.APPDATA ?? os.homedir();
  return path.join(base, 'DSHBar', STORE_FILE_NAME);
}

function nowIso(): string {
  return new Date().toISOString();
}

function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 按 order 升序稳定插入，保持列表有序（同 order 时新任务排后）。 */
function insertByOrder(tasks: Task[], task: Task): Task[] {
  const idx = tasks.findIndex((t) => t.order > task.order);
  if (idx === -1) {
    return [...tasks, task];
  }
  return [...tasks.slice(0, idx), task, ...tasks.slice(idx)];
}

/** 应用单个 TaskAction 到 store 副本上（就地修改 draft）。 */
function applyAction(draft: StoreFile, action: TaskAction): void {
  switch (action.type) {
    case 'add': {
      const task: Task = { ...deepCopy(action.task), updatedAt: nowIso() };
      draft.tasks = insertByOrder(draft.tasks, task);
      break;
    }
    case 'update': {
      draft.tasks = draft.tasks.map((t) =>
        t.id === action.id
          ? { ...t, ...deepCopy(action.patch), updatedAt: nowIso() }
          : t,
      );
      break;
    }
    case 'reorder': {
      const rank = new Map(action.ids.map((id, i) => [id, i]));
      draft.tasks = draft.tasks
        .map((t) => (rank.has(t.id) ? { ...t, order: rank.get(t.id) ?? t.order } : t))
        .sort((a, b) => a.order - b.order);
      break;
    }
    case 'remove': {
      draft.tasks = draft.tasks.filter((t) => t.id !== action.id);
      break;
    }
    case 'reset': {
      const incoming = deepCopy(action.store);
      draft.version = incoming.version;
      draft.tasks = incoming.tasks;
      draft.settings = incoming.settings;
      break;
    }
  }
}

/**
 * 计时语义（桌面端与 MCP 共用，唯一事实来源）
 * -----------------------------------------------------------
 * - `elapsedSeconds`：**已结束**的计时段累计秒数（不含当前正在跑的那一段）。
 * - `startedAt`：当前计时段的开始时间（ISO）；非 running 时为 null。
 * - 因此「任务此刻已投入的秒数」= elapsedSeconds + (now - startedAt)。
 *
 * 关键点：**running 期间任何一方都不应该直接给 elapsedSeconds 加秒数**，
 * 否则 GUI（每秒落盘）与 MCP（读盘时按 now-startedAt 推算）会各算一遍，
 * 导致时间被重复计算。正确做法是：时段结束或需要持久化时，用
 * `foldRunningSegment()` 把当前段「折」进 elapsedSeconds 并顺延 startedAt——
 * 折叠前后「此刻已投入秒数」保持不变，因此任何时刻被谁读到都一致。
 */

/** 把 running 任务的当前计时段折进 elapsedSeconds，并把 startedAt 顺延到 nowMs。 */
export function foldRunningSegment(task: Task, nowMs: number): Task {
  if (task.status !== 'running' || !task.startedAt) return task;
  const started = Date.parse(task.startedAt);
  if (Number.isNaN(started)) return task;
  const delta = Math.max(0, (nowMs - started) / 1000);
  if (delta === 0) return task;
  return {
    ...task,
    elapsedSeconds: Math.round((task.elapsedSeconds + delta) * 100) / 100,
    startedAt: new Date(nowMs).toISOString(),
  };
}
/** 对 store 里所有 running 任务执行一次折叠（用于 GUI 每秒落盘时刷新进度）。 */
export function foldRunningSegments(store: StoreFile, nowMs: number): StoreFile {
  if (!store.tasks.some((t) => t.status === 'running' && t.startedAt)) return store;
  const stamp = nowIso();
  let changed = false;
  const tasks = store.tasks.map((t) => {
    const folded = foldRunningSegment(t, nowMs);
    if (folded !== t) changed = true;
    return folded;
  });
  if (!changed) return store;
  return { ...store, tasks: tasks.map((t) => ({ ...t, updatedAt: stamp })) };
}

/**
 * 纯函数：把所有 status === 'running' 的任务累计 elapsedSeconds。
 *
 * @deprecated 保留给旧调用方；计时语义已改为「段折叠」模型，请改用
 * {@link foldRunningSegments}。该旧函数按固定增量累加，与 MCP 的
 * `now - startedAt` 推算叠加会造成重复计时。
 */
export function tickRunning(
  store: StoreFile,
  nowSec: number,
  lastTickSec: number | null,
): { store: StoreFile; lastTickSec: number | null } {
  const hasRunning = store.tasks.some((t) => t.status === 'running');
  const next: StoreFile = deepCopy(store);
  if (!hasRunning) {
    return { store, lastTickSec: nowSec };
  }
  const delta = lastTickSec == null ? 0 : Math.max(0, nowSec - lastTickSec);
  if (delta > 0) {
    const stamp = nowIso();
    next.tasks = next.tasks.map((t) =>
      t.status === 'running' ? { ...t, elapsedSeconds: t.elapsedSeconds + delta, updatedAt: stamp } : t,
    );
  }
  return { store: next, lastTickSec: nowSec };
}

/**
 * 合并两份 store 快照，解决多进程并发写入的丢更新问题。
 *
 * 背景：GUI 每秒把计时进度落盘（只是把 running 段往前折一点），MCP 也会
 * 读改写同一份文件（改状态、加/删任务）。两者交错时，单纯「后写覆盖前写」
 * 会丢掉对方的改动。
 *
 * 核心规则：**磁盘上的「状态」永远优先**。
 * 原因是本进程内存里的快照可能已经过期（对方刚改了状态），而本进程每秒
 * 折叠计时会把 `updatedAt` 刷成「现在」，让过期的 running 看起来比磁盘上
 * 更新的 paused/completed 还新。用时间戳判断谁新会得出错误结论。
 *
 * 因此：
 * - 状态（status）、标题、预估、顺序、备注、取消原因 → 一律取磁盘。
 * - 只有「双方都是 running」时，才从内存取更长的计时进度
 *   （elapsedSeconds + now - startedAt 更大的那一份），避免把刚跑过的秒数
 *   回退掉。
 * - 磁盘上没有、只有内存里有的任务 → 视为对方已删除，丢弃（不复活）。
 *   唯一例外：磁盘整体为空而内存非空，通常是读到瞬时空文件，此时信任内存。
 *
 * @param disk  刚从磁盘读到的快照（权威）
 * @param local 本进程内存中的快照（准备写回的那一份）
 * @param nowMs 当前时间戳（毫秒）
 */
export function mergeStoreFiles(disk: StoreFile, local: StoreFile, nowMs: number): StoreFile {
  // 磁盘读到空、内存非空：大概率是瞬时读取问题，不要据此清空任务。
  if (disk.tasks.length === 0 && local.tasks.length > 0) {
    return { ...local, settings: { ...disk.settings, ...local.settings } };
  }

  const diskById = new Map(disk.tasks.map((t) => [t.id, t]));
  const localById = new Map(local.tasks.map((t) => [t.id, t]));
  const merged: Task[] = [];

  for (const d of disk.tasks) {
    const l = localById.get(d.id);
    if (!l) {
      merged.push(d);
      continue;
    }

    // 双方都在跑：保留更长的计时进度（其余字段仍以磁盘为准）。
    if (d.status === 'running' && l.status === 'running') {
      const secOf = (t: Task): number =>
        t.elapsedSeconds +
        (t.startedAt ? Math.max(0, (nowMs - Date.parse(t.startedAt)) / 1000) : 0);
      const dSec = secOf(d);
      const lSec = secOf(l);
      let timing: Task;
      if (Math.abs(dSec - lSec) <= 1) {
        // 两种表示等价（折叠前后「此刻已投入」不变）：取折叠得更晚的一份，
        // 即 startedAt 更晚的那一份，让落盘的 elapsedSeconds 保持新鲜。
        const dStart = d.startedAt ? Date.parse(d.startedAt) || 0 : 0;
        const lStart = l.startedAt ? Date.parse(l.startedAt) || 0 : 0;
        timing = lStart > dStart ? l : d;
      } else {
        timing = dSec > lSec ? d : l;
      }
      if (timing !== d) {
        merged.push({ ...d, elapsedSeconds: timing.elapsedSeconds, startedAt: timing.startedAt });
        continue;
      }
    }
    merged.push(d);
  }

  merged.sort((a, b) => a.order - b.order);
  return {
    version: 1,
    tasks: merged,
    settings: { ...disk.settings, ...local.settings },
  };
}

export class StoreAdapter {
  readonly filePath: string;
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  /** 最后一次成功读取/写入的数据副本；写盘失败时靠它保证 GUI 仍可用。 */
  private lastGood: StoreFile | null = null;

  constructor(filePath: string = defaultStorePath()) {
    this.filePath = filePath;
  }

  /** 读盘；文件不存在时返回空 store（并尝试落盘）。解析失败时备份损坏文件并重建。 */
  load(): StoreFile {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch {
      const empty = createEmptyStore();
      this.write(empty); // 写盘失败已在 write 内吞掉，这里始终返回 empty
      return empty;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<StoreFile>;
      if (parsed && parsed.version === 1 && Array.isArray(parsed.tasks) && parsed.settings) {
        this.lastGood = parsed as StoreFile;
        return parsed as StoreFile;
      }
      throw new Error('invalid shape');
    } catch {
      this.backupCorrupted();
      const empty = createEmptyStore();
      this.write(empty);
      return empty;
    }
  }

  /** 读磁盘最新 → fn 深拷贝并返回 action（或 void）→ 应用 → 原子写回 → 返回新副本。 */
  mutate(fn: (s: StoreFile) => TaskAction | void): StoreFile {
    const current = this.load();
    const draft = deepCopy(current);
    const action = fn(draft);
    if (action) {
      applyAction(draft, action);
    }
    this.write(draft);
    return deepCopy(draft);
  }

  /**
   * 原子写回（temp + rename）。**失败不抛出**：保留内存副本，GUI 仍可操作，
   * MCP 侧读到的是最后一次成功写入。写盘失败不影响运行。
   */
  /**
   * 原子写回（temp + rename）。
   *
   * 注意：`data` 必须是**基于最新磁盘内容**的快照。这里不做合并——
   * 合并规则由调用方负责（见 mergeStoreFiles）。原因是本文件同时被
   * GUI（每秒落盘）和 MCP（读改写）两个进程使用，任何「读-改-写」之间
   * 都可能被对方插入写入；不做合并就会丢更新（例如 GUI 把 MCP 刚标记
   * completed 的任务又写回 running）。
   */
  write(data: StoreFile): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmp, this.filePath);
    } catch {
      /* 目录只读/权限拒绝/磁盘满等：吞掉错误，靠 lastGood 继续服务内存读 */
    }
    this.lastGood = data;
  }

  /**
   * 监听 store 文件变化，150ms 去抖后回调 onChange()。
   * 监听的是目录（因为原子写 rename 会让旧的单文件 watch 失效），并按文件名过滤。
   * 事件后重新 attach，保证 rename 之后仍然能收到后续变化。返回取消函数。
   */
  watch(onChange: () => void): () => void {
    const dir = path.dirname(this.filePath);
    const base = path.basename(this.filePath);
    let cancelled = false;

    // 首次运行时目录可能尚不存在，fs.watch 会抛错导致静默停止监听；
    // 这里先尝试建目录（失败也无害），保证第一次运行就能开始监听。
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* 目录不可建（只读等）：监听会失败，属预期，不影响其它功能 */
    }

    const attach = () => {
      if (cancelled) return;
      this.watcher?.close();
      let watcher: fs.FSWatcher;
      try {
        watcher = fs.watch(dir, (_event, filename) => {
          if (!filename || filename.toString() !== base) return;
          this.schedule(onChange, () => attach());
        });
      } catch {
        return;
      }
      watcher.on('error', () => {
        /* 目录被删等场景，忽略，等下次事件重建 */
      });
      this.watcher = watcher;
    };

    attach();

    return () => {
      cancelled = true;
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }
      this.watcher?.close();
      this.watcher = null;
    };
  }

  private schedule(onChange: () => void, onFired: () => void): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      onChange();
      onFired();
    }, 150);
  }

  private backupCorrupted(): void {
    try {
      fs.renameSync(this.filePath, `${this.filePath}.bak`);
    } catch {
      /* 忽略备份失败 */
    }
  }
}