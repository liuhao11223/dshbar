# DSHBar · Electron 壳层 + 渲染界面（shell-dev）

负责人：shell-dev。范围：src/main、src/preload、src/renderer，以及共享层
`src/shared/types.ts` / `src/shared/store.ts` / `src/shared/i18n.ts`。

## 交付文件

| 文件 | 说明 |
| --- | --- |
| `src/shared/types.ts` | 共享类型（Task / TaskStatus / Settings / StoreFile / TaskAction / WindowMode / DshbarApi），**单一事实来源** |
| `src/shared/store.ts` | 进程无关 JSON 存储适配器 `StoreAdapter` + `defaultStorePath()` + `tickRunning()` |
| `src/shared/i18n.ts` | 中/英文案字典 + `resolveLang` / `messages` / `t` |
| `src/main/main.ts` | 主进程：窗口、托盘、全局快捷键、开机自启、IPC、计时节拍、MCP 检测、崩溃兜底 |
| `src/preload/preload.ts` | `contextBridge` 暴露 `window.dshbar` |
| `src/preload/index.d.ts` | （未创建，类型声明放在 `src/renderer/global.d.ts`） |
| `src/renderer/global.d.ts` | `Window.dshbar` 全局类型声明 |
| `src/renderer/index.html` | 渲染层入口（细线 + 任务卡） |
| `src/renderer/renderer.css` | 内联样式，透明背景，`prefers-color-scheme` 深/浅跟随 |
| `src/renderer/renderer.ts` | 渲染层逻辑（纯 TS + DOM，无框架） |
| `scripts/copy-renderer-assets.mjs` | tsc 不复制非 TS 文件，用于把 html/css 复制到 dist/renderer |

## 关键设计决策

### 1. 窗口
- `frameless + transparent + alwaysOnTop('screen-saver') + skipTaskbar + resizable:false + hasShadow:false`，
  `webPreferences: { preload: dist/preload/preload.js, contextIsolation: true, nodeIntegration: false, sandbox: false }`。
- 尺寸 360×42；收起态 360×6（只留顶部 6px 细线）。
- 定位到**主显示器 workArea 顶部居中**（x 居中，y = workArea.y）；展开向下生长，不遮挡任务栏。
- **吸附边（v0.1.6）**：`computeDockSide()` 按窗口与 workArea 的 2px 容差判定 `top` / `bottom` / `free`，
  靠下边时 `applyBounds()` 让底边不动、向上生长，渲染层用 `body.dock-bottom` 把 6px 细线画到窗口底部。
- **拖动圆盘（v0.1.6）**：`will-move` → `setDragging(true)`，窗口收成 `DRAG_SIZE = 64` 的正方并居中到光标；
  `moved` 期间每帧重新居中，250ms 无位移视为松手 → 恢复 360×宽、按光标落位并重算吸附边。
  渲染层用 `body.dragging` 隐藏细线与卡片、显示 `#disc`（圆形时间环 + 时间）。
- 默认开机为**收起态**（若已有未完成任务则展开，`hasOpenTask()`）。双击托盘 / `Alt+W` / 单击细线 切换形态。

### 2. 圆环与计时
- SVG 圆环半径 24，周长 ≈ 150.796（CSS `stroke-dasharray` 同步）。环心文本显示 `MM:SS` / `H:MM:SS`。
- 倒计时：剩余比例填环，颜色随剩余比例绿→红；超时红色闪烁（`.flash`）。
- 正计时：按小时为周期填满一圈，颜色随用时绿→黄→红。
- 主进程每秒 tick 一次：用 `tickRunning()` 在内存累计 running 任务的 `elapsedSeconds` 并广播
  `store:changed`（渲染层**不做后端轮询**）；渲染层用 `setInterval` 在两次推送之间本地推进显示。
- 为防崩溃丢秒，主进程每秒原子落盘；`before-quit` 再写一次。

