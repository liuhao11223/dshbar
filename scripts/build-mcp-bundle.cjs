#!/usr/bin/env node
/**
 * build-mcp-bundle.cjs
 *
 * Produces a self-contained MCP runtime folder that plain Node.js can execute
 * WITHOUT the DSHBar electron.exe and WITHOUT reading anything from app.asar.
 *
 * Why this exists
 *   DSH launches the DSHBar MCP server by running `dshbar-mcp` on PATH, which
 *   resolves to <installDir>\resources\dshbar-mcp.cmd -> a Node process running
 *   <installDir>\resources\dshbar-mcp\dist\mcp\cli.js.
 *
 *   cli.js is compiled by tsc and requires, at runtime:
 *     - relative modules: ../shared/store            (project code)
 *     - bare specifiers : @modelcontextprotocol/sdk/server/index.js,
 *                         @modelcontextprotocol/sdk/server/stdio.js,
 *                         @modelcontextprotocol/sdk/types.js, zod
 *   Plain Node resolves those from <script dir>/node_modules. But the CLI source
 *   also lives inside app.asar, which plain Node cannot read. So we copy the
 *   exact runtime closure of the CLI into a plain directory on disk:
 *
 *     build/mcp-runtime/
 *       dist/mcp/cli.js
 *       dist/shared/*.js
 *       vendor/...      (only the packages the closure actually touches)
 *
 *   electron-builder then ships it with
 *       extraResources: [ { from: "build/mcp-runtime", to: "dshbar-mcp" } ]
 *   so on a target machine the files land at
 *       <installDir>\resources\dshbar-mcp\dist\mcp\cli.js
 *       <installDir>\resources\dshbar-mcp\dist\shared\*.js
 *       <installDir>\resources\dshbar-mcp\vendor\...
 *   The `../shared/store` require still resolves (both live under dist/), and
 *   bare specifiers resolve through vendor/ because the launcher exports
 *   NODE_PATH=<installDir>\resources\dshbar-mcp\vendor before running node.
 *   Nothing needs app.asar.
 *
 *   NOTE on the folder name: electron-builder hard-codes a node_modules
 *   exclusion into every extraResources FileMatcher (app-builder-lib/out/
 *   fileMatcher.js, pattern !**\node_modules\**), so a closure shipped under
 *   the name `node_modules` would be silently dropped. We therefore ship it as
 *   `vendor/` and bridge the module-resolution gap with NODE_PATH. The closure
 *   has no nested node_modules (verified), so `vendor/` is the only name that
 *   needed to change.
 *
 * Closure strategy
 *   A static require-walk from the entry file. @modelcontextprotocol/sdk has no
 *   dynamic `require(<expr>)` calls (verified), so a literal-require walk is
 *   complete for the modules our transport (server/stdio.js) actually pulls in.
 *   Unresolvable bare specifiers are treated as optional dependencies and
 *   skipped, so the huge optional server transports (express/hono/...) are not
 *   bundled unless they are really required.
 *
 * Usage
 *   node scripts/build-mcp-bundle.cjs [--out <dir>] [--self-test]
 *
 * `--self-test` additionally boots the produced cli.js with plain node and
 * verifies an MCP `initialize` round-trip, so you can trust the bundle before
 * packaging.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'dist', 'mcp', 'cli.js');
const DEFAULT_OUT = path.join(ROOT, 'build', 'mcp-runtime');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
function opt(name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const OUT = path.resolve(opt('--out', DEFAULT_OUT));

const PROJECT_DIST = path.join(ROOT, 'dist');
const NM_ROOT = path.join(ROOT, 'node_modules');

// --------------------------------------------------------------------------
// require-walk
// --------------------------------------------------------------------------
const visitedFiles = new Set(); // absolute real file paths already scanned
const packageDirs = new Set(); // absolute package dirs to copy

function isInsideNodeModules(file) {
  const rel = path.relative(NM_ROOT, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Return the package directory (absolute) containing `file`, if any. */
