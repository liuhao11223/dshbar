#!/usr/bin/env node
/**
 * DSHBar MCP 服务器（stdio）—— 由 DSH 客户端通过 `dshbar-mcp` 命令独立启动。
 *
 * 架构要点（详见 BUILD_MCP.md）：
 * - 与 Electron 主进程是两个进程，仅通过 src/shared/store.ts 的同一个 JSON store 文件共享状态；
 * - 所有工具在进程内串行执行（serial 队列），避免同进程并发写；跨进程并发由原子写 + 写前重读保证
 *   （store.ts 的 mutate() 每次写前都重读盘，read-only 工具也会先 load() 一次）；
 * - 工具统一前缀 dshbar_，全部返回 JSON 字符串（含 tasks 快照或单条 task），便于 AI 展示。
 *
 * 为何用底层 Server 而非 McpServer.registerTool：
 *   在 SDK 1.32.2 + zod 3.25 组合下，McpServer.registerTool 的类型推断会触发
 *   TS2589 "Type instantiation is excessively deep and possibly infinite"，并导致
 *   `tsc -p tsconfig.json` 直接 OOM（~3.9GB）。改用底层 Server + setRequestHandler
 *   （ListToolsRequestSchema / CallToolRequestSchema）+ 自持 zod 校验，编译 <1s 且类型安全。
 *
 * 启动：node dist/mcp/cli.js [storePath]
 *   不传 storePath 时使用 store.ts 的 defaultStorePath()（Windows 下 %APPDATA%/DSHBar/store.json）。
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { StoreFile, Task, TaskStatus } from '../shared/types';
import { StoreAdapter, defaultStorePath } from '../shared/store';

// 版本号单一来源：package.json。打包时 build-mcp-bundle.cjs 会把它拷进
// <resources>\dshbar-mcp\package.json，运行时按候选路径读取；读不到就退回
// '0.0.0'（只影响横幅显示，不影响协议）。
function readVersion(): string {
  const candidates = [
    path.join(__dirname, '..', '..', 'package.json'), // 开发：dist/mcp -> 项目根
    path.join(__dirname, '..', '..', '..', 'package.json'), // 打包：resources/dshbar-mcp/dist/mcp -> 其根
  ];
  for (const p of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf-8')) as { version?: string };
      if (typeof j.version === 'string' && j.version.length > 0) return j.version;
    } catch {
      /* 试下一个 */
    }
  }
  return '0.0.0';
}
const VERSION = readVersion();

// ---------------------------------------------------------------------------
// Store 适配器（进程唯一实例）
// ---------------------------------------------------------------------------
const storePath =
  process.argv[2] && process.argv[2].length > 0 ? process.argv[2] : defaultStorePath();
const adapter = new StoreAdapter(storePath);

// ---------------------------------------------------------------------------
// 进程内串行执行队列：保证工具回调按顺序执行，避免同进程并发读写
// ---------------------------------------------------------------------------
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = chain.then(() => fn());
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ---------------------------------------------------------------------------
// 时间与计时辅助（store 内时间一律为 ISO 字符串）
// ---------------------------------------------------------------------------
const nowIso = () => new Date().toISOString();
const nowMs = () => Date.now();
const round2 = (n: number) => Math.round(n * 100) / 100;

/** 把 running 段的时长并入 elapsedSeconds，并清空 startedAt（不修改状态）。 */
function foldRunning(task: Task, tsMs: number): void {
  if (task.startedAt) {
    const started = Date.parse(task.startedAt);
    if (!Number.isNaN(started)) {
      const delta = (tsMs - started) / 1000;
      if (delta > 0) task.elapsedSeconds = round2(task.elapsedSeconds + delta);
    }
  }
  task.startedAt = null;
}

/**
 * 任务当前已记录的秒数（running 会加上进行中段）。
 *
 * 与 GUI 的「段折叠」模型一致：
 *   此刻已投入 = elapsedSeconds（已结束的段） + (now - startedAt)（进行中的段）
 */
function currentSeconds(task: Task, tsMs: number): number {
  let s = task.elapsedSeconds;
  if (task.status === 'running' && task.startedAt) {
    const started = Date.parse(task.startedAt);
    if (!Number.isNaN(started)) s += Math.max(0, (tsMs - started) / 1000);
  }
  return round2(s);
}

/**
 * 结束一个 running 任务的计时段：把当前段折进 elapsedSeconds，并清空 startedAt。
 *
 * 这是「暂停 / 完成 / 取消」时必须做的动作——不折的话，GUI 侧每秒落盘的
 * elapsedSeconds 与本进程按 `now - startedAt` 推算出来的秒数会互相叠加，
 * 同一个任务被重复计时。
 */
