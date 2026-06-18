// Doctor smoke check: spawns ONE real worker via the worker-manager, waits for
// health, dispatches a bash task, asserts the tool completes (not hangs), then
// cleans up. Catches spawn/permission/wt.exe regressions before you hit them.
//
// Usage: npm run doctor
import { WorkerManager } from "../dist/worker-manager.js";
import { OpencodeClient } from "../dist/opencode-client.js";

const PORT = 4310;
const ROLE = "frontend";
const CWD = process.cwd();

function log(ok, msg) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${msg}`);
}

async function waitHealthy(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await client.isHealthy()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function main() {
  const spec = { name: ROLE, port: PORT, cwd: CWD, agent: ROLE, model: null, attach: false };
  const mgr = new WorkerManager([spec]);
  const client = new OpencodeClient(`http://127.0.0.1:${PORT}`);
  let failed = false;

  console.log(`[doctor] spawning ${ROLE} worker on ${PORT} ...`);
  mgr.spawnOne(ROLE);

  try {
    const healthy = await waitHealthy(client, 60000);
    log(healthy, "worker became healthy");
    if (!healthy) { failed = true; throw new Error("worker never healthy"); }

    const sessionID = await client.createSession("doctor smoke");
    log(!!sessionID, `created session ${sessionID}`);

    await client.promptAsync(
      sessionID,
      "Run a bash command: echo DOCTOR_OK. Then reply with exactly DONE. Do not read files.",
      ROLE,
      null,
    );
    console.log("[doctor] prompt sent; waiting up to 40s for the bash tool to complete ...");

    const deadline = Date.now() + 40000;
    let toolCompleted = false;
    while (Date.now() < deadline) {
      const res = await fetch(`http://127.0.0.1:${PORT}/session/${sessionID}/message`);
      const msgs = await res.json();
      const tools = (Array.isArray(msgs) ? msgs : []).flatMap((m) => m.parts || []).filter((p) => p.type === "tool");
      if (tools.some((t) => t.state?.status === "completed")) { toolCompleted = true; break; }
      if (tools.some((t) => t.state?.status === "error")) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    log(toolCompleted, "bash tool completed (no permission hang)");
    if (!toolCompleted) failed = true;
  } catch (err) {
    failed = true;
    console.error("[doctor] error:", err.message);
  } finally {
    console.log("[doctor] cleaning up worker ...");
    mgr.killOne(ROLE);
  }

  console.log(failed ? "\n[doctor] RESULT: FAIL" : "\n[doctor] RESULT: OK");
  // Give the kill a moment, then exit with the right code.
  setTimeout(() => process.exit(failed ? 1 : 0), 1500);
}

main();
