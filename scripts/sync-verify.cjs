// GUI ↔ MCP 双向同步端到端验证：
//   1. 启动 Electron GUI（DSHBAR_STORE 指向临时 store）
//   2. MCP 建一个 running 任务 → 确认 GUI 的 tick 会累加 elapsedSeconds
//   3. MCP 暂停该任务 → 确认 elapsedSeconds 停止增长
//   4. MCP 恢复该任务 → 确认 elapsedSeconds 重新增长
//   5. MCP 完成该任务 → 确认状态变 completed 且停止计时
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const CLI = path.join(ROOT, 'dist', 'mcp', 'cli.js');

// 注意：工作目录必须放在**项目内**（build/），不能用 %TEMP%。
// 某些受限环境里 Electron 进程对 %TEMP% 没有写权限，而 MCP（Node 进程）
// 有——两者就会看到不同的数据，验证结果毫无意义。
const work = fs.mkdtempSync(path.join(ROOT, 'build', 'sync-'));
const store = path.join(work, 'store.json');
const userData = path.join(work, 'userdata');

function rpc(calls) {
  const input = calls
    .map((c, i) => JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: c.method, params: c.params }))
    .join('\n');
  const res = spawnSync(NODE, [CLI, store], { input: input + '\n', encoding: 'utf8', timeout: 20000 });
  const lines = (res.stdout || '').split('\n').filter((l) => l.trim().startsWith('{'));
  return lines.map((l) => JSON.parse(l));
}

function readStore() {
  return JSON.parse(fs.readFileSync(store, 'utf8'));
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

let failures = 0;
function check(ok, msg) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${msg}`);
  if (!ok) failures += 1;
}

const init = { method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'sync-test', version: '1' } } };

// 启动 GUI。
// 注意：ELECTRON_RUN_AS_NODE 必须**删除**而不是置空 —— 置空（''）会让
// Chromium 以为该开关存在，直接硬崩溃（退出码 -2147483645，无任何日志）。
const guiEnv = { ...process.env };
delete guiEnv.ELECTRON_RUN_AS_NODE;
guiEnv.DSHBAR_STORE = store;
guiEnv.DSHBAR_USER_DATA = userData;
if (process.env.DEBUG_DSHBAR === '1') guiEnv.DEBUG_DSHBAR = '1';

const gui = spawn(ELECTRON, [ROOT, '--no-sandbox'], {
  env: guiEnv,
  stdio: 'ignore',
  detached: false,
});
sleep(6000);

try {
  // 1) MCP 建任务
  const started = rpc([
    init,
    { method: 'tools/call', params: { name: 'dshbar_start_work', arguments: { title: 'sync task', estimated_seconds: 600 } } },
  ]).pop();
  const task = JSON.parse(started.result.content[0].text).task;
  check(task && task.status === 'running', `MCP start_work created a running task (id=${task && task.id})`);

  // 2) GUI tick 累加
  sleep(6000);
  const snap = readStore().tasks[0];
  const e1 = snap.elapsedSeconds;
  check(
    e1 >= 4,
    `GUI tick advances elapsedSeconds while running (elapsed=${e1}, startedAt=${snap.startedAt})`,
  );

  // 3) 暂停后停止增长
  rpc([init, { method: 'tools/call', params: { name: 'dshbar_pause_work', arguments: { task_id: task.id } } }]);
  sleep(1500);
  const p1 = readStore().tasks[0].elapsedSeconds;
  sleep(6000);
  const p2 = readStore().tasks[0].elapsedSeconds;
  check(Math.abs(p2 - p1) < 1.5, `paused task stops accumulating (${p1} -> ${p2})`);

  // 4) 恢复后重新增长
  rpc([init, { method: 'tools/call', params: { name: 'dshbar_resume_work', arguments: { task_id: task.id } } }]);
  sleep(6000);
  const r1 = readStore().tasks[0].elapsedSeconds;
  check(r1 > p2 + 2, `resumed task accumulates again (${p2} -> ${r1})`);

  // 5) 完成后停止计时
  rpc([init, { method: 'tools/call', params: { name: 'dshbar_finish_work', arguments: { task_id: task.id, note: 'done' } } }]);
  sleep(1500);
  const f1 = readStore().tasks[0];
  check(f1.status === 'completed', `finish_work marks the task completed (status=${f1.status})`);
  sleep(5000);
  const f2 = readStore().tasks[0];
  check(Math.abs(f2.elapsedSeconds - f1.elapsedSeconds) < 1, `completed task stops the timer (${f1.elapsedSeconds} -> ${f2.elapsedSeconds})`);
} catch (e) {
  failures += 1;
  console.error('  FAIL  ' + e.message);
} finally {
  try { gui.kill(); } catch {}
  try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
}

console.log(failures === 0 ? '\nSYNC VERIFY: PASS' : `\nSYNC VERIFY: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);