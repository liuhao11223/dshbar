// 构建离线 NSIS 安装器（不依赖 electron-builder 的「执行安装包产出卸载器」步骤）。
//
// 用法：D:\node\node.exe scripts\build-standalone-installer.cjs [--appdir <win-unpacked>] [--out <目录>]
//
// 背景：electron-builder 的 NSIS 流程编译完安装包后，必须**执行它一次**来预产出
// 内嵌卸载器；在受限 / 无桌面 / CI 会话里这一步必然失败（process failed 2）。
// 本脚本改用标准 NSIS 做法：build/installer-standalone.nsi 里用 WriteUninstaller
// 在安装时写出卸载器，编译期不需要执行安装包，makensis 直接从本地缓存运行。
//
// 步骤：
//   1. 完整编译（tsc ×2 + 渲染资源 + MCP bundle）；
//   2. electron-builder --dir 产出 win-unpacked（若目标被运行中的 DSHBar 锁住，
//      自动改装 release-installer，与 build-and-dir.cjs 的容错一致）；
//   3. makensis 编译独立安装器 -> <out>\DSHBar Setup <version>.exe。
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const NODE = process.execPath;
const ROOT = path.resolve(__dirname, '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).version;

const env = {
  ...process.env,
  ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
};

const argv = process.argv.slice(2);
function flagVal(name, dflt) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}

function run(cmd, args, opts = {}) {
  console.log('>', path.relative(ROOT, cmd) || cmd, ...args);
  execFileSync(cmd, args, { cwd: ROOT, env, stdio: 'inherit', ...opts });
}

// ---- 1. 找到本地缓存的 makensis（electron-builder 之前下载过就离线可用） ----
function findMakensis() {
  const cache = path.join(
    process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local'),
    'electron-builder',
    'Cache',
  );
  const hits = [];
  const scan = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      if (/^nsis-\d/.test(e.name)) {
        for (const sub of fs.readdirSync(p)) {
          const mk = path.join(p, sub, 'Bin', 'makensis.exe');
          if (fs.existsSync(mk)) hits.push(mk);
        }
      } else if (e.name !== 'downloads') {
        try { scan(p); } catch { /* 忽略 */ }
      }
    }
  };
  if (fs.existsSync(cache)) scan(cache);
  hits.sort();
  return hits[hits.length - 1] || null;
}

// ---- 2. 编译 ----
run(NODE, [path.join('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json']);
run(NODE, [path.join('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.renderer.json']);
run(NODE, [path.join('scripts', 'copy-renderer-assets.mjs')]);
run(NODE, [path.join('scripts', 'build-mcp-bundle.cjs')]);

// ---- 3. win-unpacked ----
const builder = path.join(ROOT, 'node_modules/electron-builder/out/cli/cli.js');
let appDir = flagVal('--appdir', null);
if (!appDir) {
  const outName = flagVal('--out', 'release-installer');
  try {
    run(NODE, [builder, '--win', '--dir', '--publish', 'never', `--config.directories.output=${outName}`]);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (!/EBUSY|resource busy|EPERM|locked/i.test(msg)) throw err;
    console.warn('! 目标目录被运行中的 DSHBar 占用，改装 release-installer');
    run(NODE, [builder, '--win', '--dir', '--publish', 'never', '--config.directories.output=release-installer']);
  }
  appDir = path.join(ROOT, outName, 'win-unpacked');
}

// ---- 4. makensis ----
const makensis = process.env.DSHBAR_MAKENSIS || findMakensis();
if (!makensis) {
  console.error('[installer] 找不到本地缓存的 makensis.exe。先跑一次 `npm run dist`（需联网）或');
  console.error('[installer] 设置环境变量 DSHBAR_MAKENSIS=<makensis.exe 路径> 后重试。');
  process.exit(1);
}

// NSIS 3.x 的 unicode makensis 要求脚本带 UTF-8 BOM（中文注释）。
const nsi = path.join(ROOT, 'build', 'installer-standalone.nsi');
const raw = fs.readFileSync(nsi);
if (raw[0] !== 0xef || raw[1] !== 0xbb || raw[2] !== 0xbf) {
  fs.writeFileSync(nsi, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), raw]));
  console.log('[installer] 已给 installer-standalone.nsi 补 UTF-8 BOM');
}

const outDir = path.dirname(appDir); // <out>\win-unpacked -> <out>
run(makensis, [
  `/DVERSION=${VERSION}`,
  `/DAPPDIR=${appDir}`,
  `/DOUTFILE=${outDir}`,
  `/DICON=${path.join(ROOT, 'assets', 'icon.ico')}`,
  nsi,
]);

const setup = path.join(outDir, `DSHBar Setup ${VERSION}.exe`);
if (fs.existsSync(setup)) {
  console.log(`INSTALLER OK -> ${setup} (${(fs.statSync(setup).size / 1048576).toFixed(1)} MB)`);
} else {
  console.error('INSTALLER MISSING:', setup);
  process.exit(1);
}
