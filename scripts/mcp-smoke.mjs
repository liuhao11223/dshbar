/**
 * DSHBar MCP 冒烟测试脚本（无第三方依赖）。
 *
 * 流程：
 *   1. 用 child_process spawn 启动 `node dist/mcp/cli.js <tmp store>`
 *   2. 按 MCP stdio 协议（newline-delimited JSON）发送 initialize / notifications/initialized
 *   3. tools/list 校验工具表；tools/call 依次调 dshbar_start_work / dshbar_list_tasks / dshbar_finish_work
 *   4. 检查返回结构，然后关闭 stdin
 *   5. 断言进程以退出码 0 优雅退出
 *
 * 运行：node scripts/mcp-smoke.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const cliPath = join(root, "dist", "mcp", "cli.js");
const tmpDir = mkdtempSync(join(tmpdir(), "dshbar-mcp-smoke-"));
const storePath = join(tmpDir, "store.json");

let failures = 0;
function check(label, cond, extra = "") {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label} ${extra}`);
  }
}

function fail(msg) {
  failures += 1;
  console.error(`  FAIL  ${msg}`);
}

const proc = spawn(process.execPath, [cliPath, storePath], {
  stdio: ["pipe", "pipe", "pipe"],
  cwd: root,
});

let buffer = "";
let nextId = 1;
const pending = new Map(); // id -> { resolve, reject, timer }
const allStderr = [];

proc.stderr.on("data", (d) => allStderr.push(d.toString("utf-8")));

proc.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf-8");
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id != null && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`rpc error: ${JSON.stringify(msg.error)}`));
      else p.resolve(msg.result);
    }
  }
});

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, 10000);
    pending.set(id, { resolve, reject, timer });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function notify(method, params) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

const exitCode = new Promise((resolve) => proc.on("exit", resolve));

try {
  // 1) initialize
  const init = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "dshbar-smoke", version: "1.0.0" },
  });
  const EXPECTED_VERSION = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ).version;
  check(
    "initialize returns serverInfo",
    init?.serverInfo?.name === "dshbar" && init?.serverInfo?.version === EXPECTED_VERSION,
    JSON.stringify(init),
  );
  notify("notifications/initialized", {});

  // 2) tools/list
  const tools = await request("tools/list", {});
  const names = (tools?.tools ?? []).map((t) => t.name);
  const expected = [
    "dshbar_start_work",
    "dshbar_pause_work",
    "dshbar_resume_work",
    "dshbar_finish_work",
    "dshbar_abort_work",
    "dshbar_add_tasks",
    "dshbar_list_tasks",
    "dshbar_update_task",
    "dshbar_reorder_tasks",
    "dshbar_delete_task",
    "dshbar_get_status",
  ];
  check(
    "tools/list exposes all 11 tools",
    expected.every((n) => names.includes(n)),
    `missing=${expected.filter((n) => !names.includes(n)).join(",")}`,
  );

  // 3) dshbar_start_work
  const started = await request("tools/call", {
    name: "dshbar_start_work",
    arguments: { title: "冒烟测试任务", estimated_seconds: 3600 },
  });
  const startedText = started?.content?.[0]?.text;
  const startedJson = JSON.parse(startedText);
  check(
    "dshbar_start_work returns a running task",
    startedJson?.ok === true && startedJson?.task?.status === "running" && typeof startedJson.task.id === "string",
    startedText,
  );
  const taskId = startedJson?.task?.id;

  // 4) dshbar_list_tasks
  const listed = await request("tools/call", {
    name: "dshbar_list_tasks",
    arguments: { status: "all", limit: 10 },
  });
  const listedJson = JSON.parse(listed?.content?.[0]?.text);
  check(
    "dshbar_list_tasks returns snapshot including the running task",
    listedJson?.ok === true && Array.isArray(listedJson?.tasks) && listedJson.tasks.length === 1 && listedJson.tasks[0].id === taskId,
    JSON.stringify(listedJson),
  );

  // 5) dshbar_finish_work
  const finished = await request("tools/call", {
    name: "dshbar_finish_work",
    arguments: { task_id: taskId, note: "smoke ok" },
  });
  const finishedJson = JSON.parse(finished?.content?.[0]?.text);
  check(
    "dshbar_finish_work marks task completed with note",
    finishedJson?.ok === true && finishedJson?.task?.status === "completed" && finishedJson?.task?.note === "smoke ok",
    JSON.stringify(finishedJson),
  );

  // 6) dshbar_get_status
  const status = await request("tools/call", { name: "dshbar_get_status", arguments: {} });
  const statusJson = JSON.parse(status?.content?.[0]?.text);
  check(
    "dshbar_get_status reports counts and recent completed",
    statusJson?.ok === true && statusJson?.counts?.completed === 1 && Array.isArray(statusJson?.recent_completed) && statusJson.recent_completed.length === 1,
    JSON.stringify(statusJson),
  );

  // 7) 关闭 stdin，期望优雅退出且退出码 0
  proc.stdin.end();
  const code = await Promise.race([
    exitCode,
    new Promise((r) => setTimeout(() => r("TIMEOUT"), 10000)),
  ]);
  check("process exits cleanly with code 0", code === 0, `exit=${code}`);
} catch (err) {
  fail(`unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  try {
    proc.kill("SIGTERM");
  } catch {
    /* ignore */
  }
}

if (allStderr.length) {
  console.error("--- server stderr ---");
  for (const line of allStderr) process.stderr.write(line);
}

console.log(failures === 0 ? "\nSMOKE OK" : `\nSMOKE FAILED (${failures} failure(s))`);
process.exit(failures === 0 ? 0 : 1);