function stopSegment(task: Task, tsMs: number): Partial<Task> {
  const patch: Partial<Task> = { startedAt: null };
  if (task.status === 'running') {
    const secs = currentSeconds(task, tsMs);
    if (secs !== task.elapsedSeconds) patch.elapsedSeconds = secs;
  }
  return patch;
}

/** 下一个 order 值（按现有最大值递增，主进程与 MCP 都走这条单调线）。 */
function nextOrder(store: StoreFile): number {
  let max = -1;
  for (const t of store.tasks) if (t.order > max) max = t.order;
  return max + 1;
}

function findTask(store: StoreFile, id: string): Task | undefined {
  return store.tasks.find((t) => t.id === id);
}

/** 把 store 内的任务转换成给 AI 的 snake_case JSON 对象。 */
function toPublic(task: Task, tsMs: number): Record<string, unknown> {
  const seconds = currentSeconds(task, tsMs);
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    estimated_seconds: task.estimatedSeconds,
    note: task.note,
    reason: task.abortReason,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    started_at: task.startedAt,
    elapsed_seconds: seconds,
    remaining_seconds:
      task.estimatedSeconds != null && task.status !== 'completed'
        ? round2(Math.max(0, task.estimatedSeconds - seconds))
        : null,
    order: task.order,
  };
}

/** 暂停 store 中所有 running 任务（把进行中段并入 elapsedSeconds）。每次 mutate 一个。 */
function pauseOthersRunning(excludeId?: string): void {
  const ts = nowMs();
  const snapshot = adapter.load();
  for (const t of snapshot.tasks) {
    if (t.status !== 'running' || t.id === excludeId) continue;
    adapter.mutate((d) => {
      const task = findTask(d, t.id);
      if (!task) return { type: 'update', id: t.id, patch: {} };
      return { type: 'update', id: t.id, patch: { status: 'paused', ...stopSegment(task, ts) } };
    });
  }
}

