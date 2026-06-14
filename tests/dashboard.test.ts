import { describe, it, expect, vi } from "vitest";
import { buildSnapshot, startDashboard, dashboardHtml } from "../src/dashboard.js";
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

  it("serves client JS that is syntactically valid", () => {
    const html = dashboardHtml();
    const start = html.indexOf("<script>") + "<script>".length;
    const end = html.indexOf("</script>");
    const js = html.slice(start, end);
    // Throws SyntaxError if the inlined client script is malformed (e.g. a
    // broken escaped-quote handler), which would silently kill all dashboard JS.
    expect(() => new Function(js)).not.toThrow();
  });

  it("GET /api/worker/:name returns that worker's conversation turns", async () => {
    const getConversation = vi.fn(async (name: string) => [{ role: "assistant", text: `hi from ${name}` }]);
    const stop = await startDashboard({ ...baseDeps(), getConversation }, 4194);
    try {
      const res = await fetch("http://127.0.0.1:4194/api/worker/backend");
      const data = (await res.json()) as { name: string; turns: { role: string; text: string }[] };
      expect(getConversation).toHaveBeenCalledWith("backend");
      expect(data.turns[0]!.text).toBe("hi from backend");
    } finally {
      stop();
    }
  });

  it("POST /api/worker/:name/abort routes to onAbort", async () => {
    const onAbort = vi.fn(async () => true);
    const stop = await startDashboard({ ...baseDeps(), onAbort }, 4193);
    try {
      const res = await fetch("http://127.0.0.1:4193/api/worker/tester/abort", { method: "POST" });
      const data = (await res.json()) as { ok: boolean };
      expect(onAbort).toHaveBeenCalledWith("tester");
      expect(data.ok).toBe(true);
    } finally {
      stop();
    }
  });

  it("POST /api/models sets a role model override", async () => {
    const setModel = vi.fn();
    const stop = await startDashboard({ ...baseDeps(), setModel }, 4192);
    try {
      const res = await fetch("http://127.0.0.1:4192/api/models", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "backend", model: "anthropic/claude-x" }),
      });
      const data = (await res.json()) as { ok: boolean };
      expect(setModel).toHaveBeenCalledWith("backend", "anthropic/claude-x");
      expect(data.ok).toBe(true);
    } finally {
      stop();
    }
  });

  it("POST /api/models with empty model clears the override (null)", async () => {
    const setModel = vi.fn();
    const stop = await startDashboard({ ...baseDeps(), setModel }, 4191);
    try {
      await fetch("http://127.0.0.1:4191/api/models", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "backend", model: "  " }),
      });
      expect(setModel).toHaveBeenCalledWith("backend", null);
    } finally {
      stop();
    }
  });
});
