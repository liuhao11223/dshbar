/**
 * DSHBar · 渲染层逻辑（纯 TS + DOM，无前端框架）。
 *
 * 计时：主进程每秒通过 store:changed 推送权威快照；本层在两次推送之间用
 * setInterval 本地推进 running 任务的秒数显示，不向后端轮询。
 */
import { messages, type MessageKey } from '../shared/i18n.js';
import type { StoreFile, Task, WindowMode, DockSide } from '../shared/types';

const RING_CIRCUMFERENCE = 2 * Math.PI * 24; // 与 CSS 中 r=24 对应

const el = {
  topline: document.getElementById('topline') as HTMLDivElement,
  card: document.getElementById('card') as HTMLDivElement,
  prev: document.getElementById('btn-prev') as HTMLButtonElement,
  next: document.getElementById('btn-next') as HTMLButtonElement,
  toggle: document.getElementById('btn-toggle') as HTMLButtonElement,
  done: document.getElementById('btn-done') as HTMLButtonElement,
  collapse: document.getElementById('btn-collapse') as HTMLButtonElement,
  ringFg: document.querySelector<SVGCircleElement>('#ring-fg')!,
  ringFgDisc: document.querySelector<SVGCircleElement>('#ring-fg-disc')!,
  time: document.getElementById('time') as HTMLSpanElement,
  timeDisc: document.getElementById('time-disc') as HTMLSpanElement,
  title: document.getElementById('title') as HTMLDivElement,
};

let store: StoreFile | null = null;
let mode: WindowMode = window.innerHeight <= 10 ? 'collapsed' : 'expanded';
let dock: DockSide = 'top';
let dragging = false;
let viewIdx = 0;
let manualNav = false;
let lastRunningId: string | null = null;
let anchor = { id: '', elapsed: 0, at: 0 };

document.body.classList.toggle('expanded', mode === 'expanded');

/* ------------------------------- 形态 class ------------------------------- */

function applyBodyClasses(): void {
  document.body.classList.toggle('expanded', mode === 'expanded');
  document.body.classList.toggle('dock-bottom', dock === 'bottom');
  document.body.classList.toggle('dock-free', dock === 'free');
  document.body.classList.toggle('dragging', dragging);
}

/* ------------------------------- 工具 ------------------------------- */

function activeTasks(source: StoreFile): Task[] {
  // completed 从可浏览列表中隐藏；aborted 保留在列表中以便手动查看（显示「已取消」），
  // 但不会被自动跟随选中、也不参与计时（tick 只处理 running）。
  return source.tasks
    .filter((t) => t.status !== 'completed')
    .slice()
    .sort((a, b) => a.order - b.order);
}

function viewedTask(): Task | null {
  if (!store) return null;
  const list = activeTasks(store);
  if (list.length === 0) return null;
  if (viewIdx < 0 || viewIdx >= list.length) viewIdx = list.length - 1;
  return list[viewIdx];
}

