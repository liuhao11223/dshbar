// 一键构建 + 生成 win-unpacked（用于本地验证）。
// 用法：node scripts/build-and-dir.cjs [--out <目录名>]
//
// 如果 release\win-unpacked 被正在运行的 DSHBar 占用（Windows 报 EBUSY），
// 会自动改到 release-<时间戳>\win-unpacked 继续构建，不会中断。
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const NODE = process.execPath;
const ROOT = path.resolve(__dirname, '..');

const env = {
  ...process.env,
  ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
};

function run(script, extraArgs = []) {
  console.log('>', script, extraArgs.join(' '));
  execFileSync(NODE, [...script.split(' '), ...extraArgs], {
    cwd: ROOT,
    env,
    stdio: 'inherit',
  });
}

// --out <dir>：手动指定输出目录名（相对仓库根目录）
const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const explicitOut = outIdx >= 0 ? argv[outIdx + 1] : null;

run('node_modules/typescript/bin/tsc -p tsconfig.json');
run('node_modules/typescript/bin/tsc -p tsconfig.renderer.json');
run('scripts/copy-renderer-assets.mjs');
run('scripts/build-mcp-bundle.cjs');

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

const builderArgs = ['node_modules/electron-builder/out/cli/cli.js', '--win', '--dir', '--publish', 'never'];

let outDir;
if (explicitOut) {
  outDir = explicitOut;
  run(builderArgs[0], [...builderArgs.slice(1), '--config.directories.output', explicitOut]);
} else {
  try {
    run(builderArgs[0], builderArgs.slice(1));
    outDir = 'release';
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (!/EBUSY|resource busy|EPERM|locked/i.test(msg)) throw err;
    outDir = `release-${stamp()}`;
    console.warn('');
    console.warn('! release\\win-unpacked 正被运行中的 DSHBar 占用，改装到', outDir);
    console.warn('  （关掉 DSHBar 后重跑不带参数即可覆盖 release）');
    console.warn('');
    run(builderArgs[0], [...builderArgs.slice(1), '--config.directories.output', outDir]);
  }
}

// 把「兼容模式」启动器一并放进产物目录，方便 GPU 异常的机器直接用。
const targetDir = path.join(ROOT, outDir, 'win-unpacked');
const launcher = path.join(ROOT, 'DSHBar-兼容模式.cmd');
if (fs.existsSync(launcher) && fs.existsSync(targetDir)) {
  fs.copyFileSync(launcher, path.join(targetDir, 'DSHBar-兼容模式.cmd'));
  console.log(`copied DSHBar-兼容模式.cmd -> ${outDir}/win-unpacked/`);
}

console.log(`BUILD+DIR OK -> ${outDir}\\win-unpacked`);
