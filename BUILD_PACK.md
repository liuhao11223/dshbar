# DSHBar · BUILD_PACK（打包 / 图标 / MCP 命令安装）

> 本文件由 **pack-dev** 编写，是 Windows 打包、图标资产与 MCP PATH 安装约定的权威记录。
> 项目根：`E:\herness\03\dshbar`。参考上游：https://github.com/Obsucre777/WorkBar

---

## 1. 图标资产（assets/）

### 1.1 生成脚本
`scripts/make_icons.py` — 使用 DSH 环境自带的 Python + Pillow 生成，纯几何图形（圆环 + 中心圆点，呼应任务圆环），**无 emoji、无文字**。
- Python：`D:\DSH desktob\DSH Desktop\resources\office-runtime\primary-runtime\dependencies\python\python.exe`
- Pillow：12.3.0（已验证）
- 主图标：256×256，主色渐变 `#4F8CFF` → 深蓝 `#122A64`（左上→右下），圆环外半径 0.905×R、描边 22px、中心实心圆 0.26×直径，透明背景；4× 超采样 + LANCZOS 抗锯齿。
- 托盘图标：单色近白 `#E8ECF2`（深色托盘下可见），圆环描边 2.6px、中心点 0.18×直径。

### 1.2 产物
| 文件 | 尺寸 | 用途 |
|---|---|---|
| `assets/icon.png` | 256×256 RGBA | 主图标源 / 文档 |
| `assets/icon.ico` | 16 / 32 / 48 / 256 四档 | `build.win.icon`（窗口 / 任务栏 / 安装器） |
| `assets/tray.ico` | 16 / 32 两档 | 托盘图标 |
| `assets/trayTemplate.png` | 32×32 | 托盘备用单色图 |

验证命令：
```powershell
& "D:\DSH desktob\DSH Desktop\resources\office-runtime\primary-runtime\dependencies\python\python.exe" -c "from PIL import Image; im=Image.open(r'E:\herness\03\dshbar\assets\icon.ico'); print('icon.ico dir', im.info.get('sizes'))"
# 期望：icon.ico dir {(16,16),(32,32),(48,48),(256,256)}；tray.ico dir {(16,16),(32,32)}
```

重新生成：
```powershell
cd E:\herness\03\dshbar
npm run icons      # 或直接 python scripts/make_icons.py
```

### 1.3 重要踩坑（已修）
- Pillow 的 ICO 只有在「**单个基准图 + `sizes` 列表**」时才会写出多档图像；传入 `append_images` 会退化成只写 1 档。`save_ico()` 现已用最大帧作基准 + `sizes`，并校验 ICO 条目数；若 Pillow 失败或条目数不符，自动退化为手写 PNG-ICO（`_write_ico_png_frames`）。两种产物均已验证为 4 / 2 档。
- 首次渲染圆环消失：圆点挖空系数写反（`1 - smoothstep(...)`），已修正为 `_smoothstep(dot_r+4, dot_r+8+feather, dist)`。

---

## 2. package.json build 段改动

**约束**：`appId: com.dshbar.desktop`、`productName: DSHBar`、目录结构（`dist/**` + `assets/**` + `package.json`）保持不变；**未新增任何 dependencies / devDependencies**，仅调 build 段与 scripts。

改动清单（均在 `build` 段内）：
- 新增 `"artifactName": "${productName} Setup ${version}.${ext}"` → 产物 `DSHBar Setup 0.1.0.exe`。
- `nsis` 段新增：
  - `"shortcutName": "DSHBar"`
  - `"uninstallerDisplayName": "DSHBar"`
  - `"installerLanguages": ["zh_CN", "en_US"]`
  - `"include": "build/installer.nsh"` ← **关键**，接入 PATH 逻辑