### 3. 持久化（StoreAdapter）
- `load()`：不存在返回空 store 并落盘；解析失败把损坏文件改名为 `store.json.bak` 并重建。
- `mutate(fn)`：读盘最新 → 深拷贝 → 应用 `TaskAction` → 原子写（`.tmp` + `renameSync`）→ 返回新副本。
  `add` 按 `order` 升序插入；`update` 只改给定字段并刷新 `updatedAt`；`reorder` 按 ids 重排 order；
  `remove` 过滤；`reset` 整份替换。
- `watch(onChange)`：**watch store 所在目录**（因原子写 rename 会让单文件 watch 失效）+ 文件名过滤 +
  150ms 去抖 + 事件后重新 attach。未引入 chokidar。
- `defaultStorePath()`：`%APPDATA%/DSHBar/store.json`（APPDATA 缺失时回退 `os.homedir()`）。
- `tickRunning(store, nowSec, lastTickSec)`：纯函数，累加 running 任务秒数；外部进程改写后重置基准避免大跳。

### 4. 托盘
- 图标：打包后读 `process.resourcesPath/tray.ico`（对应 pack-dev 的 extraResources），开发时读
  `assets/tray.ico`；都不存在则 `nativeImage.createEmpty()` 容错。
- 菜单：显示/隐藏、语言（跟随系统/中文/English，radio）、开机自启（checkbox）、全局快捷键（显示当前）、
  MCP 状态（disabled，检测 `PATH` 中的 `dshbar-mcp.cmd`/`.exe`）、退出。tooltip `DSHBar`，双击切换形态。

### 5. 全局快捷键与开机自启
- 默认 `Alt+W`（可从 store.json 的 `settings.hotkey` 修改）；注册冲突时回退到 `Alt+W` 并弹窗提示。
- 退出时 `globalShortcut.unregisterAll()`。开机自启用 `app.setLoginItemSettings({ openAtLogin })`，启动默认收起。

### 6. 语言
- `src/shared/i18n.ts` 为字典单一来源（zh/en + `resolveLang`，`system` 按 `navigator.language` 回退）。
- 渲染层按 `settings.lang` 即时切换（主进程改语言后广播 `store:changed`）。
- 主进程**原生托盘菜单**文案在 `main.ts` 内联（zh/en 各一份），与渲染层字典相互独立。

### 7. IPC
- `store:get` / `store:mutate`(action) / `settings:update`(patch) / `ui:setCollapsed`(bool) /
  `window:move`({dx,dy}) / `mcp:detect`；广播 `store:changed` 与 `ui:modeChanged`。
- 拖拽：渲染层 mousedown 记录偏移，mousemove 上报增量，主进程 `setPosition` 并夹紧在 workArea 内。

## tsconfig 调整（已说明理由，未改 include 范围）

| 文件 | 改动 | 原因 |
| --- | --- | --- |
| `tsconfig.json` | 新增 `"exclude": ["src/shared/i18n.ts"]` | i18n 仅供渲染层（ESM）；主进程配置是 CommonJS，同文件双格式编译会在 dist/shared 互相覆盖 |
| `tsconfig.renderer.json` | `module` 改为 `"ES2022"`；新增 `"exclude": ["src/shared/store.ts"]` | 渲染层在浏览器 ESM 下运行（CommonJS 输出含 `require/exports` 会崩溃）；store.ts 仅供主进程/MCP（CommonJS），排除以免覆盖 |

`include` 范围**未改动**。

## package.json 调整

- `scripts.build` 改为 `tsc -p tsconfig.json && tsc -p tsconfig.renderer.json && node scripts/copy-renderer-assets.mjs`
- `scripts.dev:renderer` 增加 `&& node scripts/copy-renderer-assets.mjs`
- 原因：原 `build` 只编译主进程，`dist` 里不会有 renderer.js / index.html / renderer.css，
  而主进程加载 `dist/renderer/index.html`；tsc 不复制非 TS 文件，故需复制脚本。
