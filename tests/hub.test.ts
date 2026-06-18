import { describe, it, expect, vi } from "vitest";
import { handleWorkerEvent, runHealthCheck, runStallCheck } from "../src/hub.js";
import { StatusBoard } from "../src/status-board.js";
import type { WorkerSpec } from "../src/types.js";

describe("handleWorkerEvent", () => {
  const aiStub = () => ({ notifyJobSettled: vi.fn(async () => {}) });

  it("verifies the job tied to a session when it goes idle", async () => {
    const board = new StatusBoard();
    const job = board.addJob("frontend", "a");
    board.update(job.id, { state: "running", sessionID: "ses_1" });
    const orchestrator = { verify: vi.fn(async () => {}), dispatch: vi.fn() };

    await handleWorkerEvent(board, orchestrator as never, aiStub() as never, "frontend", {
      type: "session.idle",
      properties: { sessionID: "ses_1" },
    });

    expect(orchestrator.verify).toHaveBeenCalledWith(job.id);
  });

  it("ignores non-idle events", async () => {
    const board = new StatusBoard();
    const orchestrator = { verify: vi.fn(async () => {}), dispatch: vi.fn() };
    await handleWorkerEvent(board, orchestrator as never, aiStub() as never, "frontend", {
      type: "message.updated",
      properties: { sessionID: "ses_1" },
    });
    expect(orchestrator.verify).not.toHaveBeenCalled();
  });

  it("verifies the LATEST job when multiple jobs share a session", async () => {
    const board = new StatusBoard();
    const first = board.addJob("frontend", "a");
    board.update(first.id, { state: "running", sessionID: "ses_1" });
    const second = board.addJob("frontend", "b");
    board.update(second.id, { state: "running", sessionID: "ses_1" });
    const orchestrator = { verify: vi.fn(async () => {}), dispatch: vi.fn() };

    await handleWorkerEvent(board, orchestrator as never, aiStub() as never, "frontend", {
      type: "session.idle",
      properties: { sessionID: "ses_1" },
    });

    expect(orchestrator.verify).toHaveBeenCalledWith(second.id);
  });

  it("notifies the orchestrator-AI when the job settles to done", async () => {
    const board = new StatusBoard();
    const job = board.addJob("frontend", "a");
    board.update(job.id, { state: "running", sessionID: "ses_1" });
    // verify marks it done
    const orchestrator = {
      verify: vi.fn(async () => {
        board.update(job.id, { state: "done" });
      }),
      dispatch: vi.fn(),
    };
    const ai = aiStub();

    await handleWorkerEvent(board, orchestrator as never, ai as never, "frontend", {
      type: "session.idle",
      properties: { sessionID: "ses_1" },
    });

    expect(ai.notifyJobSettled).toHaveBeenCalledWith(job.id);
  });

  it("does not notify the orchestrator-AI while the job is still running", async () => {
    const board = new StatusBoard();
    const job = board.addJob("frontend", "a");
    board.update(job.id, { state: "running", sessionID: "ses_1" });
    const orchestrator = { verify: vi.fn(async () => {}), dispatch: vi.fn() }; // stays running
    const ai = aiStub();

    await handleWorkerEvent(board, orchestrator as never, ai as never, "frontend", {
      type: "session.idle",
      properties: { sessionID: "ses_1" },
    });

    expect(ai.notifyJobSettled).not.toHaveBeenCalled();
  });

  it("does not reject when orchestrator.verify rejects", async () => {
    const board = new StatusBoard();
    const job = board.addJob("frontend", "a");
    board.update(job.id, { state: "running", sessionID: "ses_1" });
    const orchestrator = {
      verify: vi.fn(async () => {
        throw new Error("HTTP 500");
      }),
      dispatch: vi.fn(),
    };

    await expect(
      handleWorkerEvent(board, orchestrator as never, aiStub() as never, "frontend", {
        type: "session.idle",
        properties: { sessionID: "ses_1" },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("runHealthCheck", () => {
  const spec = (name: string): WorkerSpec => ({
    name,
    port: 4106,
    cwd: ".",
    agent: null,
    model: null,
    attach: true,
  });

  it("restarts a worker that transitions to unhealthy", async () => {
    const clients = new Map([["frontend", { isHealthy: vi.fn(async () => false) }]]);
    const manager = { spawnOne: vi.fn() };
    const health = new Map<string, boolean>([["frontend", true]]); // was healthy

    await runHealthCheck([spec("frontend")], clients as never, manager, health);

    expect(manager.spawnOne).toHaveBeenCalledWith("frontend");
    expect(health.get("frontend")).toBe(false);
  });

  it("does not restart a worker that stays unhealthy (no repeated spawn)", async () => {
    const clients = new Map([["frontend", { isHealthy: vi.fn(async () => false) }]]);
    const manager = { spawnOne: vi.fn() };
    const health = new Map<string, boolean>([["frontend", false]]); // already down

    await runHealthCheck([spec("frontend")], clients as never, manager, health);

    expect(manager.spawnOne).not.toHaveBeenCalled();
  });

  it("does not restart a healthy worker", async () => {
    const clients = new Map([["frontend", { isHealthy: vi.fn(async () => true) }]]);
    const manager = { spawnOne: vi.fn() };
    const health = new Map<string, boolean>();

    await runHealthCheck([spec("frontend")], clients as never, manager, health);

    expect(manager.spawnOne).not.toHaveBeenCalled();
    expect(health.get("frontend")).toBe(true);
  });
});

describe("runStallCheck", () => {
  it("flags a running job with no recent activity as stalled", async () => {
    const board = new StatusBoard();
    const job = board.addJob("researcher", "deep task");
    board.update(job.id, { state: "running", sessionID: "ses_x" });
    const now = Date.now();
    // last activity 5 minutes ago, threshold 3 min -> stalled
    const clients = new Map([["researcher", { lastActivityAt: vi.fn(async () => now - 300000) }]]);
    await runStallCheck(board as never, clients as never, 180000, now);
    expect(board.get(job.id)!.stalled).toBe(true);
  });

  it("does not flag a job with recent activity", async () => {
    const board = new StatusBoard();
    const job = board.addJob("researcher", "task");
    board.update(job.id, { state: "running", sessionID: "ses_x" });
    const now = Date.now();
    const clients = new Map([["researcher", { lastActivityAt: vi.fn(async () => now - 5000) }]]);
    await runStallCheck(board as never, clients as never, 180000, now);
    expect(board.get(job.id)!.stalled).toBe(false);
  });

  it("ignores non-running jobs", async () => {
    const board = new StatusBoard();
    const job = board.addJob("researcher", "task");
    board.update(job.id, { state: "done", sessionID: "ses_x" });
    const clients = new Map([["researcher", { lastActivityAt: vi.fn(async () => 0) }]]);
    await runStallCheck(board as never, clients as never, 180000, Date.now());
    expect(board.get(job.id)!.stalled).toBe(false);
  });
});