// ---------------------------------------------------------------------------
// 工具返回（全部为 JSON 字符串，便于 AI 直接展示）
// ---------------------------------------------------------------------------
type Json = Record<string, unknown> | unknown[];
function textPayload(payload: Json, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// zod 参数 schema（必填项统一 .min(1)）
// ---------------------------------------------------------------------------
const titleSchema = z.string().min(1);
const taskIdSchema = z.string().min(1);
const intPositive = z.number().int().positive();

const StartWorkSchema = z.object({
  title: titleSchema,
  estimated_seconds: intPositive.optional(),
});
const PauseWorkSchema = z.object({ task_id: taskIdSchema });
const ResumeWorkSchema = z.object({ task_id: taskIdSchema });
const FinishWorkSchema = z.object({
  task_id: taskIdSchema,
  note: z.string().min(1).optional(),
});
const AbortWorkSchema = z.object({
  task_id: taskIdSchema,
  reason: z.string().min(1).optional(),
});
const AddTasksSchema = z.object({
  tasks: z.array(z.object({ title: titleSchema, estimated_seconds: intPositive.optional() })).min(1),
});
const ListTasksSchema = z.object({
  status: z.enum(['all', 'pending', 'running', 'paused', 'completed', 'aborted']).optional(),
  limit: z.number().int().positive().optional(),
});
const UpdateTaskSchema = z.object({
  task_id: taskIdSchema,
  title: titleSchema.optional(),
  estimated_seconds: intPositive.nullable().optional(),
});
const ReorderTasksSchema = z.object({ task_ids: z.array(taskIdSchema).min(1) });
const DeleteTaskSchema = z.object({ task_id: taskIdSchema });
const GetStatusSchema = z.object({});

// ---------------------------------------------------------------------------
// 工具注册表（低层 Server + 自持 zod 校验）
// ---------------------------------------------------------------------------
interface ToolSpec {
  name: string;
  title: string;
  description: string;
  schema: z.ZodTypeAny;
  inputJsonSchema: Record<string, unknown>;
  run: (args: unknown) => Json;
}

const tools: ToolSpec[] = [
  {
    name: 'dshbar_start_work',
    title: '开始任务计时',
    description:
      '创建一个状态为 running 的新任务并立即开始计时；若传入 estimated_seconds 则为倒计时，否则为正计时。会自动暂停其他正在运行的任务。返回新建任务。',
    schema: StartWorkSchema,
    inputJsonSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1 },
        estimated_seconds: { type: 'integer', minimum: 1 },
      },
      required: ['title'],
    },
    run: (raw) => {
      const args = raw as z.infer<typeof StartWorkSchema>;
      let newId = '';
      adapter.mutate((draft) => {
        const task: Task = {
          id: randomUUID(),
          title: args.title,
          estimatedSeconds: args.estimated_seconds ?? null,
          elapsedSeconds: 0,
          status: 'running',
          order: nextOrder(draft),
          createdAt: nowIso(),
          startedAt: nowIso(),
          updatedAt: nowIso(),
        };
        newId = task.id;
        return { type: 'add', task };
      });
      pauseOthersRunning(newId); // 自动暂停其他 running 任务
      const fresh = adapter.load();
      const task = findTask(fresh, newId);
      return { ok: true, task: task ? toPublic(task, nowMs()) : null };
    },
  },
  {
    name: 'dshbar_pause_work',
    title: '暂停任务计时',
    description: '暂停指定任务的计时（停止计时，保留已累计时长）。返回该任务。',
    schema: PauseWorkSchema,
    inputJsonSchema: {
      type: 'object',
      properties: { task_id: { type: 'string', minLength: 1 } },
      required: ['task_id'],
    },
    run: (raw) => {
      const { task_id } = raw as z.infer<typeof PauseWorkSchema>;
      const ts = nowMs();
      const store = adapter.mutate((draft) => {
        const task = findTask(draft, task_id);
        if (!task) throw new Error(`task not found: ${task_id}`);
        if (task.status === 'running') {
          const patch: Partial<Task> = { status: 'paused', ...stopSegment(task, ts) };
          return { type: 'update', id: task_id, patch };
        }
        return { type: 'update', id: task_id, patch: {} };
      });
      const task = findTask(store, task_id);
      return { ok: true, task: task ? toPublic(task, ts) : null };
    },
  },
  {
    name: 'dshbar_resume_work',
    title: '继续任务计时',
    description:
      '继续计时指定任务（pending 也会直接开始跑），其他运行中任务自动暂停。返回该任务。',
    schema: ResumeWorkSchema,
    inputJsonSchema: {
      type: 'object',
      properties: { task_id: { type: 'string', minLength: 1 } },
      required: ['task_id'],
    },
    run: (raw) => {
      const { task_id } = raw as z.infer<typeof ResumeWorkSchema>;
      const tsMs = nowMs();
      const ts = new Date(tsMs).toISOString();
      const store = adapter.mutate((draft) => {
        const task = findTask(draft, task_id);
        if (!task) throw new Error(`task not found: ${task_id}`);
        if (task.status === 'completed' || task.status === 'aborted') {
          throw new Error(`cannot resume a ${task.status} task: ${task_id}`);
        }
        // 若本来就在跑，先把当前段折进去，再开新段——否则「已跑过的秒数」
        // 会在新段里被重复计入。
        const patch: Partial<Task> = { status: 'running' };
        if (task.status === 'running') {
          const secs = currentSeconds(task, tsMs);
          if (secs !== task.elapsedSeconds) patch.elapsedSeconds = secs;
        }
        patch.startedAt = ts;
        return { type: 'update', id: task_id, patch };
      });
      pauseOthersRunning(task_id); // 其他 running 任务自动暂停
      const fresh = adapter.load();
      const task = findTask(fresh, task_id);
      return { ok: true, task: task ? toPublic(task, nowMs()) : null };
    },
  },
  {
    name: 'dshbar_finish_work',
    title: '完成任务',
    description:
      '把任务标记为完成；若任务正在运行先停止计时。可选 note 存入任务备注。返回该任务。',
    schema: FinishWorkSchema,
    inputJsonSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', minLength: 1 },
        note: { type: 'string', minLength: 1 },
      },
      required: ['task_id'],
    },
    run: (raw) => {
      const { task_id, note } = raw as z.infer<typeof FinishWorkSchema>;
      const ts = nowMs();
      const store = adapter.mutate((draft) => {
        const task = findTask(draft, task_id);
        if (!task) throw new Error(`task not found: ${task_id}`);
        const patch: Partial<Task> = { status: 'completed', updatedAt: nowIso() };
        if (task.status === 'running') {
          Object.assign(patch, stopSegment(task, ts));
        }
        if (typeof note === 'string') patch.note = note;
        return { type: 'update', id: task_id, patch };
      });
      const task = findTask(store, task_id);
      return { ok: true, task: task ? toPublic(task, ts) : null };
    },
  },
  {
    name: 'dshbar_abort_work',
    title: '取消任务',
    description:
      '取消任务（不标记完成），停止计时并记录 reason。任务保留在列表中（status=aborted），可从 dshbar_list_tasks 查看。返回该任务。',
    schema: AbortWorkSchema,
    inputJsonSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', minLength: 1 },
        reason: { type: 'string', minLength: 1 },
      },
      required: ['task_id'],
    },
    run: (raw) => {
      const { task_id, reason } = raw as z.infer<typeof AbortWorkSchema>;
      const ts = nowMs();
      const store = adapter.mutate((draft) => {
        const task = findTask(draft, task_id);
        if (!task) throw new Error(`task not found: ${task_id}`);
        const patch: Partial<Task> = { status: 'aborted', updatedAt: nowIso() };
        if (task.status === 'running') {
          Object.assign(patch, stopSegment(task, ts));
        }
        if (typeof reason === 'string') patch.abortReason = reason;
        return { type: 'update', id: task_id, patch };
      });
      const task = findTask(store, task_id);
      return { ok: true, task: task ? toPublic(task, ts) : null };
    },
  },
  {
    name: 'dshbar_add_tasks',
    title: '批量添加待办任务',
    description:
      '批量添加状态为 pending 的待办任务（不自动开始计时），后续可用 dshbar_resume_work 或 dshbar_start_work 启动。返回新增任务列表。',
    schema: AddTasksSchema,
    inputJsonSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', minLength: 1 },
              estimated_seconds: { type: 'integer', minimum: 1 },
            },
            required: ['title'],
          },
        },
      },
      required: ['tasks'],
    },
    run: (raw) => {
      const { tasks: items } = raw as z.infer<typeof AddTasksSchema>;
      const createdIds: string[] = [];
      adapter.mutate((draft) => {
        const ts = nowIso();
        for (const item of items) {
          const task: Task = {
            id: randomUUID(),
            title: item.title,
            estimatedSeconds: item.estimated_seconds ?? null,
            elapsedSeconds: 0,
            status: 'pending',
            order: nextOrder(draft),
            createdAt: ts,
            startedAt: null,
            updatedAt: ts,
          };
          createdIds.push(task.id);
          draft.tasks.push(task);
        }
      });
      const store = adapter.load();
      const ts = nowMs();
      const created = createdIds
        .map((id) => findTask(store, id))
        .filter((t): t is Task => Boolean(t))
        .map((t) => toPublic(t, ts));
      return { ok: true, tasks: created };
    },
  },
  {
    name: 'dshbar_list_tasks',
    title: '查询任务列表',
    description:
      '按状态查询任务，默认 status=all 且按创建时间倒序返回最近的 limit（默认 50）条。用于判断当前在做什么、是否需要记录。',
    schema: ListTasksSchema,
    inputJsonSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['all', 'pending', 'running', 'paused', 'completed', 'aborted'] },
        limit: { type: 'integer', minimum: 1 },
      },
    },
    run: (raw) => {
      const args = raw as z.infer<typeof ListTasksSchema>;
      const ts = nowMs();
      const store = adapter.load(); // 每次工具调用开始前重读，感知 Electron 的修改
      const status = args.status ?? 'all';
      const limit = args.limit ?? 50;
      let tasks = status === 'all' ? store.tasks : store.tasks.filter((t) => t.status === status);
      tasks = [...tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
      return { ok: true, status, limit, tasks: tasks.map((t) => toPublic(t, ts)) };
    },
  },
  {
    name: 'dshbar_update_task',
    title: '修改任务',
    description: '修改任务标题或预计时长。estimated_seconds 传 null 可把倒计时改成正计时。返回该任务。',
    schema: UpdateTaskSchema,
    inputJsonSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', minLength: 1 },
        title: { type: 'string', minLength: 1 },
        estimated_seconds: { type: ['integer', 'null'], minimum: 1 },
      },
      required: ['task_id'],
    },
    run: (raw) => {
      const args = raw as z.infer<typeof UpdateTaskSchema>;
      const ts = nowMs();
      const store = adapter.mutate((draft) => {
        const task = findTask(draft, args.task_id);
        if (!task) throw new Error(`task not found: ${args.task_id}`);
        const patch: Partial<Task> = { updatedAt: nowIso() };
        if (typeof args.title === 'string') patch.title = args.title;
        if (args.estimated_seconds !== undefined) patch.estimatedSeconds = args.estimated_seconds ?? null;
        return { type: 'update', id: args.task_id, patch };
      });
      const task = findTask(store, args.task_id);
      return { ok: true, task: task ? toPublic(task, ts) : null };
    },
  },
  {
    name: 'dshbar_reorder_tasks',
    title: '重排任务',
    description:
      '按给定顺序重排任务（传入完整的新顺序 task_ids），只影响仍显示在列表中的任务。返回任务快照。',
    schema: ReorderTasksSchema,
    inputJsonSchema: {
      type: 'object',
      properties: {
        task_ids: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
      },
      required: ['task_ids'],
    },
    run: (raw) => {
      const { task_ids } = raw as z.infer<typeof ReorderTasksSchema>;
      const ts = nowMs();
      const store = adapter.mutate((draft) => ({ type: 'reorder', ids: task_ids }));
      return { ok: true, tasks: store.tasks.map((t) => toPublic(t, ts)) };
    },
  },
  {
    name: 'dshbar_delete_task',
    title: '删除任务',
    description: '删除指定任务（从 store 中移除）。返回被删除任务的 id。',
    schema: DeleteTaskSchema,
    inputJsonSchema: {
      type: 'object',
      properties: { task_id: { type: 'string', minLength: 1 } },
      required: ['task_id'],
    },
    run: (raw) => {
      const { task_id } = raw as z.infer<typeof DeleteTaskSchema>;
      adapter.mutate((draft) => {
        if (!draft.tasks.some((t) => t.id === task_id)) {
          throw new Error(`task not found: ${task_id}`);
        }
        return { type: 'remove', id: task_id };
      });
      return { ok: true, deleted_id: task_id };
    },
  },
  {
    name: 'dshbar_get_status',
    title: '获取任务统计',
    description:
      '返回统计：任务总数、各状态数量、当前运行中的任务、最近完成的 5 条。供判断是否需要记录。',
    schema: GetStatusSchema,
    inputJsonSchema: { type: 'object' },
    run: () => {
      const ts = nowMs();
      const store = adapter.load();
      const counts: Record<TaskStatus, number> = {
        pending: 0,
        running: 0,
        paused: 0,
        completed: 0,
        aborted: 0,
      };
      for (const t of store.tasks) counts[t.status] += 1;
      const running = store.tasks.filter((t) => t.status === 'running').map((t) => toPublic(t, ts));
      const recentCompleted = store.tasks
        .filter((t) => t.status === 'completed')
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 5)
        .map((t) => toPublic(t, ts));
      return {
        ok: true,
        total: store.tasks.length,
        counts,
        running,
        recent_completed: recentCompleted,
      };
    },
  },
];

