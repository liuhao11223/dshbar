# DSHBar · MCP 服务器（BUILD_MCP.md）

本文件记录 `src/mcp/` 的关键设计、工具清单、SDK 用法要点、契约对齐说明与构建验证结果。

---

## 1. 架构总览

DSHBar 的 MCP 服务器由 **DSH 客户端通过 `dshbar-mcp` 命令以 stdio 方式独立启动**，与 Electron 主进程是**两个进程**，二者**仅通过同一个 JSON store 文件共享任务状态**。

```
DSH 客户端 (MCP client)
   │  stdin/stdout JSON-RPC 2.0 (newline-delimited)
   ▼
dshbar-mcp = dist/mcp/cli.js          (本交付)
   │  fs.readFileSync / 原子写(temp+rename)
   ▼
%APPDATA%\DSHBar\store.json           (唯一共享状态)
   ▲
   │  fs.watch(目录) + 150ms 去抖
Electron 主进程 (StoreAdapter.watch) → 广播给悬浮窗/圆环
```

- 进程间不做任何 IPC / UDP 广播；**只有文件共享 + 主进程 watch**。
- MCP 服务器**不主动通知 Electron**；写入保证原子即可。
- Windows 默认 store 路径：`%APPDATA%\DSHBar\store.json`（由 `src/shared/store.ts` 的 `defaultStorePath()` 提供）。

## 2. 与 shell-dev 共享契约的**对齐说明**（重点）

我最初基于任务说明书先行落盘了一份 `src/shared/types.ts` / `store.ts`（含 epoch ms、snake_case、`note`/`reason`/`aborted`、`read()`/`snapshot()`/`mutate(fn→T)` API）。**shell-dev 随后按 lead 规格重写了这两个文件并覆盖了我的版本**。我**未与其重复定义**，而是将 `src/mcp/cli.ts` 全部改为使用 shell-dev 的**新契约**。

### 已采用的新契约
- `TaskStatus = 'pending' | 'running' | 'paused' | 'completed' | 'aborted'`
- `Task { id, title, estimatedSeconds: number|null, elapsedSeconds, status, order, createdAt, startedAt, updatedAt }`（camelCase；时间戳一律 **ISO 字符串**）
- `StoreFile { version:1, tasks: Task[], settings:{lang,hotkey,launchAtLogin} }`
- `TaskAction = {type:'add',task} | {type:'update',id,patch} | {type:'reorder',ids} | {type:'remove',id} | {type:'reset',store}`
- `StoreAdapter`：`load()` / `mutate(fn)`（fn 返回 TaskAction 或 void，返回新副本）/ `write()` / `watch(cb)` / `createEmptyStore()` / `defaultStorePath()` / `tickRunning(store, nowSec, lastTickSec)`

### mcp-dev 追加的**向后兼容**字段（请 shell-dev / 主进程对齐）
按 lead 指令，我在 `src/shared/types.ts` 的 `Task` 上**追加了两个可选字段**、并给 `TaskStatus` 增加了一个枚举值（均为可选/追加，不影响现有代码）：

```ts
export type TaskStatus = 'pending' | 'running' | 'paused' | 'completed' | 'aborted';  // 新增 'aborted'
export interface Task {
  // ...（原有字段不变）
  /** 完成时备注（MCP dshbar_finish_work 写入；可选，向后兼容） */
  note?: string;
  /** 取消原因（MCP dshbar_abort_work 写入；可选，向后兼容） */
  abortReason?: string;
}
```

`dshbar_abort_work` 把 `reason` 写入 `Task.abortReason`；`dshbar_finish_work` 把 `note` 写入 `Task.note`。主进程若无需渲染这两个字段可直接忽略；若需展示，读取这两个可选字段即可。

### 契约对齐时做的关键映射
| MCP 工具参数（JSON，snake_case） | store 字段 |
|---|---|
| `estimated_seconds`（可选 int；`null`=正计时） | `estimatedSeconds: number|null` |
| `task_id` | `Task.id` |
| `note` / `reason` | `Task.note` / `Task.abortReason`（新追加） |

### 计时语义（对齐后）
- `elapsedSeconds` 为累计已投入秒数；`startedAt`（ISO）为当前运行段起点，非 running 时为 `null`。
- 主进程用 `tickRunning()` 每秒把 running 段并入 `elapsedSeconds`。
- **MCP 侧**为自洽起见，凡要把任务移出 running（pause / finish / abort），都用 `elapsedSeconds = elapsedSeconds + (now - startedAt)` **先折叠进行中段**再改状态（`src/mcp/cli.ts` 的 `foldRunning()` / `currentSeconds()`）。这样即使主进程没在跑 ticker，时长也不丢。
- 给 AI 的返回里，`remaining_seconds` 在 `estimatedSeconds != null` 且未完成时为 `max(0, estimatedSeconds - elapsed_seconds)`，否则 `null`（正计时）。

