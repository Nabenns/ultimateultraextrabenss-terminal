import { describe, it, expect, vi } from "vitest";
import { OpencodeClient, extractConversation } from "../src/opencode-client.js";

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
  it("extracts user/assistant turns with concatenated text", () => {
    const messages = [
      { info: { role: "user" }, parts: [{ type: "text", text: "build login" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "Built " }, { type: "text", text: "POST /login" }] },
    ];
    expect(extractConversation(messages)).toEqual([
      { role: "user", text: "build login" },
      { role: "assistant", text: "Built POST /login" },
    ]);
  });

  it("skips entries with no text and returns [] for non-arrays", () => {
    expect(extractConversation({})).toEqual([]);
    expect(extractConversation([{ info: { role: "assistant" }, parts: [{ type: "tool", id: "x" }] }])).toEqual([]);
  });
});