- 新增 `extraResources`：把 `assets/tray.ico`、`assets/trayTemplate.png` 拷到 `<resources>\`，便于托盘运行时按文件名取用。
- `portable.artifactName` 保持 `"DSHBar-portable-${version}.exe"`。
- `scripts` 段：给 `dist` / `dist:portable` / `dist:dir` 加 `--publish never`（避免构建时触发 publish）；`dist:dir` 改为 `electron-builder --win dir`（`--dir` 单独使用会被 electron-builder 判为缺目标而打印 help 退出，需显式带 `--win`）；新增 `npm run icons`。

当前 `build` 段（完整）：
```json
"build": {
  "appId": "com.dshbar.desktop",
  "productName": "DSHBar",
  "artifactName": "${productName} Setup ${version}.${ext}",
  "directories": { "output": "release" },
  "files": ["dist/**/*", "assets/**/*", "package.json"],
  "extraResources": [
    { "from": "assets/tray.ico", "to": "tray.ico" },
    { "from": "assets/trayTemplate.png", "to": "trayTemplate.png" }
  ],
  "win": { "target": ["nsis", "portable"], "icon": "assets/icon.ico" },
  "nsis": {
    "oneClick": false,
    "allowToChangeInstallationDirectory": true,
    "createDesktopShortcut": true,
    "createStartMenuShortcut": true,
    "shortcutName": "DSHBar",
    "uninstallerDisplayName": "DSHBar",
    "installerLanguages": ["zh_CN", "en_US"],
    "include": "build/installer.nsh"
  },
  "portable": { "artifactName": "DSHBar-portable-${version}.exe" }
}
```

---

## 3. MCP 命令进 PATH（NSIS 钩子，方案 a）

采用方案 a：安装器写一个 `dshbar-mcp.cmd` 包装脚本并把它的目录追加到**用户 PATH**，这样 DSH 的 MCP 配置可直接写 `"command": "dshbar-mcp"`。

### 3.1 文件
- `build/installer.nsh`（electron-builder `nsis.include` 唯一加载的文件，含 `customInstall` + `customUnInstall` 两个宏 + 两个辅助函数）
- `build/uninstaller.nsh`（卸载 PATH 清理的独立/可审查副本，见 §3.6）

### 3.2 安装时写入的 cmd（`<installDir>\resources\dshbar-mcp.cmd`）

**启动架构（最终版）**：`dshbar-mcp` 是一个**独立的 Node.js 进程**，**不经过 `DSHBar.exe`**。原因（lead 实测）：Electron 主进程无法把 stdio 管道接到 `process.stdin/stdout`，且 Chromium 会拒绝未注册的命令行开关（打包后的 `DSHBar.exe --mcp` 报 `bad option: --mcp`）。所以 cmd 只做三件事——**找一个真实 Node 运行时、导出 `NODE_PATH`、运行随包分发的 `dist/mcp/cli.js`**：

```bat
@echo off
setlocal
rem DSHBar MCP launcher - runs the MCP server with a real Node.js runtime.
set "CLI=%~dp0dshbar-mcp\dist\mcp\cli.js"
set "NODE="
if exist "D:\node\node.exe" set "NODE=D:\node\node.exe"
if not defined NODE where node >nul 2>&1 && set "NODE=node"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE (
  echo [dshbar-mcp] ERROR: Node.js 18+ not found. Please install Node.js from https://nodejs.org. 1>&2
  exit /b 1
)
set "NODE_PATH=%~dp0dshbar-mcp\vendor"
"%NODE%" "%CLI%" %*
endlocal
```
- `%~dp0` = 该 cmd 所在目录 = `<installDir>\resources\`；`dshbar-mcp\dist\mcp\cli.js` 直接落入随包分发树。
- **Node 查找顺序**：`D:\node\node.exe` → PATH 中的 `node` → `%ProgramFiles%\nodejs` → `%ProgramFiles(x86)%\nodejs` → `%LOCALAPPDATA%\Programs\nodejs`；全找不到则 stderr 报错并退出。
- **`NODE_PATH` 指向 `vendor`**（不是 `node_modules`）：见 §3.7 的关键发现——electron-builder 会无条件剔除 extraResources 里的 `node_modules`，所以依赖闭包改名为 `vendor`，并用 `NODE_PATH` 补回模块解析。
- `%*` 原样透传 MCP 的 stdio 参数（DSH 一般传空，但透传不丢参数）。

### 3.3 PATH 追加（安装）
- 读 `HKCU\Environment\Path`（assisted 安装器默认装到 `%LOCALAPPDATA%\Programs\DSHBar`，用 HKCU 用户 PATH 合适）
- 用自写 `DSHBar_FindSubstring` 判断 `<installDir>\resources` 是否已在 PATH；已存在则跳过（覆盖升级/重装场景）
- 追加：`<installDir>\resources;` + 原 PATH（插在最前，避免与同名项冲突时被截断）
- 写入后 `SendMessage 0xFFFF 0x001A 0 "STR:Environment" /TIMEOUT=500` 广播 `WM_SETTINGCHANGE`，让已运行的 DSH / Explorer / 终端立即感知新 PATH

### 3.4 PATH 清理（卸载）
`customUnInstall` 中：
1. `Delete "$INSTDIR\resources\dshbar-mcp.cmd"`
2. 读 PATH → `DSHBar_PathRemoveEntry` 按 `;` 逐段重建、剔除 `<installDir>\resources` 项（无论它在最前 / 中间 / 末尾 / 重复 / 全等），写回并再次广播 `WM_SETTINGCHANGE`

### 3.5 语法与正确性
- 仅使用 NSIS 核心指令（`Exch/Push/Pop/StrLen/StrCpy/StrCmp/IntCmp/IntOp/Goto/FileOpen/FileWrite/FileClose/ReadRegStr/WriteRegStr/Delete/CreateDirectory/SendMessage`），**不依赖 LogicLib / StrFunc / WinMessages**（避免与 electron-builder 自带脚本的宏/常量冲突；`WM_SETTINGCHANGE`、`HWND_BROADCAST` 用字面量 `0x001A`、`0xFFFF`）
- 辅助函数用 `$R*` 寄存器，宏体用 `$0-$9`，二者互不干扰
- 由于本机没有 makensis，无法用 makensis 编译校验；已用 Python 精确复刻 `FindSubstring` / `PathRemoveEntry` / 安装时追加 的算法并跑了 15 条断言全部通过（`scripts/_sim_nsis.py`，任务完成后可删）。**首次打包前建议在装有 NSIS 的机器上 `makensis` 编译一次 `build/installer.nsh` 做最终确认**。

### 3.6 关于 `build/uninstaller.nsh`
electron-builder 只通过 `nsis.include` 加载**一个**自定义脚本，所以 `customInstall` 与 `customUnInstall`（及它们共用的两个函数）都放在 `build/installer.nsh` 里。`build/uninstaller.nsh` 是卸载逻辑的独立可审查镜像，二者保持同步。文件头已注明：若想拆成两个文件，把两个函数 + `customUnInstall` 迁到 `uninstaller.nsh`，并在 `installer.nsh` 首行加 `!include "uninstaller.nsh"`（NSIS 相对 include 按被包含文件所在目录解析）。

---

## 4. MCP 服务器如何随包分发（standalone Node，无 `--mcp`）

**⚠️ 架构变更**：原计划让 `DSHBar.exe --mcp` 以无窗口 stdio MCP 模式 fork 出 MCP，**已废弃**（理由见 §3.2 开头）。当前形态：

- `scripts/build-mcp-bundle.cjs` 从 `dist/mcp/cli.js` 做**静态 require 闭包分析**（`@modelcontextprotocol/sdk` 无动态 `require(<expr>)`，已验证），把运行时真正用到的项目代码 + bare 依赖拷到 `build/mcp-runtime/`：
  ```
  build/mcp-runtime/
    dist/mcp/cli.js
    dist/shared/{store,i18n,types}.js
    vendor/{zod,ajv,@modelcontextprotocol,...}   ← 自包含依赖闭包
  ```
  闭包含 8 个包、约 1982 个文件、9.26 MB，无嵌套 `node_modules`。
- `package.json build.extraResources` 把该目录整体发到 `resources\dshbar-mcp\`（在 **app.asar 之外**——plain Node 读不了 asar）。
- `build/installer.nsh` 的 `customInstall` 写入 §3.2 的 cmd 并追加 `<installDir>\resources` 到用户 PATH。
- **MCP 与 Electron 主进程是两个独立进程**，仅通过同一个 JSON store（默认 `%APPDATA%\DSHBar\store.json`）共享任务状态。**`shell-dev` 的 `src/main/main.ts` 无需实现任何 `--mcp` 分支**（已删除相关代码）。

### 4.1 ⚠️ 关键坑：electron-builder 会剔除 extraResources 里的 `node_modules`
实测：把闭包放进 `build/mcp-runtime/node_modules/` 并通过 `extraResources` 发出后，**打包结果里完全没有 `node_modules`**（加 `"filter": ["**/*", "!**/*.map"]` 也没用）。根因在 `node_modules/app-builder-lib/out/fileMatcher.js` 约 126–138 行：`getFileMatchers()` 只有在 `matcher.from === appDir` 时才提前返回，否则无条件注入 `!**\node_modules\**` 到 excludePatterns（extraResources 的 `from` 不是 appDir，必中此分支）。

**解法**：闭包根目录改名 `vendor`（本闭包无嵌套 `node_modules`，只需改这一层），再由 cmd 里 `set "NODE_PATH=%~dp0dshbar-mcp\vendor"` 让 Node 的 bare 解析落到 `vendor`。改名后打包实测：`resources\dshbar-mcp\vendor\{zod,@modelcontextprotocol,...}` 全部到位（与 `build/mcp-runtime` 相比只少了 457 个 `.map` sourcemap，属 electron-builder 默认排除，运行时不需要）。

### 4.2 端到端验证（已通过）
用 `scripts/launcher-verify.mjs` 对 `release/win-unpacked/resources\dshbar-mcp.cmd`（与 NSIS 实际写入内容逐字一致）做完整 stdio MCP 会话：
- `initialize` → `serverInfo { name: dshbar, version: 0.1.0 }` ✓
- `tools/list` → 11 个 `dshbar_*` 工具全部在列 ✓
- `tools/call` → `dshbar_start_work` / `dshbar_list_tasks` / `dshbar_get_status` / `dshbar_finish_work` 均返回 ✓
- stderr 无 `Cannot find module ...`（Node 通过 `NODE_PATH` 成功解析 `vendor` 里的依赖）✓
- 结果：`LAUNCHER VERIFY: PASS`（exit 0）。

> 说明：`launcher-verify.mjs` 通过 `cmd.exe /c` 拉起 cmd（不用 Node 的 `shell: true`——后者传 args 会触发 DEP0190 弃用告警）。
> 说明：`dshbar-mcp.cmd` 由 NSIS `customInstall` 在**安装时**写入 `<installDir>\resources\`，所以纯 `--win dir` 的 `win-unpacked\resources\` 里**默认没有**这个 cmd。要对 unpacked 目录做同样验证，需先把 §3.2 的 cmd 内容放到 `release\win-unpacked\resources\dshbar-mcp.cmd`（本次验证就是这么做的）。

---

## 5. 构建命令与预期产物

```powershell
cd E:\herness\03\dshbar

