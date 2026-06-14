import { appendFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { OpencodeClient } from "./opencode-client.js";
import { StatusBoard } from "./status-board.js";
import { WorkerManager } from "./worker-manager.js";
import { Orchestrator } from "./orchestrator.js";
import { MessageBus, type WorkerHandle } from "./bus.js";
import { listenToWorker, type OpencodeEvent } from "./event-listener.js";
import { startMcpServer } from "./mcp-server.js";
import type { WorkerSpec } from "./types.js";

const MCP_PORT = 4100;

/** SSE→verify bridge: when a worker's session goes idle, verify its job. */
export async function handleWorkerEvent(
  board: StatusBoard,
  orchestrator: Pick<Orchestrator, "verify">,
  _workerName: string,
  event: OpencodeEvent,
): Promise<void> {
  if (event.type !== "session.idle") return;
  const sessionID = event.properties.sessionID;
  if (!sessionID) return;
  const job = board.findBySession(sessionID);
  if (job) await orchestrator.verify(job.id);
}

export async function main(): Promise<void> {
  const cfg = loadConfig();
  const board = new StatusBoard((line) => appendFileSync("hub.log", line + "\n"));

  const clients = new Map<string, OpencodeClient>();
  const baseUrls = new Map<string, string>();
  for (const w of cfg.workers) {
    const url = `http://127.0.0.1:${w.port}`;
    baseUrls.set(w.name, url);
    clients.set(w.name, new OpencodeClient(url));
  }

  const clientFor = (role: string): OpencodeClient => {
    const c = clients.get(role);
    if (!c) throw new Error(`no client for role: ${role}`);
    return c;
  };

  const orchestrator = new Orchestrator(board, clientFor);

  // Bus resolver: map worker name -> handle that delivers via its active session.
  const resolver = (name: string): WorkerHandle | null => {
    const job = board.getAll().find((j) => j.role === name && j.sessionID);
    const client = clients.get(name);
    if (!job || !job.sessionID || !client) return null;
    const sessionID = job.sessionID;
    return { sessionID, deliver: (text: string) => client.promptAsync(sessionID, text) };
  };
  const bus = new MessageBus(resolver, cfg.workers.map((w) => w.name));

  // Spawn worker terminals.
  const manager = new WorkerManager(cfg.workers);
  manager.spawnAll();

  // Wait for each worker to become healthy, then listen to its events.
  await waitForWorkers(cfg.workers, clients);
  for (const w of cfg.workers) {
    listenToWorker(w.name, baseUrls.get(w.name)!, (name, ev) => {
      void handleWorkerEvent(board, orchestrator, name, ev);
    });
  }

  const stopMcp = await startMcpServer({ board, orchestrator, bus }, MCP_PORT);
  console.log(`Hub MCP server listening on http://localhost:${MCP_PORT}/mcp`);

  process.on("SIGINT", () => {
    stopMcp();
    process.exit(0);
  });
}

async function waitForWorkers(
  workers: WorkerSpec[],
  clients: Map<string, OpencodeClient>,
  timeoutMs = 60000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (const w of workers) {
    const client = clients.get(w.name)!;
    while (Date.now() < deadline) {
      if (await client.isHealthy()) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// Entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
