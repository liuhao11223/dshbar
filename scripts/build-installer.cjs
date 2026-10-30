// 构建 NSIS 安装器（一键，带镜像环境变量）。
//
// 用法：D:\node\node.exe scripts\build-installer.cjs
//
// 注意：必须用真实 node.exe 调用本脚本。本机 PATH 上的 `node` 是 harness 的
// node.cmd 垫片（内部 ELECTRON_RUN_AS_NODE=1 后调 DSH Desktop.exe），会让
// electron-builder 的 yargs 误解析 argv 并失败。
//
// electron-builder 的 NSIS 流程分两步：
//   1. 编译脚本 + 生成 __uninstaller.exe —— 需要**执行**刚生成的安装器来产出卸载器；
//   2. 把卸载器嵌进最终安装包。
// 第 1 步在禁止启动 GUI/安装器进程的受限环境里会失败（`process failed 2`），
// 此时脚本会打印明确提示，而不是伪装成成功。
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;

const env = {
  ...process.env,
  ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
};

function run(script, args) {
  console.log('>', script, ...args);
  execFileSync(NODE, [script, ...args], { cwd: ROOT, env, stdio: 'inherit' });
}

// 1. 编译 + 生成 MCP 运行目录
run('node_modules/typescript/bin/tsc', ['-p', 'tsconfig.json']);
run('node_modules/typescript/bin/tsc', ['-p', 'tsconfig.renderer.json']);
run('scripts/copy-renderer-assets.mjs', []);
run('scripts/build-mcp-bundle.cjs', []);

// 2. 打 NSIS 安装器
try {
  run('node_modules/electron-builder/out/cli/cli.js', ['--win', 'nsis', '--publish', 'never']);
} catch (err) {
  console.error('');
  console.error('[build-installer] NSIS 打包失败。');
  console.error('[build-installer] 若错误是 `... Setup x.y.z.exe process failed 2`，说明');
  console.error('[build-installer] electron-builder 需要**执行**刚生成的安装器来产出卸载器，');
  console.error('[build-installer] 而当前环境禁止启动安装器进程。');
  console.error('[build-installer] 在普通 Windows 桌面会话里重跑本脚本即可；');
  console.error('[build-installer] 或者直接用 `node scripts/build-and-dir.cjs` 的产物。');
  process.exit(1);
}

const out = fs
  .readdirSync(path.join(ROOT, 'release'))
  .filter((n) => n.toLowerCase().endsWith('.exe'));
console.log('[build-installer] OK:', out.join(', '));