## 3. 工具清单（11 个，统一前缀 `dshbar_`）

全部返回 **JSON 字符串**（含 `tasks` 快照或单条 `task`），便于 AI 直接展示。失败返回 `{ok:false,error}` 且 `isError:true`。

| # | 工具 | 参数 schema（zod） | 语义 |
|---|---|---|---|
| 1 | `dshbar_start_work` | `{ title(≥1), estimated_seconds?:int>0 }` | 新建 running 任务并计时；**自动暂停其他 running 任务** |
| 2 | `dshbar_pause_work` | `{ task_id(≥1) }` | 暂停计时（保留已累计时长） |
| 3 | `dshbar_resume_work` | `{ task_id(≥1) }` | 继续计时（pending 也直接跑）；其他 running 自动暂停 |
| 4 | `dshbar_finish_work` | `{ task_id(≥1), note?:string }` | 标记完成；running 先停表；note 存入 `Task.note` |
| 5 | `dshbar_abort_work` | `{ task_id(≥1), reason?:string }` | 取消（不标记完成）；reason 存入 `Task.abortReason`；任务保留(status=aborted) |
| 6 | `dshbar_add_tasks` | `{ tasks:[{title(≥1), estimated_seconds?}]（min 1） }` | 批量加 pending 待办，**不自动计时** |
| 7 | `dshbar_list_tasks` | `{ status?:'all'\|pending\|running\|paused\|completed\|aborted', limit?:int>0 }` | 查询，默认 status=all、limit=50，按 `createdAt` 倒序取最近 |
| 8 | `dshbar_update_task` | `{ task_id(≥1), title?:string, estimated_seconds?:int>0\|null }` | 改标题/预计时长；`estimated_seconds:null` 改为正计时 |
| 9 | `dshbar_reorder_tasks` | `{ task_ids:[string]（min 1） }` | 按给定顺序重排（写 `order` 0..n-1） |
| 10 | `dshbar_delete_task` | `{ task_id(≥1) }` | 删除任务 |
| 11 | `dshbar_get_status` | `{}` | 统计：总数、各状态数量、当前 running、最近完成 5 条 |

服务器信息：`name: dshbar`，`version: 0.1.0`。

## 4. SDK 用法要点（重要 · 已踩坑）

### ⚠️ 不要用 `McpServer.registerTool`
在 **`@modelcontextprotocol/sdk@1.32.2` + `zod@3.25.76`** 组合下，`McpServer.registerTool` 的类型推断会触发：

```
error TS2589: Type instantiation is excessively deep and possibly infinite.
```

实测数据（单文件 `--noEmit` 计时）：
- 仅 `new McpServer` + `connect()`：**0.7s**，无错。
- `registerTool("a", { inputSchema: { title: z.string().min(1) } }, cb)`（1 个工具，raw shape）：**21.2s**，TS2589。
- `registerTool(..., { inputSchema: z.object({...}) })`（1 个工具，ZodObject）：**25.8s**，TS2589。
- 因此整包 `tsc -p tsconfig.json` 会 **OOM（Node 堆 ~3.9GB，FATAL ERROR: JavaScript heap out of memory）**，约 317s 后崩溃，导致 `dist` 产不出、`npm run build` 无法通过。

### ✅ 改用底层 `Server` + 自持 zod 校验
```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const server = new Server({ name: 'dshbar', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [/* name,title,description,inputSchema */] }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const spec = toolMap.get(req.params.name);
  const parsed = spec.schema.safeParse(req.params.arguments ?? {});
  // ...执行 -> textPayload(...)
});
```
- 实测：含 11 个工具的完整实现，单文件 `--noEmit` **<1s**；整包 `tsc -p tsconfig.json` **1.4s / 0 错误**。
- 参数 schema 仍用 **zod**（满足"zod 做参数 schema"的要求），必填项统一 `.min(1)`。
- `tools/list` 的 `inputSchema` 是手写的精简 JSON Schema（不引入 `zod-to-json-schema`，避免新增依赖/转译成本）。
- 工具回调返回 `{ content: [{ type: 'text', text }], isError? }`（CallToolResult 形状），JSON 序列化后的字符串放入 `text`。
- `package.json` 依赖段**未改动**。

## 5. 并发与序列化

