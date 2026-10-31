// 构建免安装单文件（portable）。
// 用法：node scripts/build-portable.cjs [--out <目录名>]
//
// 与 build-and-dir.cjs 相同的容错策略：release 被运行中的 DSHBar 占用时，
// 自动改到 release-<时间戳> 继续，不会中断。
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

const builder = 'node_modules/electron-builder/out/cli/cli.js';
const baseArgs = ['--win', 'portable', '--publish', 'never'];

let outDir;
if (explicitOut) {
  outDir = explicitOut;
  run(builder, [...baseArgs, '--config.directories.output', explicitOut]);
} else {
  try {
    run(builder, baseArgs);
    outDir = 'release';
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (!/EBUSY|resource busy|EPERM|locked/i.test(msg)) throw err;
    outDir = `release-${stamp()}`;
    console.warn('');
    console.warn('! release\\win-unpacked 正被运行中的 DSHBar 占用，改装到', outDir);
    console.warn('');
    run(builder, [...baseArgs, '--config.directories.output', outDir]);
  }
}

// 按当前版本过滤：目录里可能留着旧版本产物，取错文件名会误导人。
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).version;
const exe = fs
  .readdirSync(path.join(ROOT, outDir))
  .filter((f) => f.toLowerCase().endsWith('.exe') && f.includes('portable') && f.includes(VERSION))[0];
if (exe) {
  const full = path.join(ROOT, outDir, exe);
  console.log(`PORTABLE OK -> ${outDir}\\${exe} (${(fs.statSync(full).size / 1024 / 1024).toFixed(1)} MB)`);
} else {
  console.log(`PORTABLE OK -> ${outDir}`);
}