- **未改动** electron-builder 的 `build` 段（打包队友负责）。

## 编译验证结果

| 命令 | 结果 |
| --- | --- |
| `tsc -p tsconfig.renderer.json` | ✅ 通过（0 错误） |
| `tsc -p tsconfig.shellbuild.json`（临时：main+preload+shared，排除 mcp，产物与 tsconfig.json 等价） | ✅ 通过（0 错误） |
| `npx tsc -p tsconfig.json`（完整，含 src/mcp） | ❌ Node 堆内存溢出（FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed，约 3.9GB） |

**重要：`npm run build`（`tsc -p tsconfig.json`）当前因 `src/mcp/cli.ts`（MCP SDK + zod 重型类型推断）
导致 Node 堆内存溢出而失败**，这是 mcp-dev 文件引入的、与壳层代码无关的问题
（排除 mcp 后同一 tsconfig 即刻通过）。已通过临时配置验证壳层源码 0 错误并生成 dist
（main.js / preload.js / shared/store.js / renderer.js / index.html / renderer.css 均已产出）。
建议 mcp-dev 排查：`skipLibCheck` 已开；可能是 zod/MCP SDK 版本类型过重或某处类型递归，考虑拆分类型或升级 SDK。

## 发现并修复的问题

1. **主进程 watch 自写死循环型 bug（已修）**：主进程每秒把 store 落盘，旧实现里 watcher 一收到事件就
   `lastTickSec = null`，导致每秒基准被清空、`tickRunning` 永远补算 0 秒，running 任务秒数不增长。
   现改为事件后重新读盘并与内存快照做内容比对，只有真正的外部改写才重置基准并广播。
2. **`store:mutate` 里 launchAtLogin 比较恒为 false（已修）**：赋值 `storeCache = next` 之后才比较，
   导致开机自启开关不生效；已改为先取旧值再比较。
3. **原 `build` 脚本只编主进程（已修）**：`dist` 里没有 renderer.js/index.html/renderer.css，而主进程
   加载 `dist/renderer/index.html`；已追加渲染层编译与 `scripts/copy-renderer-assets.mjs`。
4. **mcp-dev 依赖旧类型契约（已解决）**：mcp-dev 已按新 `types.ts` 契约重写 `src/mcp/cli.ts`。
5. **`tsc -p tsconfig.json` 全量 OOM（已解决）**：mcp-dev 弃用 `registerTool`、改底层 `Server + setRequestHandler`，
   绕开 TS2589/OOM，全量编译 EXIT=0。

## 如何本地跑通

前置：`npm install` 已完成（node_modules 已存在）。

```powershell
# 1) 编译：主进程 + 渲染层 + 复制静态资源
npm run build

# 2) 启动 Electron 窗口（会真实拉起窗口/托盘）
npm run start

# 仅想热更渲染层：
npm run dev:renderer
```

> ✅ 2026-10-29 更新：`tsc -p tsconfig.json` 全量编译已通过（EXIT=0），
> mcp-dev 改用底层 `Server + setRequestHandler`（弃用 `registerTool`）绕开 TS2589/OOM，
> `npm run build` 全流程（主进程 + 渲染层 + 复制资源）0 错误。

### store.json 路径与数据

- 默认：`%APPDATA%\DSHBar\store.json`（APPDATA 缺失时回退用户主目录）。
- 结构：`{ version: 1, tasks: Task[], settings: { lang, hotkey, launchAtLogin } }`。
- 原子写：先写 `<store>.tmp-<pid>` 再 rename；损坏文件会自动改名为 `store.json.bak` 并重建。
- 崩溃日志：`%APPDATA%\DSHBar\error.log`。

```powershell
# 查看 / 手工修改设置（如热键 Ctrl+Shift+Space）
notepad "$env:APPDATA\DSHBar\store.json"
```

### 调试方法

