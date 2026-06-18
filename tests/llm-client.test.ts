import { describe, it, expect, vi } from "vitest";
import { extractModelConfig, LlmClient, parseCompletion } from "../src/llm-client.js";

const OPENCODE_CONFIG = {
  model: "9router/kr/claude-opus-4.8",
  provider: {
    "9router": {
      npm: "@ai-sdk/openai-compatible",
      options: {
        baseURL: "https://9router.example/v1",
        apiKey: "sk-test-key",
      },
      models: { "kr/claude-opus-4.8": { name: "kr/claude-opus-4.8" } },
    },
  },
};

describe("extractModelConfig", () => {
  it("resolves baseURL, apiKey, and model id from the opencode config", () => {
    const cfg = extractModelConfig(OPENCODE_CONFIG);
    expect(cfg.baseURL).toBe("https://9router.example/v1");
    expect(cfg.apiKey).toBe("sk-test-key");
    expect(cfg.model).toBe("kr/claude-opus-4.8");
  });

  it("throws when the top-level model is missing", () => {
    expect(() => extractModelConfig({ provider: {} })).toThrow(/model/i);
  });

  it("throws when the named provider is missing", () => {
    expect(() =>
      extractModelConfig({ model: "ghost/x", provider: {} }),
    ).toThrow(/provider/i);
  });
});

describe("LlmClient", () => {
  it("posts an OpenAI-compatible chat request and returns the assistant text", async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("kr/claude-opus-4.8");
      expect(body.messages[0].role).toBe("system");
      expect(body.stream).toBe(false);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: "ROUTER REPLY" } }] }),
      } as Response;
    });
    const client = new LlmClient(
      { baseURL: "https://9router.example/v1", apiKey: "sk-test-key", model: "kr/claude-opus-4.8" },
      fetchFn,
    );
    const out = await client.chat([
      { role: "system", content: "you are a router" },
      { role: "user", content: "do the thing" },
    ]);
    expect(out).toBe("ROUTER REPLY");
    const url = fetchFn.mock.calls[0]![0];
    expect(url).toBe("https://9router.example/v1/chat/completions");
  });

  it("parses an SSE-streamed response body", async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"HELLO "}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"WORLD"}}]}\n\n' +
      "data: [DONE]\n\n";
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, text: async () => sse }) as Response);
    const client = new LlmClient(
      { baseURL: "https://9router.example/v1", apiKey: "k", model: "m" },
      fetchFn,
    );
    expect(await client.chat([{ role: "user", content: "hi" }])).toBe("HELLO WORLD");
  });

  it("throws on a non-ok response", async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 500, text: async () => "boom" }) as Response);
    const client = new LlmClient(
      { baseURL: "https://9router.example/v1", apiKey: "k", model: "m" },
      fetchFn,
    );
    await expect(client.chat([{ role: "user", content: "hi" }])).rejects.toThrow(/500/);
  });
});

describe("parseCompletion", () => {
  it("reads a plain JSON completion body", () => {
    expect(parseCompletion(JSON.stringify({ choices: [{ message: { content: "hi" } }] }))).toBe("hi");
  });
  it("accumulates SSE delta content", () => {
    const sse = 'data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: {"choices":[{"delta":{"content":"b"}}]}\n\n';
    expect(parseCompletion(sse)).toBe("ab");
  });
  it("returns empty string for unparseable body", () => {
    expect(parseCompletion("not json")).toBe("");
  });
});
