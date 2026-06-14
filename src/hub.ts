import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadConfig, MCP_PORT } from "./config.js";
import { OpencodeClient } from "./opencode-client.js";
import { StatusBoard } from "./status-board.js";
import { WorkerManager } from "./worker-manager.js";
import { Orchestrator } from "./orchestrator.js";
import { MessageBus, type WorkerHandle } from "./bus.js";
import { listenToWorker, type OpencodeEvent } from "./event-listener.js";
import { startMcpServer } from "./mcp-server.js";
import { startDashboard } from "./dashboard.js";
import type { WorkerSpec } from "./types.js";

const DASHBOARD_PORT = 4099;

/** SSE→verify bridge: when a worker's session goes idle, verify its job. */
export async function handleWorkerEvent(
  board: StatusBoard,
  orchestrator: Pick<Orchestrator, "verify">,
  workerName: string,
  event: OpencodeEvent,
): Promise<void> {
  try {
    if (event.type !== "session.idle") return;
    const sessionID = event.properties.sessionID;
    if (!sessionID) return;
    const job = board.findLatestBySession(sessionID);
    if (job) await orchestrator.verify(job.id);
  } catch (err) {
    // Best-effort: never reject so the SSE listener's fire-and-forget call
    // (void handleWorkerEvent) can't become an unhandled rejection.
    console.error(`handleWorkerEvent failed for worker ${workerName}:`, err);
  }
}

export async function main(): Promise<void> {
  // Config path precedence: CLI arg (process.argv[2]) > HUB_CONFIG env > default.
  const cfg = loadConfig(process.argv[2]);
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

  // Map each role to the opencode agent persona it should run as (from config).
  const agentByRole = new Map(cfg.workers.map((w) => [w.name, w.agent] as const));
  const agentFor = (role: string): string | null => agentByRole.get(role) ?? null;

  const orchestrator = new Orchestrator(board, clientFor, agentFor);

  // Bus resolver: map a known worker name -> handle that delivers via its
  // session, creating one if the worker hasn't been dispatched a task yet.
  // Returns null only for names not in the configured roster.
  const knownWorkers = new Set(cfg.workers.map((w) => w.name));
  const resolver = async (name: string): Promise<WorkerHandle | null> => {
    if (!knownWorkers.has(name)) return null;
    return orchestrator.ensureSession(name);
  };
  const bus = new MessageBus(resolver, cfg.workers.map((w) => w.name));

  // Spawn worker terminals.
  const manager = new WorkerManager(cfg.workers);
  manager.spawnAll();

  // Tracks last-known health per worker; shared with the dashboard (Tier 3).
  const health = new Map<string, boolean>();

  // Wait for each worker to become healthy, then listen to its events.
  const startup = await waitForWorkers(cfg.workers, clients);
  for (const name of startup.healthy) health.set(name, true);
  for (const name of startup.unhealthy) {
    health.set(name, false);
    console.warn(`[startup] worker ${name} did not become healthy within timeout`);
  }
  if (startup.unhealthy.length > 0) {
    console.warn(
      `[startup] ${startup.unhealthy.length}/${cfg.workers.length} workers unhealthy: ${startup.unhealthy.join(", ")}`,
    );
  }

  const stopListeners: Array<() => void> = [];
  for (const w of cfg.workers) {
    const stop = listenToWorker(w.name, baseUrls.get(w.name)!, (name, ev) => {
      void handleWorkerEvent(board, orchestrator, name, ev);
    });
    stopListeners.push(stop);
  }

  // Periodic health watch: restart a worker's tab when it transitions to unhealthy.
  const healthTimer = setInterval(() => {
    void runHealthCheck(cfg.workers, clients, manager, health);
  }, 15000);

  const stopMcp = await startMcpServer({ board, orchestrator, bus }, MCP_PORT);
  console.log(`Hub MCP server listening on http://127.0.0.1:${MCP_PORT}/mcp`);

  const stopDashboard = await startDashboard(
    { board, workerNames: cfg.workers.map((w) => w.name), health },
    DASHBOARD_PORT,
  );
  console.log(`Hub dashboard at http://127.0.0.1:${DASHBOARD_PORT}`);

  process.on("SIGINT", () => {
    clearInterval(healthTimer);
    for (const stop of stopListeners) stop();
    stopMcp();
    stopDashboard();
    process.exit(0);
  });

  process.on("unhandledRejection", (reason) => console.error("unhandledRejection:", reason));
}

interface HealthClient {
  isHealthy(): Promise<boolean>;
}

export interface StartupHealth {
  healthy: string[];
  unhealthy: string[];
}

async function waitForWorkers(
  workers: WorkerSpec[],
  clients: Map<string, HealthClient>,
  timeoutMs = 60000,
): Promise<StartupHealth> {
  const results = await Promise.all(
    workers.map(async (w): Promise<{ name: string; healthy: boolean }> => {
      const client = clients.get(w.name)!;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await client.isHealthy()) return { name: w.name, healthy: true };
        await new Promise((r) => setTimeout(r, 1000));
      }
      return { name: w.name, healthy: false };
    }),
  );
  return {
    healthy: results.filter((r) => r.healthy).map((r) => r.name),
    unhealthy: results.filter((r) => !r.healthy).map((r) => r.name),
  };
}

/**
 * Checks each worker's health and restarts the tab of any worker that has just
 * transitioned to unhealthy (was healthy/unknown, now down). Updates `health`
 * in place. Restart fires once per down-transition to avoid spawn spam.
 */
export async function runHealthCheck(
  workers: WorkerSpec[],
  clients: Map<string, HealthClient>,
  manager: Pick<WorkerManager, "spawnOne">,
  health: Map<string, boolean>,
): Promise<void> {
  await Promise.all(
    workers.map(async (w) => {
      const client = clients.get(w.name);
      if (!client) return;
      const healthy = await client.isHealthy();
      const was = health.get(w.name);
      health.set(w.name, healthy);
      if (!healthy && was !== false) {
        console.warn(`[health] worker ${w.name} unhealthy — restarting tab`);
        try {
          manager.spawnOne(w.name);
        } catch (err) {
          console.error(`[health] failed to restart ${w.name}:`, err);
        }
      }
    }),
  );
}

// Entrypoint
if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  void main();
}