| 现象 | 排查 |
| --- | --- |
| 想看窗口/托盘 | `npm run start`；托盘在系统托盘区（图标缺失时会是一个空白图标，属预期） |
| 渲染层控制台 | 开发时给 `main.ts` 的 `new BrowserWindow(...)` 加 `webPreferences: { ... }` 外的 `show: false` 改为不隐藏，或在 `ready-to-show` 后 `win.webContents.openDevTools({ mode: 'detach' })` |
| 主进程日志 | `%APPDATA%\DSHBar\error.log`（`uncaughtException` / `unhandledRejection` 均落盘，不退出） |
| 数据是否被写入 | 运行中任务每秒落盘，`Get-Content "$env:APPDATA\DSHBar\store.json"` 可看 elapsedSeconds 递增 |
| 快捷键失效 | 检查是否被其它应用占用；菜单「全局快捷键」会显示当前值并提示回退 |
| 与 MCP 协同 | 主进程只检测 `PATH` 里的 `dshbar-mcp.cmd`/`.exe`；两个进程通过 store.json 共享，改动会互相感知（主进程 watch 目录 + 内容比对） |

## 需 lead 协调 / 告知其他队友

1. **共享类型契约以 `src/shared/types.ts` 为单一事实来源**：`TaskStatus = pending|running|paused|completed|aborted`，
   `Task` 含 `estimatedSeconds`(camelCase)、`startedAt/updatedAt/createdAt`(ISO)、可选 `note?`/`abortReason?`；
   `Settings{lang,hotkey,launchAtLogin}`、`StoreFile{version,tasks,settings}`、`TaskAction` 联合。
   mcp-dev 已按此契约重写 `src/mcp/cli.ts`，全量编译通过、`node scripts/mcp-smoke.mjs` 7 项 PASS。
2. `package.json` 的 `build`/`dev:renderer` 脚本已改（见上），pack-dev 的 `npm run build` 依赖仍兼容。
3. 托盘图标路径已兼容 pack-dev 的 extraResources（`process.resourcesPath/tray.ico`）。
4. 壳层未启动任何 MCP 服务器；仅检测 `PATH` 中的 `dshbar-mcp.cmd` 用于提示。

## aborted 状态兼容改动（2026-10-29）

MCP 契约新增 `aborted` 状态与 `note?`/`abortReason?` 字段后，壳层的适配改动：

- **`src/main/main.ts`**：计时节拍本就只推进 `status === 'running'`，
  `pending/paused/completed/aborted` 一律不计入运行（已加注释说明）；主进程无当前任务选择逻辑。
- **`src/renderer/renderer.ts`**：
  - `ringState()` 对 `aborted` 返回灰色 `#8a8f98`、环不填充（静止），不超时。
  - `describeMeta()` 对 `aborted` 显示 `✕ 已取消`（英文 `Aborted`），并在 `abortReason` 存在时附加原因。
  - 完成按钮 `btn-done` 对 `completed` / `aborted` 禁用（点击事件也加守卫）。
  - `syncView()` 自动模式跳过 `aborted`（取消任务不算当前活动任务），但手动 `‹ ›` 仍可浏览到它以查看取消状态。
  - 卡片加 `aborted` class，整体降饱和。
- **`src/shared/i18n.ts`**：新增 `task.aborted`（zh `已取消` / en `Aborted`）。
- **`src/renderer/renderer.css`**：新增 `--aborted: #8a8f98` 与 `.card.aborted` 样式。

验证：`npm run build` 全流程 EXIT=0（`tsc -p tsconfig.json` + `tsc -p tsconfig.renderer.json` + 复制资源）。
未改动 `src/mcp/**`、`package.json`。

## 崩溃兜底与 store 可重定位（2026-10-29 v2）

最终 GUI 验收发现两个真实缺陷，已修复：