function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const mm = String(m).padStart(2, '0');
  const sc = String(ss).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${sc}` : `${mm}:${sc}`;
}

function colorFor(hue: number): string {
  return `hsl(${hue.toFixed(0)}, 72%, 55%)`;
}

/**
 * 显示用秒数：running 任务在两次推送之间本地推进。
 *
 * 计时语义（与主进程 / MCP 一致）：
 *   此刻已投入 = elapsedSeconds（已结束的段） + (now - startedAt)（进行中的段）
 * elapsedSeconds 不含当前正在跑的那一段，所以这里要补上 startedAt 起的偏移。
 */
function displayElapsed(task: Task): number {
  if (task.status === 'running' && task.startedAt) {
    const started = Date.parse(task.startedAt);
    if (!Number.isNaN(started)) {
      return task.elapsedSeconds + Math.max(0, (Date.now() - started) / 1000);
    }
  }
  if (task.status === 'running' && task.id === anchor.id) {
    // 没有 startedAt 时退回到本地锚点推进。
    return anchor.elapsed + (Date.now() - anchor.at) / 1000;
  }
  return task.elapsedSeconds;
}

/** 圆环填充比例、颜色与是否超时 */
function ringState(task: Task): { frac: number; color: string; overdue: boolean } {
  if (task.status === 'aborted') {
    // 已取消：灰色、环静止（不填充）
    return { frac: 0, color: '#8a8f98', overdue: false };
  }
  const elapsed = displayElapsed(task);
  if (task.estimatedSeconds != null && task.estimatedSeconds > 0) {
    const remaining = task.estimatedSeconds - elapsed;
    if (remaining <= 0) {
      // 超时：画满一圈红色并闪烁（frac 必须为 1，否则圆环没有可见弧段，
      // 闪烁动画只是让一段不存在的弧透明度变化，等于没有提示）。
      return { frac: 1, color: '#e5484d', overdue: true };
    }
    const frac = Math.min(1, Math.max(0, remaining / task.estimatedSeconds));
    return { frac, color: colorFor(120 * frac), overdue: false };
  }
  // 正计时：按小时为周期填充一圈，颜色随用时绿→黄→红
  const frac = (elapsed % 3600) / 3600;
  return { frac, color: colorFor(120 * (1 - frac)), overdue: false };
}

/* ------------------------------- i18n ------------------------------- */

function msg(key: MessageKey): string {
  return messages(store?.settings.lang ?? 'system')[key];
}

/* ------------------------------- 渲染 ------------------------------- */

function setRing(frac: number, color: string, overdue: boolean): void {
  const clamped = Math.min(1, Math.max(0, frac));
  for (const circle of [el.ringFg, el.ringFgDisc]) {
    if (!circle) continue;
    circle.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - clamped));
    circle.style.stroke = color;
    circle.classList.toggle('flash', overdue);
  }
}

/** 时间文本同时写卡片环和拖动圆盘（两个环共用同一份计时状态）。 */
function setTime(text: string): void {
  el.time.textContent = text;
  if (el.timeDisc) el.timeDisc.textContent = text;
}

/** 标题文本：已取消的任务把状态并进标题里（卡片已不再显示第二行说明）。 */
function titleText(task: Task): string {
  if (task.status === 'aborted') {
    const reason = task.abortReason?.trim();
    return `✕ ${msg('task.aborted')}${reason ? ` · ${reason}` : ''} · ${task.title}`;
  }
  return task.title;
}

function render(): void {
  const task = viewedTask();
  if (!task) {
    el.title.classList.add('empty');
    el.title.textContent = msg('task.none');
    setTime('--:--');
    setRing(0, colorFor(0), false);
    el.toggle.textContent = '⏸';
    el.toggle.disabled = true;
    el.card.classList.remove('aborted');
    el.toggle.setAttribute('aria-label', msg('task.pause'));
    el.done.disabled = true;
    el.done.setAttribute('aria-label', msg('task.complete'));
    el.prev.disabled = true;
    el.next.disabled = true;
    return;
  }

  el.title.classList.remove('empty');
  el.title.textContent = titleText(task);
  setTime(fmt(displayElapsed(task)));

  const ring = ringState(task);
  setRing(ring.frac, ring.color, ring.overdue);

  const running = task.status === 'running';
  const finished = task.status === 'completed' || task.status === 'aborted';
  el.toggle.textContent = running ? '⏸' : '▶';
  el.toggle.disabled = false;
  // 已完成 / 已取消 的任务不能再标记完成
  el.done.disabled = finished;
  el.card.classList.toggle('aborted', task.status === 'aborted');
  el.toggle.setAttribute('aria-label', running ? msg('task.pause') : msg('task.resume'));
  el.done.setAttribute('aria-label', msg('task.complete'));
  el.prev.disabled = false;
  el.next.disabled = false;
}

/* ------------------------------- 本地计时节拍 ------------------------------- */

function tick(): void {
  const task = viewedTask();
  if (!task || task.status !== 'running') return;
  setTime(fmt(displayElapsed(task)));
  const ring = ringState(task);
  setRing(ring.frac, ring.color, ring.overdue);
}

setInterval(tick, 250);

/* ------------------------------- 视图同步 ------------------------------- */

function syncView(source: StoreFile): void {
  const list = activeTasks(source);
  const running = list.find((t) => t.status === 'running');
  const runningChanged = running ? running.id !== lastRunningId : lastRunningId !== null;
  lastRunningId = running?.id ?? null;
  if (runningChanged) manualNav = false; // 出现新 running 任务 → 恢复跟随

  if (!manualNav && running) {
    viewIdx = list.indexOf(running);
  } else if (!manualNav) {
    // 无 running 任务：自动模式跳过 aborted（取消的任务不算当前活动任务）
    const idx = list.findIndex((t) => t.status !== 'aborted');
    viewIdx = idx >= 0 ? idx : list.length - 1;
  } else if (viewIdx < 0 || viewIdx >= list.length) {
    viewIdx = list.length ? list.length - 1 : 0;
  }

  const task = list[viewIdx];
  if (task && task.status === 'running') {
    // 锚点只用于「没有 startedAt」的降级路径；有 startedAt 时以它为准。
    anchor = { id: task.id, elapsed: task.elapsedSeconds, at: Date.now() };
  }
}

/* ------------------------------- 交互 ------------------------------- */

function mutateUpdate(id: string, patch: Partial<Task>): void {
  void window.dshbar.mutate({ type: 'update', id, patch });
}

el.topline.addEventListener('click', () => {
  void window.dshbar.setCollapsed(false);
});

el.collapse.addEventListener('click', () => {
  void window.dshbar.setCollapsed(true);
});

el.toggle.addEventListener('click', () => {
  const task = viewedTask();
  if (!task) return;
  if (task.status === 'running') {
    mutateUpdate(task.id, { status: 'paused', startedAt: null });
  } else {
    mutateUpdate(task.id, { status: 'running', startedAt: new Date().toISOString() });
  }
});

el.done.addEventListener('click', () => {
  const task = viewedTask();
  if (!task || task.status === 'completed' || task.status === 'aborted') return;
  mutateUpdate(task.id, { status: 'completed', startedAt: null });
});

function navigate(step: number): void {
  manualNav = true;
  viewIdx = viewIdx + step;
  render();
}

el.prev.addEventListener('click', () => navigate(-1));
el.next.addEventListener('click', () => navigate(1));

/* 拖动窗口：自己接管指针，不再用系统原生拖动（`-webkit-app-region: drag`）。
 *
 * 原生拖动时窗口位置由 Windows 的移动循环托管，我们再把它改成 64×64 并居中
 * 到光标，两边互相纠正 → 圆盘在光标两侧左右来回闪。
 * 现在位置只有一个来源：这里 pointerdown 通知主进程「开始跟随光标」，
 * pointerup 通知「结束」，中间每 16ms 由主进程读 screen.getCursorScreenPoint()
 * 重新摆窗口（DIP 单位，不受页面缩放影响）。
 *
 * 按钮上按下不算拖动，否则点 ⏸ / ✓ 也会把悬浮条缩成圆。
 * 还要过一道 4px 位移阈值：只是点一下卡片不该把窗口搬到光标底下。
 */
const DRAG_THRESHOLD_PX = 4;
let dragArmed = false; // 已按下但还没越过阈值
let dragOrigin = { x: 0, y: 0 };

function endDrag(): void {
  dragArmed = false;
  if (!dragging) return;
  dragging = false;
  applyBodyClasses();
  window.dshbar.dragEnd();
}

el.card.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const target = e.target as Element | null;
  if (target && target.closest('button')) return;
  dragArmed = true;
  // 只用来算位移量，不参与窗口定位，所以 CSS 像素足够。
  dragOrigin = { x: e.screenX, y: e.screenY };
  // 指针捕获：窗口缩小并跟着光标跑的过程中仍然收得到 pointermove/up
  //（拖动中窗口被夹在工作区内，光标可能跑到圆盘外面）。
  try {
    el.card.setPointerCapture(e.pointerId);
  } catch {
    /* 捕获失败不影响拖动本体 */
  }
});

el.card.addEventListener('pointermove', (e) => {
  if (!dragArmed || dragging) return;
  if (Math.hypot(e.screenX - dragOrigin.x, e.screenY - dragOrigin.y) < DRAG_THRESHOLD_PX) return;
  dragArmed = false;
  dragging = true;
  applyBodyClasses();
  window.dshbar.dragStart();
});

// 松手监听挂在 window 上：拖动中卡片本身被隐藏（body.dragging .card），
// 挂在卡片上万一捕获被释放就收不到 pointerup 了。
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);
el.card.addEventListener('lostpointercapture', endDrag);

/* ------------------------------- 数据订阅 ------------------------------- */

window.dshbar.onChanged((next) => {
  store = next;
  syncView(next);
  render();
});

window.dshbar.onModeChanged((nextMode) => {
  mode = nextMode;
  applyBodyClasses();
});

window.dshbar.onDockChanged((side) => {
  dock = side;
  applyBodyClasses();
});

window.dshbar.onDragChanged((next) => {
  dragging = next;
  applyBodyClasses();
});

/* ------------------------------- 启动 ------------------------------- */

void (async () => {
  // 先取一次 UI 状态：reveal() 可能在渲染层订阅之前就广播过 dock，
  // 不补这一次初始值，靠下边启动的实例细线会画错边。
  try {
    const ui = await window.dshbar.getUiState();
    dock = ui.dock;
    dragging = ui.dragging;
  } catch {
    /* 主进程未就绪则保持默认 */
  }
  applyBodyClasses();
  store = await window.dshbar.getStore();
  syncView(store);
  render();
})();