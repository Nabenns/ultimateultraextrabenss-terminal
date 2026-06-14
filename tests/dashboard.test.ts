import { describe, it, expect, vi } from "vitest";
import { buildSnapshot, startDashboard } from "../src/dashboard.js";
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

describe("dashboard HTTP server", () => {
  const baseDeps = () => ({
    board: new StatusBoard(),
    workerNames: ["frontend"],
    health: new Map<string, boolean>(),
  });

  it("POST /api/chat routes the message to onChat and returns the reply", async () => {
    const onChat = vi.fn(async (msg: string) => `handled: ${msg}`);
    const stop = await startDashboard({ ...baseDeps(), onChat }, 4197);
    try {
      const res = await fetch("http://127.0.0.1:4197/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "add login" }),
      });
      const data = (await res.json()) as { reply?: string };
      expect(onChat).toHaveBeenCalledWith("add login");
      expect(data.reply).toBe("handled: add login");
    } finally {
      stop();
    }
  });

  it("POST /api/chat returns 400 for an empty message", async () => {
    const onChat = vi.fn(async () => "x");
    const stop = await startDashboard({ ...baseDeps(), onChat }, 4196);
    try {
      const res = await fetch("http://127.0.0.1:4196/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "  " }),
      });
      expect(res.status).toBe(400);
      expect(onChat).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it("serves the HTML shell at /", async () => {
    const stop = await startDashboard(baseDeps(), 4195);
    try {
      const res = await fetch("http://127.0.0.1:4195/");
      const text = await res.text();
      expect(text).toContain("ben-terminal Hub");
      expect(text).toContain("chatform");
    } finally {
      stop();
    }
  });
});