**缺陷 1：不可写目录导致主进程启动前静默崩溃。**
- 原实现 `startDesktopApp()` 在模块顶层执行，其首步 `adapter.load() → write() → fs.mkdirSync(dirname)`
  在 `app.whenReady()` 与崩溃兜底注册**之前**同步抛出（例：`%APPDATA%\DSHBar` 只读时 `EPERM`），
  进程直接退出，无 UI、无日志。
- 修复（`src/main/main.ts`）：
  - 崩溃兜底 `logError` + `uncaughtException`/`unhandledRejection` 上移到模块作用域；
  - 单实例锁 `requestSingleInstanceLock` 上移到模块作用域；
  - 移除模块顶层 `startDesktopApp()` 调用；启动改为
    `app.whenReady().then(() => { try { startDesktopApp(); } catch (err) { logError(err); dialog.showErrorBox(...) } })`；
  - `startDesktopApp` 内部的 `whenReady` 分支整体包 try/catch，异常同时落日志并弹窗。
- 修复（`src/shared/store.ts`）**fail-soft 写**：`write()` 的 mkdir/tmp-write/renameSync 整体 try/catch，
  失败不抛、只吞掉；`StoreAdapter` 新增内存缓存 `lastGood`，磁盘写失败时继续以内存副本服务读取。
  `load()` 缺失/损坏时同样在 try/catch 里写空档，永不抛出。

**缺陷 2：store 路径不可重定位（同时阻碍冒烟测试）。**
- `defaultStorePath()` 现优先读取环境变量 `DSHBAR_STORE`，非空即作为 store.json 路径；
  未设置时回退 `%APPDATA%\DSHBar\store.json`。
- 例：`set DSHBAR_STORE=E:\scratch\store.json && electron .`。

**验证结果：**
- `tsc -p tsconfig.json` EXIT=0；`tsc -p tsconfig.renderer.json` EXIT=0；`node scripts/copy-renderer-assets.mjs` EXIT=0；dist 已重建。
- store 层在纯 Node 下用 `build\verify-store.cjs`（临时脚本，用完删除）实测：
  - `DSHBAR_STORE=C:\Windows\System32\dshbar-should-fail\store.json`（不可写）→
    `load()` 与 `mutate()` 均不抛、磁盘文件确实未创建、内存仍返回空档/新增任务，**fail-soft 生效**；
  - `DSHBAR_STORE=…\build\gui-store.json`（可写）→ `load()` 自动创建文件，
    内容 `{ "version": 1, "tasks": [], "settings": { "lang": "system", "hotkey": "Alt+W", "launchAtLogin": false } }`；
    `mutate()` 新增后重读磁盘 tasks=1；**DSHBAR_STORE 覆盖生效**；
  - 空字符串覆盖回退到默认路径。
- GUI 级验证（Electron 真拉起窗口）**在本 agent 的非交互会话中不可执行**：本会话里 electron.exe
  拉起后立即退出、无 stderr、无 store 文件，属会话无桌面所致（lead 的 `build/dev-err.txt` 已证明
  electron 在交互会话中能跑到主进程）。请 lead 在交互会话按下面步骤实测：
  1. `set DSHBAR_STORE=E:\herness\03\dshbar\build\gui-store.json` 后 `node_modules\electron\dist\electron.exe .`；
     预期：进程保持运行、`build\gui-store.json` 被创建。
  2. `set DSHBAR_STORE=C:\Windows\System32\dshbar-should-fail\store.json` 后同上；
     预期：不崩溃、弹「DSHBar」错误框（或写入 `build\error.log`），进程保持运行。
- 排查提示：本 agent 的进程环境带 `ELECTRON_RUN_AS_NODE=1`，该变量会使 electron.exe 变成纯 Node、
  `require('electron')` 只返回路径字符串而报 `app undefined`——这不是代码问题；交互会话一般不带此变量。

## 后续（未执行）

- 未运行 `npm start`（会拉起 Electron 窗口），如需实测请由 lead/pack-dev 决定。
- 未生成安装包 / 图标二进制。