const toolMap = new Map(tools.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------
// 底层 Server：手动处理 tools/list 与 tools/call（避免 McpServer 的类型爆炸）
// ---------------------------------------------------------------------------
const server = new Server({ name: 'dshbar', version: VERSION }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: { type: 'object', properties: t.inputJsonSchema.properties ?? {}, required: t.inputJsonSchema.required ?? [] },
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const spec = toolMap.get(req.params.name);
  if (!spec) {
    return textPayload({ ok: false, error: `unknown tool: ${req.params.name}` }, true);
  }
  const parsed = spec.schema.safeParse(req.params.arguments ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    return textPayload({ ok: false, error: `invalid arguments for ${spec.name}: ${detail}` }, true);
  }
  try {
    const payload = await serial(() => spec.run(parsed.data));
    return textPayload(payload as Json);
  } catch (err) {
    return textPayload(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      true,
    );
  }
});

// ---------------------------------------------------------------------------
// 启动 & 优雅退出
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();

// 优雅退出：用 exiting 标志防止 server.close() → transport.close() → onclose 的循环递归
//（否则会触发 RangeError: Maximum call stack size exceeded 并在 stderr 刷屏）。
let exiting = false;
function exitNow(code: number): void {
  if (exiting) return;
  exiting = true;
  process.exit(code);
}

transport.onclose = () => exitNow(0);

function shutdown(reason: string): void {
  if (exiting) return;
  exiting = true;
  process.stderr.write(`[dshbar-mcp] shutting down (${reason})\n`);
  void server
    .close()
    .then(() => process.exit(0))
    .catch(() => process.exit(0));
  // 兜底：2s 内未退出则强制退出
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.stdin.on('end', () => shutdown('stdin end'));
process.stdin.on('error', () => shutdown('stdin error'));

async function main(): Promise<void> {
  await server.connect(transport);
  adapter.load(); // 触发一次读，确保 store 语义正确（缺失文件时会立即落盘一份空 store）
  process.stderr.write(`[dshbar-mcp] dshbar v${VERSION} ready (store=${storePath})\n`);
}

main().catch((err) => {
  process.stderr.write(
    `[dshbar-mcp] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
