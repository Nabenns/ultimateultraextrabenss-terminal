import { describe, it, expect, vi } from "vitest";
import { OpencodeClient } from "../src/opencode-client.js";

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
});