- **进程内串行**：`serial()` promise 队列保证同一进程内工具回调严格顺序执行，避免同进程并发写。
- **跨进程安全**：完全依赖 `StoreAdapter.mutate()` 的"每次写前重读盘 + 深拷贝 + 原子写(temp+rename)"。
- **感知 Electron 修改**：read-only 工具（`dshbar_list_tasks` / `dshbar_get_status`）在每次调用开始前 `adapter.load()` 一次；写工具由 `mutate()` 自身先重读。
- 不添加任何 UDP/IPC 广播（按 lead 要求保持简单）。

## 6. 启动、退出与配置

- 启动：`node dist/mcp/cli.js [storePath]`；`argv[2]` 可覆盖 store 路径，缺省用 `defaultStorePath()`。
- 优雅退出：`transport.onclose`、`stdin 'end'`、`SIGTERM` / `SIGINT` 均会走退出流程，最终 `exit(0)`（兜底 2s 强制退出）。
  - **坑**：`transport.onclose` 里如果直接 `server.close()`，会形成 `server.close() → transport.close() → onclose → server.close()…` 无限递归，触发 `RangeError: Maximum call stack size exceeded` 并在 stderr 刷屏。已用 `exiting` 标志修复：`onclose` 只负责 `exitNow(0)`，信号/`stdin end` 才走 `shutdown()`。实测退出时 stderr 只打印 `ready` 与 `shutting down (stdin end)` 两行。
- 启动时打印 `[dshbar-mcp] dshbar v0.1.0 ready (store=<path>)` 到 stderr，便于排查。
- 提示词与接入文档：
  - `src/mcp/prompt.md` —— 可直接粘贴给 AI 客户端的「DSHBar 任务记录规则」（只记有跟踪价值的任务、执行前 start、完成/失败/取消时 finish/abort、未连接时静默跳过、回复中不主动提及）。
  - `src/mcp/install.md` —— DSH 客户端 MCP 配置片段（`command: dshbar-mcp`，`type: stdio`，`args: []`），含验证与故障排查。

## 7. 构建与验证

### 7.1 类型编译
```
node node_modules/typescript/bin/tsc -p tsconfig.json --pretty false
# SECONDS=1.38  EXIT=0  （无错误，产出 dist/）
```
> 注意：必须用 `node node_modules/typescript/bin/tsc` 直跑（或 `npx tsc`）；不要加 `NODE_OPTIONS=--max-old-space-size` —— 那只是掩盖 SD K类型爆炸的根因（试过 8GB，仍 OOM，因为根因是 TS2589 无限实例化，不是堆太小）。

### 7.2 冒烟测试 `scripts/mcp-smoke.mjs`
无第三方依赖的 Node 脚本，用 `child_process.spawn` 启动 `node dist/mcp/cli.js <tmp store>`，按 MCP stdio 协议发送 JSON-RPC，覆盖 `initialize` → `notifications/initialized` → `tools/list` → `tools/call`（`dshbar_start_work` / `dshbar_list_tasks` / `dshbar_finish_work` / `dshbar_get_status`），最后关 stdin 断言退出码 0。

运行：`node scripts/mcp-smoke.mjs`

**结果：SMOKE OK（全部 PASS）**
```
PASS  initialize returns serverInfo
PASS  tools/list exposes all 11 tools
PASS  dshbar_start_work returns a running task
PASS  dshbar_list_tasks returns snapshot including the running task
PASS  dshbar_finish_work marks task completed with note
PASS  dshbar_get_status reports counts and recent completed
PASS  process exits cleanly with code 0
```
断言要点：`serverInfo.name==='dshbar'`、`version==='0.1.0'`；11 个工具名齐全；start 后 `task.status==='running'`；finish 后 `status==='completed'` 且 `note==='smoke ok'`；`get_status.counts.completed===1` 且 `recent_completed.length===1`；进程退出码 0。

## 8. 未打包 / 未运行 Electron / 未改依赖
按要求：不打包 exe、不运行 Electron、未修改 `package.json` 依赖段、未运行 `npm install`（依赖已存在：SDK 1.32.2、zod 3.25.76）。

## 9. 待 shell-dev / lead 确认
1. `Task.note?` / `Task.abortReason?` 两个可选字段与 `TaskStatus` 的 `'aborted'` 已加到 `src/shared/types.ts`，请主进程侧确认是否接受（不接受可改回，仅需同步改 `src/mcp/cli.ts` 两处写入点）。
2. `estimated_seconds`（MCP 参数，snake_case）↔ `estimatedSeconds`（store，camelCase）的映射只在 MCP 边界，store 内部字段名与主进程保持一致。
