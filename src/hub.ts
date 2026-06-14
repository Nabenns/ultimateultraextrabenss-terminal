import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { loadConfig, HUB_PORT } from "./config.js";
import { OpencodeClient } from "./opencode-client.js";
import { StatusBoard } from "./status-board.js";
import { WorkerManager } from "./worker-manager.js";
import { Orchestrator } from "./orchestrator.js";
import { listenToWorker, type OpencodeEvent } from "./event-listener.js";
import { startDashboard } from "./dashboard.js";
import { LlmClient, loadModelConfig } from "./llm-client.js";
import { OrchestratorAI } from "./orchestrator-ai.js";
import type { ChatMessage } from "./llm-client.js";
import type { WorkerSpec } from "./types.js";


/** SSE→verify bridge: when a worker's session goes idle, verify its job, then
 * notify the Orchestrator-AI so it can re-engage once its jobs settle. */
export async function handleWorkerEvent(
  board: StatusBoard,
  orchestrator: Pick<Orchestrator, "verify">,
  orchestratorAI: Pick<OrchestratorAI, "notifyJobSettled">,
  workerName: string,
  event: OpencodeEvent,
): Promise<void> {
  try {
    if (event.type !== "session.idle") return;
    const sessionID = event.properties.sessionID;
    if (!sessionID) return;
    const job = board.findLatestBySession(sessionID);
    if (!job) return;
    await orchestrator.verify(job.id);
    // Re-engage the router brain only for terminal jobs (done/failed).
    const settled = board.get(job.id);
    if (settled && (settled.state === "done" || settled.state === "failed")) {
      await orchestratorAI.notifyJobSettled(job.id);
    }
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

  // Per-role model overrides, mutable at runtime via the web model picker.
  const modelByRole = new Map<string, string>(
    cfg.workers.flatMap((w) => (w.model ? [[w.name, w.model] as const] : [])),
  );
  const modelFor = (role: string): string | null => modelByRole.get(role) ?? null;

  const orchestrator = new Orchestrator(board, clientFor, agentFor, modelFor);

  // Router brain: the web chat talks to this. It reads creds from the user's
  // opencode config (same provider/model as the rest of the toolchain), so no
  // secrets live in this repo.
  const llm = new LlmClient(loadModelConfig());

  // Buffer of autonomous replies (from the correction loop) for the web to poll.
  const autoReplies: { text: string; at: number }[] = [];

  // Persist the orchestrator conversation so it survives a Hub restart.
  const historyFile = "hub-history.json";
  let initialHistory: ChatMessage[] = [];
  try {
    initialHistory = JSON.parse(readFileSync(historyFile, "utf8")) as ChatMessage[];
  } catch {
    // No prior history (first run) — start empty.
  }

  const orchestratorAI = new OrchestratorAI(
    llm,
    orchestrator,
    board,
    cfg.workers.map((w) => w.name),
    {
      onReply: (text) => autoReplies.push({ text, at: Date.now() }),
      initialHistory,
      onHistoryChange: (history) => {
        try {
          writeFileSync(historyFile, JSON.stringify(history));
        } catch (err) {
          console.error("failed to persist hub history:", err);
        }
      },
    },
  );

  // Tracks last-known health per worker; shared with the dashboard.
  // Seeded to false (= "starting") so the UI shows workers coming up.
  const health = new Map<string, boolean>(cfg.workers.map((w) => [w.name, false] as const));

  // Cached fleet-wide token/cost totals, refreshed periodically (see usageTimer).
  let usageTotals = { tokens: 0, cost: 0 };

  // Worker manager created before the dashboard so its deps can reference it
  // (e.g. kill-all). Workers are spawned right after the dashboard is live.
  const manager = new WorkerManager(cfg.workers);

  // Start the dashboard FIRST, before spawning/waiting on workers, so the web UI
  // is reachable immediately and workers visibly fill in as they become healthy.
  const stopDashboard = await startDashboard(
    {
      board,
      workerNames: cfg.workers.map((w) => w.name),
      health,
      getUsage: () => usageTotals,
      getModels: () =>
        Object.fromEntries(cfg.workers.map((w) => [w.name, modelByRole.get(w.name) ?? null])),
      setModel: (role, model) => {
        if (model) modelByRole.set(role, model);
        else modelByRole.delete(role);
      },
      onKillAll: () => manager.killAll(),
      onCancelAll: async () => {
        // Abort the active session of every running job.
        const running = board.getAll().filter((j) => j.state === "running" && j.sessionID);
        await Promise.all(
          running.map(async (j) => {
            const client = clients.get(j.role);
            if (client && j.sessionID) await client.abort(j.sessionID).catch(() => {});
          }),
        );
      },
      onChat: (message) => orchestratorAI.handle(message),
      drainReplies: () => autoReplies.splice(0, autoReplies.length),
      getConversation: async (name) => {
        const client = clients.get(name);
        if (!client) return [];
        // Find this worker's active session via its latest job on the board.
        const job = board.getAll().filter((j) => j.role === name && j.sessionID).at(-1);
        if (!job?.sessionID) return [];
        return client.conversation(job.sessionID);
      },
      onAbort: async (name) => {
        const client = clients.get(name);
        if (!client) return false;
        const job = board.getAll().filter((j) => j.role === name && j.sessionID).at(-1);
        if (!job?.sessionID) return false;
        await client.abort(job.sessionID);
        return true;
      },
    },
    HUB_PORT,
  );
  console.log(`Hub dashboard (chat + status) at http://127.0.0.1:${HUB_PORT}`);
  openBrowser(`http://127.0.0.1:${HUB_PORT}`);

  // Spawn worker terminals.
  manager.spawnAll();

  const stopListeners: Array<() => void> = [];

  // Background: wait for workers to become healthy, then attach SSE listeners.
  // Runs without blocking the dashboard, which is already live.
  void (async () => {
    const startup = await waitForWorkers(cfg.workers, clients, 60000, (name, healthy) => {
      health.set(name, healthy);
    });
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
    for (const w of cfg.workers) {
      const stop = listenToWorker(w.name, baseUrls.get(w.name)!, (name, ev) => {
        void handleWorkerEvent(board, orchestrator, orchestratorAI, name, ev);
      });
      stopListeners.push(stop);
    }
  })();

  // Periodic health watch: restart a worker's tab when it transitions to unhealthy.
  const healthTimer = setInterval(() => {
    void runHealthCheck(cfg.workers, clients, manager, health);
  }, 15000);

  // Periodic usage refresh: sum tokens/cost across each worker's active session.
  const usageTimer = setInterval(() => {
    void (async () => {
      let tokens = 0;
      let cost = 0;
      const seen = new Set<string>();
      for (const job of board.getAll()) {
        if (!job.sessionID || seen.has(job.sessionID)) continue;
        seen.add(job.sessionID);
        const client = clients.get(job.role);
        if (!client) continue;
        const u = await client.sessionUsage(job.sessionID);
        tokens += u.tokens;
        cost += u.cost;
      }
      usageTotals = { tokens, cost };
    })();
  }, 10000);

  // Periodic stall watch: flag running jobs with no worker activity for >3 min.
  const stallTimer = setInterval(() => {
    void runStallCheck(board, clients);
  }, 30000);

  process.on("SIGINT", () => {
    clearInterval(healthTimer);
    clearInterval(usageTimer);
    clearInterval(stallTimer);
    for (const stop of stopListeners) stop();
    stopDashboard();
    // Clean up worker servers so they don't orphan across Hub restarts.
    manager.killAll();
    process.exit(0);
  });

  process.on("unhandledRejection", (reason) => console.error("unhandledRejection:", reason));
}

/** Open the default browser at `url` (best-effort; never throws). */
function openBrowser(url: string): void {
  try {
    const platform = process.platform;
    if (platform === "win32") {
      // `start` is a cmd builtin; the empty "" is the window-title arg.
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else if (platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // Non-fatal: user can open the URL manually.
  }
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
  onHealthy?: (name: string, healthy: boolean) => void,
): Promise<StartupHealth> {
  const results = await Promise.all(
    workers.map(async (w): Promise<{ name: string; healthy: boolean }> => {
      const client = clients.get(w.name)!;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await client.isHealthy()) {
          onHealthy?.(w.name, true);
          return { name: w.name, healthy: true };
        }
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

interface ActivityClient {
  lastActivityAt(sessionID: string): Promise<number | null>;
}

/**
 * Flags running jobs whose worker has shown no activity past `stallMs`. Pure
 * over its injected board + clients; updates each job's `stalled` flag in place.
 * Uses the newest part timestamp (true activity) — not board lastUpdate, since a
 * busy worker reading files doesn't touch the board.
 */
export async function runStallCheck(
  board: Pick<StatusBoard, "getAll" | "update">,
  clients: Map<string, ActivityClient>,
  stallMs = 180000,
  now: number = Date.now(),
): Promise<void> {
  await Promise.all(
    board.getAll().map(async (job) => {
      if (job.state !== "running" || !job.sessionID) return;
      const client = clients.get(job.role);
      if (!client) return;
      const last = await client.lastActivityAt(job.sessionID);
      // Fall back to startedAt if the worker has emitted nothing yet.
      const ref = last ?? job.startedAt ?? now;
      const stalled = now - ref > stallMs;
      if (stalled !== job.stalled) board.update(job.id, { stalled });
    }),
  );
}

// Entrypoint
if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  void main();
}