# 0) 图标（改过 assets 时）
npm run icons                    # python scripts/make_icons.py

# 1) 编译 TS -> dist/
npm run build

# 2) 生成 MCP 独立运行时（dist/mcp+shared + vendor 依赖闭包 -> build/mcp-runtime）
npm run mcp:bundle
node scripts/build-mcp-bundle.cjs --self-test   # 可选：自测 initialize 往返

# 3) 打安装器 + 便携版（NSIS + portable；脚本已自动带 mcp:bundle）
npm run dist                    # electron-builder --win nsis --publish never

# 仅便携版
npm run dist:portable           # electron-builder --win portable --publish never

# 只出 unpacked 目录，快速校验图标/配置/extraResources（不打安装器）
npm run dist:dir                # electron-builder --win dir --publish never

# 4) 对打包产物做 MCP 端到端验证（跑一遍 §4.2）
node scripts/launcher-verify.mjs release/win-unpacked/resources
```

> ⚠️ 调用 electron-builder 请用 `node node_modules\electron-builder\out\cli\cli.js <args>` 或 `npx electron-builder`；直接双击 `node_modules\.bin\electron-builder.cmd` 传参会因 yargs 误读 `argv[0]` 而打印 help 并退出 1。
> ⚠️ **DSH 开发机专属坑（务必注意）**：本机 PATH 里的 `node` 被 harness 垫成了 `node.cmd`，内容是 `set ELECTRON_RUN_AS_NODE=1` 后调 `"D:\DSH desktob\DSH Desktop\DSH Desktop.exe" %*`，也就是 **Electron 假装的 node**。它跑 `--win dir` 这类需要完整 yargs 解析的命令时，会把脚本路径当成未知参数（`Unknown argument: ...\electron-builder\out\cli\cli.js`）而失败。**在本机，任何 `npm run dist*` 都要先让 `node` 指向真 Node**（真 Node 在 `D:\node\node.exe`），例如：
>   ```powershell
>   $env:PATH = "D:\node;" + $env:PATH    # 让真 node 排在 harness 垫片之前
>   npm run dist:dir
>   ```
>   或者直接跳过 npm，用已实测通过的一步到脚本（脚本内部用 `process.execPath`，所以必须用真 Node 起）：
>   ```powershell
>   D:\node\node.exe scripts/build-and-dir.cjs
>   ```

预期产物（`release/` 目录）：
- `release/DSHBar Setup 0.1.0.exe` ← NSIS 安装器（artifactName `${productName} Setup ${version}.exe`）
- `release/DSHBar-portable-0.1.0.exe` ← 便携版
- `release/win-unpacked/` ← unpacked 目录（`--win dir` 时生成），内含 `DSHBar.exe` + `resources\`（含 `app.asar`、`tray.ico`、`trayTemplate.png`）

安装后（`%LOCALAPPDATA%\Programs\DSHBar\`）：
- `DSHBar.exe`
- `resources\app.asar`
- `resources\dshbar-mcp.cmd`（NSIS 写入）
- `resources\dshbar-mcp\`（`dist\mcp\cli.js` + `dist\shared\*.js` + `vendor\...`，extraResources 分发）
- `Uninstall DSHBar.exe`

---

## 6. 本次验证情况（诚实记录）

**已完成（本轮）**：
- 图标四件套生成并逐项验证（尺寸 / ICO 档位 / RGBA / 透明度包围盒）
- package.json build 段与 scripts 修改，`node -e` JSON 解析通过
- **`npm run dist:dir` 全程跑通**（`--win dir --publish never`，通过设置 npmmirror 镜像下载 Electron 45.1.0）：产出 `release\win-unpacked\DSHBar.exe` + `resources\app.asar` + `tray.ico` + `trayTemplate.png` + `resources\dshbar-mcp\`。说明 build 段、图标路径、extraResources 均被 electron-builder 26.18.0 接受。
- **MCP 端到端验证通过**（`scripts/launcher-verify.mjs`）：`LAUNCHER VERIFY: PASS`，完整 stdio 会话（initialize / tools/list 11 工具 / start_work / list_tasks / get_status / finish_work）全绿，无 `Cannot find module`（详见 §4.2）。
- **定位并绕过 electron-builder 的 `node_modules` 剔除**（§4.1）：依赖闭包改名 `vendor` + `NODE_PATH` 兜底解析。
- NSIS PATH 追加/清理算法经 Python 模拟 15 条断言全通过
- `electron-builder --version` → 26.18.0，本机可执行

**注意（给后续执行者）**：
- 直接双击 `node_modules\.bin\electron-builder.cmd` 传参时，yargs 在本机解析出异常（打印 help 并退出 1，argv[0] 被识别成 `DSH Desktop.exe`）。请用 **`node node_modules\electron-builder\out\cli\cli.js <args>`** 或 `npx electron-builder`。
- **DSH 开发机的 `node` 是 harness 垫片**（=`node.cmd`，内部 `set ELECTRON_RUN_AS_NODE=1` 后调 `DSH Desktop.exe`），跑 `--win dir` 这类命令会报 `Unknown argument: ...\electron-builder\out\cli\cli.js`。所以本机上 `npm run dist*` 会失败，**必须让真 Node（`D:\node\node.exe`）排在 PATH 前面**，或直接用 `D:\node\node.exe scripts/build-and-dir.cjs`（已实测通过）。详见 §5 的加粗提示。
- 已验证的一步到命令：`D:\node\node.exe scripts/build-and-dir.cjs` → `BUILD+DIR OK`，随后 `node scripts/launcher-verify.mjs release/win-unpacked/resources` → `LAUNCHER VERIFY: PASS`。

**未完成 / 未覆盖（并说明原因）**：
- **未跑 `npm run dist`（NSIS 安装器）**：需联网下载 NSIS / winCodeSign（`makensis`）组件，本机未能完成；且打包安装器依赖同一套产物。命令见 §5。
- **NSIS 脚本未用 makensis 编译校验**（本机无 makensis）：PATH 算法已用 Python 精确复刻做断言覆盖，但 `installer.nsh` / `uninstaller.nsh` 的宏/指令语法仍需在装有 NSIS 的机器上编译一次确认。**这是首次正式发版前的必做项。**
- **未实际执行安装/卸载流程**：`dshbar-mcp.cmd` 的 PATH 追加、`WM_SETTINGCHANGE` 广播、卸载时 PATH 清理均未在真实安装器里验证（需先能打出安装器）。
- **便携版（portable）未验证**：便携版不进 PATH，MCP 命令不会注册，属已知取舍（见 §4 结尾）。
- **Node.js 前置条件风险**：目标机器必须有 Node.js 18+（launcher 会在 PATH / 常见安装路径 / `D:\node` 里找）。若希望免安装 Node，后续可在安装器里额外打包一个便携版 `node.exe`（本任务未做，避免引入额外体积与许可证考量）。

---

## 7. 交付物清单（pack-dev）
- `scripts/make_icons.py` — 图标生成脚本
- `assets/icon.png` / `icon.ico` / `tray.ico` / `trayTemplate.png` — 生成的图标
- `package.json` — build 段与 scripts 改动（含 `mcp:bundle`）
- `build/installer.nsh` — NSIS 安装/卸载钩子（PATH 追加/清理 + 写入 `dshbar-mcp.cmd`）
- `build/uninstaller.nsh` — 卸载 PATH 清理（独立镜像）
- `scripts/build-mcp-bundle.cjs` — 生成 MCP 独立运行时（dist/mcp+shared + `vendor` 依赖闭包）
- `scripts/launcher-verify.mjs` — 对打包产物做 MCP 端到端验证
- `scripts/build-and-dir.cjs` — build + `--win dir` 一步到位（供 `dist:dir` 用）
- `BUILD_PACK.md` — 本文档（改动记录、运行命令、架构与验证情况）
- `scripts/_sim_nsis.py` — NSIS 逻辑验证脚本（可保留作回归，也可删）

---

## 8. 给 lead 的同步要点
1. **MCP 启动架构已改为 standalone Node**：`dshbar-mcp` 由 `dshbar-mcp.cmd` 用**真实 Node.js** 运行随包分发的 `dist/mcp/cli.js`，**不再走 `DSHBar.exe --mcp`**（Electron 主进程接不到 stdio、Chromium 会拒绝 `--mcp` 开关）。`shell-dev` 的 `src/main/main.ts` **无需实现 `--mcp` 分支**（相关代码已删）。
2. **electron-builder 会剔除 extraResources 里的 `node_modules`**：依赖闭包已改名 `vendor`，由 cmd 里 `NODE_PATH` 兜底解析（§4.1）。这是本次打包的关键坑，务必保留此约定。
3. **端到端已通过**：`npm run dist:dir` 跑通，且 `scripts/launcher-verify.mjs` 对 `release/win-unpacked/resources/dshbar-mcp.cmd` 完成完整 MCP 会话验证（§4.2 / §6）。
4. **剩余必做项**：在装有 makensis 的机器上 `npm run dist` 打真安装器并**实装/卸载验证 PATH 与 cmd**（§6 未完成部分）；便携版不进 PATH，属已知取舍。
5. 目标机器需 **Node.js 18+**（§6 风险说明）。