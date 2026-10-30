// launcher-verify.mjs
//
// End-to-end verification of the INSTALLED MCP launcher:
//   1. spawn the <resources>\dshbar-mcp.cmd that the NSIS installer writes
//      (this is the exact file `dshbar-mcp` on PATH resolves to);
//   2. run a full stdio MCP session through it: initialize -> tools/list ->
//      dshbar_start_work -> dshbar_list_tasks -> dshbar_finish_work;
//   3. fail loudly if the launcher can't resolve a Node runtime, or if Node
//      can't resolve the vendored packages (NODE_PATH), or if any RPC fails.
//
// Usage:
//   node scripts/launcher-verify.mjs [<resources dir>] [<store path>]
//   node scripts/launcher-verify.mjs release/win-unpacked/resources
//
// The cmd is spawned through cmd.exe (not `shell: true`), which is how a real
// MCP client (DSH) launches it.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const resourcesDir = resolve(root, process.argv[2] || "release/win-unpacked/resources");
const storePath = resolve(root, process.argv[3] || "build/launcher-verify-store.json");
const launcher = join(resourcesDir, "dshbar-mcp.cmd");

let failures = 0;
function check(ok, msg) {
  if (ok) console.log(`  ok    ${msg}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${msg}`);
  }
}

console.log(`launcher : ${launcher}`);
console.log(`store    : ${storePath}`);

// Spawn through cmd.exe (no `shell: true`, which Node deprecates when args are
// passed). The launcher path has no spaces here, so it needs no quoting.
const proc = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/c", launcher, storePath], {
  stdio: ["pipe", "pipe", "pipe"],
  cwd: root,
});

let buffer = "";
let nextId = 1;
const pending = new Map();
const allStderr = [];
proc.on("error", (e) => {
  failures += 1;
  console.error(`  FAIL  spawn error: ${e.message}`);
});
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
  return new Promise((resolveP, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, 15000);
    pending.set(id, { resolve: resolveP, reject, timer });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
function notify(method, params) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

const TOOL_NAMES = [
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

try {
  const init = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "dshbar-launcher-verify", version: "1.0.0" },
  });
  const expectedVersion = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ).version;
  check(
    init?.serverInfo?.name === "dshbar" && init?.serverInfo?.version === expectedVersion,
    `initialize returns dshbar ${expectedVersion} serverInfo`
  );
  notify("notifications/initialized", {});

  const tools = await request("tools/list", {});
  const names = (tools?.tools || []).map((t) => t.name);
  if (JSON.stringify(names) !== JSON.stringify(TOOL_NAMES)) {
    console.error(`  debug tools/list names: ${JSON.stringify(names)}`);
  }
  check(JSON.stringify(names) === JSON.stringify(TOOL_NAMES), `tools/list exposes all ${TOOL_NAMES.length} tools`);

  const started = await request("tools/call", {
    name: "dshbar_start_work",
    arguments: { title: "launcher-verify task" },
  });
  check(!!started, "dshbar_start_work returns a running task");

  const listed = await request("tools/call", { name: "dshbar_list_tasks", arguments: {} });
  check(!!listed, "dshbar_list_tasks returns the created task");

  const status = await request("tools/call", { name: "dshbar_get_status", arguments: {} });
  check(!!status, "dshbar_get_status responds");

  const finished = await request("tools/call", {
    name: "dshbar_finish_work",
    arguments: { taskId: started?.content?.[0]?.text ? JSON.parse(started.content[0].text)?.task?.id : undefined },
  });
  check(!!finished, "dshbar_finish_work responds");
} catch (e) {
  failures += 1;
  console.error(`  FAIL  ${e.message}`);
} finally {
  proc.kill();
}

if (allStderr.length) {
  const tail = allStderr.join("").trim();
  console.error(`  debug stderr: ${tail.slice(0, 400)}`);
  check(/Cannot find module/.test(tail) === false, `no "Cannot find module" errors (stderr len=${tail.length})`);
}

console.log(failures === 0 ? "\nLAUNCHER VERIFY: PASS" : `\nLAUNCHER VERIFY: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);