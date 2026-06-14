import { describe, it, expect, vi } from "vitest";
import { OpencodeClient, extractConversation, sumUsage, newestPartTime } from "../src/opencode-client.js";

function mockFetch(responses: Record<string, unknown>) {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    const path = new URL(url).pathname;
    const key = Object.keys(responses).find((k) => path.endsWith(k));
    if (!key) throw new Error(`unexpected path: ${path}`);
    return {
      ok: true,
      status: 200,
      json: async () => responses[key],
    } as Response;
  });
}

describe("OpencodeClient", () => {
  it("creates a session and returns its id", async () => {
    const fetchFn = mockFetch({ "/session": { id: "ses_123" } });
    const client = new OpencodeClient("http://localhost:4106", fetchFn);
    const id = await client.createSession("frontend session");
    expect(id).toBe("ses_123");
  });

  it("reads todos for a session", async () => {
    const fetchFn = mockFetch({
      "/todo": [
        { content: "build form", status: "pending" },
        { content: "wire submit", status: "completed" },
      ],
    });
    const client = new OpencodeClient("http://localhost:4106", fetchFn);
    const remaining = await client.remainingTodos("ses_123");
    expect(remaining).toEqual(["build form"]);
  });

  it("reports health", async () => {
    const fetchFn = mockFetch({ "/global/health": { healthy: true, version: "x" } });
    const client = new OpencodeClient("http://localhost:4106", fetchFn);
    expect(await client.isHealthy()).toBe(true);
  });

  it("isHealthy returns false when fetch rejects", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("transport error");
    });
    const client = new OpencodeClient("http://localhost:4106", fetchFn);
    expect(await client.isHealthy()).toBe(false);
  });

  it("isHealthy returns false on non-ok response", async () => {
    const fetchFn = vi.fn(
      async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response,
    );
    const client = new OpencodeClient("http://localhost:4106", fetchFn);
    expect(await client.isHealthy()).toBe(false);
  });

  it("createSession rejects on non-ok response", async () => {
    const fetchFn = vi.fn(
      async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response,
    );
    const client = new OpencodeClient("http://localhost:4106", fetchFn);
    await expect(client.createSession("frontend session")).rejects.toThrow();
  });

  it("lastAssistantText returns the text of the last assistant message", async () => {
    const fetchFn = mockFetch({
      "/message": [
        { info: { role: "user" }, parts: [{ type: "text", text: "hi" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "done building" }] },
      ],
    });
    const client = new OpencodeClient("http://localhost:4106", fetchFn);
    expect(await client.lastAssistantText("ses_123")).toBe("done building");
  });

  it("lastAssistantText returns null on malformed/empty response", async () => {
    const fetchFn = mockFetch({ "/message": {} });
    const client = new OpencodeClient("http://localhost:4106", fetchFn);
    expect(await client.lastAssistantText("ses_123")).toBeNull();
  });
});

describe("extractConversation", () => {
  it("emits text turns per text part with kind 'text'", () => {
    const messages = [
      { info: { role: "user" }, parts: [{ type: "text", text: "build login" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "Built POST /login" }] },
    ];
    expect(extractConversation(messages)).toEqual([
      { role: "user", text: "build login", kind: "text" },
      { role: "assistant", text: "Built POST /login", kind: "text" },
    ]);
  });

  it("emits tool activity with a human label", () => {
    const messages = [
      {
        info: { role: "assistant" },
        parts: [
          { type: "tool", tool: "read", state: { status: "completed", input: { filePath: "C:\\proj\\package.json" } } },
          { type: "tool", tool: "bash", state: { status: "running", input: { command: "npm test" } } },
        ],
      },
    ];
    const turns = extractConversation(messages);
    expect(turns[0]).toEqual({ role: "assistant", text: "read [completed] — C:\\proj\\package.json", kind: "tool" });
    expect(turns[1]).toEqual({ role: "assistant", text: "bash [running] — npm test", kind: "tool" });
  });

  it("emits reasoning parts and returns [] for non-arrays", () => {
    expect(extractConversation({})).toEqual([]);
    const turns = extractConversation([
      { info: { role: "assistant" }, parts: [{ type: "reasoning", text: "thinking..." }] },
    ]);
    expect(turns).toEqual([{ role: "assistant", text: "thinking...", kind: "reasoning" }]);
  });
});

describe("sumUsage", () => {
  it("sums tokens.total and cost across messages", () => {
    const messages = [
      { info: { role: "assistant", tokens: { total: 100 }, cost: 0.01 } },
      { info: { role: "assistant", tokens: { total: 250 }, cost: 0.02 } },
      { info: { role: "user" } },
    ];
    const u = sumUsage(messages);
    expect(u.tokens).toBe(350);
    expect(u.cost).toBeCloseTo(0.03);
  });
  it("returns zeros for non-array / empty", () => {
    expect(sumUsage({})).toEqual({ tokens: 0, cost: 0 });
    expect(sumUsage([])).toEqual({ tokens: 0, cost: 0 });
  });
});

describe("newestPartTime", () => {
  it("returns the max part end/start timestamp", () => {
    const messages = [
      { parts: [{ type: "text", text: "a", time: { start: 100, end: 200 } }] },
      { parts: [{ type: "tool", time: { start: 500 } }, { type: "text", time: { start: 300, end: 350 } }] },
    ];
    expect(newestPartTime(messages)).toBe(500);
  });
  it("returns null when no timestamps / non-array", () => {
    expect(newestPartTime({})).toBeNull();
    expect(newestPartTime([{ parts: [{ type: "text" }] }])).toBeNull();
  });
});