function packageDirOf(file) {
  let dir = path.dirname(file);
  for (;;) {
    if (path.basename(dir) === 'node_modules') {
      // the package is the first path component(s) right after node_modules
      const rel = path.relative(dir, file);
      if (!rel || rel.startsWith('..')) return null;
      const parts = rel.split(path.sep);
      const name = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
      return path.join(dir, name);
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function recordPackage(file) {
  const pkg = packageDirOf(file);
  if (!pkg) return;
  if (!isInsideNodeModules(pkg)) return;
  packageDirs.add(pkg);
}

const LITERAL_RE = /require\(\s*(['"])([^'"]+)\1\s*\)/g;

function walk(file) {
  if (visitedFiles.has(file)) return;
  visitedFiles.add(file);

  let src;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }

  let m;
  LITERAL_RE.lastIndex = 0;
  while ((m = LITERAL_RE.exec(src)) !== null) {
    const request = m[2];
    if (request.startsWith('node:')) continue;
    const resolved = resolveOne(file, request);
    if (!resolved) continue; // optional dep not installed -> skip
    walk(resolved);
  }
  recordPackage(file);
}

function resolveOne(fromFile, request) {
  try {
    if (request.startsWith('.')) {
      return require.resolve(path.resolve(path.dirname(fromFile), request));
    }
    // bare specifier — resolve relative to the requiring file
    return require.resolve(request, { paths: [path.dirname(fromFile)] });
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------
// copy
// --------------------------------------------------------------------------
function copyDir(from, to) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isSymbolicLink()) {
      try {
        fs.copyFileSync(fs.realpathSync(s), d);
      } catch {
        /* skip broken links */
      }
    } else fs.copyFileSync(s, d);
  }
}

function main() {
  if (!fs.existsSync(ENTRY)) {
    console.error(`[build-mcp-bundle] entry not found: ${ENTRY}`);
    console.error('[build-mcp-bundle] run `npm run build` first (tsc compiles src -> dist).');
    process.exit(1);
  }

  // 1. walk
  walk(ENTRY);

  if (packageDirs.size === 0) {
    console.error('[build-mcp-bundle] no node_modules packages resolved — unexpected.');
    process.exit(1);
  }

  // 2. clear + rebuild output
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  // project code the CLI needs. Only the subtrees it actually requires
  // (dist/mcp + dist/shared, mirroring the dist/ layout so `../shared/store`
  // keeps resolving). The GUI code (main/preload/renderer) stays out.
  copyDir(path.join(PROJECT_DIST, 'mcp'), path.join(OUT, 'dist', 'mcp'));
  copyDir(path.join(PROJECT_DIST, 'shared'), path.join(OUT, 'dist', 'shared'));

  // cli.ts 运行时从 <bundle 根>\package.json 读版本号（单一事实来源），
  // 打包目录里没有它就只能退回 '0.0.0'，所以把项目 package.json 拷进来。
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(OUT, 'package.json'));

  // vendor closure. Named `vendor`, NOT `node_modules`: electron-builder
  // hard-codes `!**/node_modules/**` into every extraResources FileMatcher
  // (app-builder-lib/out/fileMatcher.js), so a closure shipped as
  // `node_modules` is silently dropped from the package. Node still resolves
  // bare specifiers from it as long as the launcher sets NODE_PATH to it.
  const pkgList = [...packageDirs].sort();
  for (const pkg of pkgList) {
    const rel = path.relative(NM_ROOT, pkg);
    copyDir(pkg, path.join(OUT, 'vendor', rel));
  }

  // report
  let bytes = 0;
  const count = (dir) => {
    let n = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) n += count(p);
      else {
        n++;
        bytes += fs.statSync(p).size;
      }
    }
    return n;
  };
  const fileCount = count(OUT);
  console.log(
    `[build-mcp-bundle] ${fileCount} files, ${(bytes / 1048576).toFixed(2)} MB -> ${OUT}`
  );
  console.log(`[build-mcp-bundle] vendor packages copied: ${pkgList.length}`);
  console.log(`[build-mcp-bundle] cli.js: ${path.join(OUT, 'dist', 'mcp', 'cli.js')}`);

  if (flag('--self-test')) selfTest();
}

// --------------------------------------------------------------------------
// self-test: boot the bundled cli.js with plain node, run one MCP round-trip
// --------------------------------------------------------------------------
function selfTest() {
  const cli = path.join(OUT, 'dist', 'mcp', 'cli.js');
  const node = process.execPath;
  // Use a store path inside the workspace output dir, not %TEMP%: sandboxed
  // environments may deny writes under the user temp folder.
  const storeFile = path.join(OUT, '.self-test-store.json');
  fs.rmSync(storeFile, { force: true });
  const res = spawnSync(node, [cli, storeFile], {
    input:
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'build-mcp-bundle', version: '0.0.0' },
        },
      }) + '\n',
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, NODE_PATH: path.join(OUT, 'vendor') },
  });

  let out = (res.stdout || '') + (res.stderr || '');
  const stdoutText = res.stdout || '';
  const found =
    /"serverInfo"/.test(stdoutText) && /"id"\s*:\s*1/.test(stdoutText) && /"dshbar"/.test(stdoutText);
  if (!found) {
    console.error('[build-mcp-bundle] SELF-TEST FAILED');
    console.error('[build-mcp-bundle] stdout:', (res.stdout || '').slice(0, 600));
    console.error('[build-mcp-bundle] stderr:', (res.stderr || '').slice(0, 600));
    console.error('[build-mcp-bundle] status:', res.status, 'signal:', res.signal);
    process.exit(1);
  }
  console.log('[build-mcp-bundle] SELF-TEST PASS (initialize round-trip via plain node)');
  try {
    fs.rmSync(storeFile, { force: true });
  } catch {
    /* ignore */
  }
  void out;
}

main();