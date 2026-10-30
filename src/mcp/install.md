# 在 DSH 客户端中接入 dshbar-mcp

DSHBar 的 MCP 服务器由 **DSH 客户端通过 `dshbar-mcp` 命令以 stdio 方式独立启动**。

> **运行方式**：MCP 服务器跑在**独立的 Node.js 进程**里（`dshbar-mcp.cmd` 启动的 `node <resources>\dshbar-mcp\dist\mcp\cli.js`），**不在 DSHBar.exe 内运行**，也不依赖 Electron 进程是否存活。它与 Electron 主进程是两个进程，二者仅通过同一个 JSON store 文件（Windows 默认 `%APPDATA%\DSHBar\store.json`）共享任务状态。

## 1. 前置条件

- **安装版（推荐给最终用户）**：
  - 已安装 DSHBar（NSIS 安装器）。安装器会把 `dshbar-mcp` 加进用户 PATH，并随包带上 MCP 服务器运行所需的自包含 `resources\dshbar-mcp\` 目录。
  - 机器上需要 **Node.js 18+**。`dshbar-mcp.cmd` 会依次尝试 `D:\node\node.exe`、PATH 中的 `node`、`%ProgramFiles%\nodejs\node.exe`、`%ProgramFiles(x86)%\nodejs\node.exe`、`%LOCALAPPDATA%\Programs\nodejs\node.exe`；一个都没找到时会在 stderr 打印明确错误并退出。**（如果希望目标机器无需安装 Node，需要改为在安装器里打包一个便携版 node.exe，见 BUILD_PACK.md 的风险说明。）**
- **源码版（开发 / npm link）**：`npm install` 之后直接用项目内的 `node_modules/.bin/dshbar-mcp`，或 `npm link` 后的全局命令。
- 建议先启动 DSHBar 桌面端（托盘悬浮窗 / 任务圆环），这样你在 MCP 里建的任务会实时出现在悬浮窗上（Electron 主进程 watch 同一份 store 文件并广播给渲染层）。

## 2. DSH 适用的 MCP 配置片段

DSH **桌面端**没有 `mcpServers` JSON 这一层：每个 MCP 服务器都是 profile patch 里的一条
`@deepseek-ai/dsh-mcp-client` 条目，写在
`%APPDATA%\dsh-desktop\harness\profiles\web\cordis.patch.yml`：

```yaml
- insert:
    - id: mcp-dshbar
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: dshbar
        transport: stdio
        command: 'D:\node\node.exe'
        args:
          - 'E:\herness\03\dshbar\release\win-unpacked\resources\dshbar-mcp\dist\mcp\cli.js'
        env:
          NODE_PATH: 'E:\herness\03\dshbar\release\win-unpacked\resources\dshbar-mcp\vendor'
