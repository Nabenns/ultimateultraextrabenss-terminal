import { describe, it, expect } from "vitest";
import { buildSnapshot } from "../src/dashboard.js";
import { StatusBoard } from "../src/status-board.js";

describe("buildSnapshot", () => {
  it("groups jobs by worker role and includes declared empty roles", () => {
    const board = new StatusBoard();
    const j = board.addJob("frontend", "build form");
    board.update(j.id, { state: "running", sessionID: "ses_1" });

    const health = new Map<string, boolean>([
      ["frontend", true],
      ["backend", false],
    ]);
    const snap = buildSnapshot({
      board,
      workerNames: ["frontend", "backend", "tester"],
      health,
    });

    expect(snap.summary).toEqual({ queued: 0, running: 1, done: 0, failed: 0 });
    const frontend = snap.workers.find((w) => w.name === "frontend")!;
    expect(frontend.healthy).toBe(true);
    expect(frontend.jobs).toHaveLength(1);

    const backend = snap.workers.find((w) => w.name === "backend")!;
    expect(backend.healthy).toBe(false);
    expect(backend.jobs).toHaveLength(0);

    // Declared but never health-checked → unknown (null).
    const tester = snap.workers.find((w) => w.name === "tester")!;
    expect(tester.healthy).toBeNull();
  });

  it("includes all jobs in the flat jobs list", () => {
    const board = new StatusBoard();
    board.addJob("frontend", "a");
    board.addJob("backend", "b");
    const snap = buildSnapshot({ board, workerNames: ["frontend", "backend"], health: new Map() });
    expect(snap.jobs).toHaveLength(2);
  });
});