```

要点（踩过的坑）：

- 工具名是 `mcp__dshbar__<tool>`（`serverName` 决定中间那段），不是裸的 `dshbar_start_work`。
- `command` 必须是**绝对 `node.exe` 路径**：stdio 用 `shell: false` 启动，PATH 里的
  `dshbar-mcp.cmd` 不会被解析成批处理。
- `NODE_PATH` 指向 `resources\dshbar-mcp\vendor`，否则 Node 解析不到
  `@modelcontextprotocol/sdk` / `zod`。
- 改完 patch 需要重新加载（重启 DSH 桌面端最稳）；确认是否生效可以看会话里有没有
  `mcp__dshbar__*` 工具。

**其它 MCP 客户端**（Claude Code / Codex / Cursor…）用通用 JSON：`command` 指向
`dshbar-mcp`（或 `dshbar-mcp.cmd` 的绝对路径），`type` 为 `stdio`：

```json
{
  "mcpServers": {
    "dshbar": {
      "command": "dshbar-mcp",
      "type": "stdio",
      "args": []
    }
  }
}
```

> **不想手写路径**：右键托盘图标 →「复制 MCP 接入配置」，会直接把带**绝对路径**的 JSON 片段放进剪贴板，粘贴即可。托盘里显示「MCP：已就绪」就说明启动器已被找到。

> **DSH 客户端读取的 PATH 取自它自己启动时的环境**。如果 DSH 是在安装 DSHBar **之前**启动的，它可能还看不到新的 PATH，请重启 DSH 客户端（或注销重登）一次。
>
> 若 `dshbar-mcp` 不在 PATH 中，请用绝对路径替换 `command`，例如：
> - 安装版：`"command": "C:\\Users\\<你>\\AppData\\Local\\Programs\\DSHBar\\resources\\dshbar-mcp.cmd"`（按实际安装目录）
> - 解压版 / 开发版：`"command": "E:\\herness\\03\\dshbar\\release\\win-unpacked\\resources\\dshbar-mcp.cmd"`
>
> **⚠️ 免安装（portable）单文件版不要这样配**：portable 每次启动都会把程序解压到 `%TEMP%` 下的临时目录，退出即清理，写进配置的绝对路径下次启动就失效。需要长期接入 DSH 时请用安装版或解压版（`release\win-unpacked`）。
>
> 顺带说明：托盘上的「未检测到 dshbar-mcp」只代表**当前进程的 PATH 里没有**，不代表 MCP 不可用。启动器就在程序自己的 `resources\` 目录下，用绝对路径随时可以接。

## 3. 可选参数

- `args` 里可传第 1 个位置参数作为 **store 文件路径**，用于覆盖默认位置：
  ```json
  "args": ["C:\\Users\\<你>\\AppData\\Roaming\\DSHBar\\store.json"]
  ```
  不传则使用 `%APPDATA%\DSHBar\store.json`（与桌面端默认一致，**通常无需指定**）。

## 4. 验证接入

1. 保存配置并重载 DSH 客户端，使 MCP 服务器启动。
2. 在对话中让 AI 调用 `dshbar_get_status`，返回 `ok: true` 及统计即表示接入成功。
3. 在对话中让 AI 调用 `dshbar_start_work`（如「开始记录：写周报」），随后应能在 DSHBar 悬浮窗看到该任务在计时。

## 5. 给 AI 客户端的规则提示词

MCP 只解决"能记"，**记不记由模型决定**。不把纪律告诉模型，它就永远不会调用这些工具——
悬浮条一直停在「暂无任务」，看着像是没接上。

### DSH 桌面端：写进全局 AGENTS.md（推荐）

DSH 内置 `dsh-agent-instructions` 插件，每次会话第一次请求前会把用户全局指令和项目级
`AGENTS.md` / `CLAUDE.md` 注入上下文。所以把 `src/mcp/prompt.md` 的内容写进：

```text
%APPDATA%\dsh-desktop\harness\AGENTS.md      # $DSH_HOME/AGENTS.md
```

对本机所有工作目录的会话生效，改完不用重启 DSH（下一次请求会重新对账）。也可只对某个
仓库生效：在仓库根（有 `.git` 的那层）或会话工作目录放 `AGENTS.md`。

### 其它客户端

把 `src/mcp/prompt.md` 的内容粘贴到系统提示、工具使用说明或项目规则文件
（`CLAUDE.md` / `.cursor/rules` / Codex 的 `AGENTS.md` 等），AI 就会按
「只记录有跟踪价值的任务 + 静默记录」的纪律使用这些工具。

## 6. 故障排查

- **`initialize` 超时 / 工具列表为空**：确认 `dshbar-mcp` 可执行且无报错（可在终端手动运行 `dshbar-mcp`，应打印 `[dshbar-mcp] dshbar v0.1.0 ready (store=...)` 后等待 stdin）。
- **报错 `Node.js 18+ not found`**：`dshbar-mcp.cmd` 在 PATH、`%ProgramFiles%`、`%ProgramFiles(x86)%`、`%LOCALAPPDATA%\Programs`、`D:\node` 都没找到 `node.exe`。请安装 Node.js 18+，或把 `node.exe` 放到这些位置之一。
- **报错 `Cannot find module '@modelcontextprotocol/sdk/...'` / `Cannot find module 'zod'`**：说明 `resources\dshbar-mcp\vendor\` 下的自包含依赖闭包缺失（例如手动拷贝时漏拷）。该目录由 `scripts/build-mcp-bundle.cjs` 生成、由安装器随包分发，且启动器通过 `NODE_PATH=<resources>\dshbar-mcp\vendor` 让 Node 从中解析 bare 依赖。重新安装 DSHBar 即可。
- **悬浮条一直显示「暂无任务」**：MCP 通了但模型没记。先确认 `%APPDATA%\DSHBar\store.json` 里有没有任务；文件是空的就回去看第 5 节（缺提示词），文件里有任务而界面不显示才是 DSHBar 的问题。桌面端通过 150ms 去抖的 `fs.watch` 监听同一文件，新任务到来时会自动展开置顶。
- **多进程互相覆盖**：所有写入都原子化且写前重读，正常情况下不会丢数据；若怀疑异常，检查 `%APPDATA%\DSHBar\store.json` 是否为合法 JSON。
