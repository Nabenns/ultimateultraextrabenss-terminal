import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ModelConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Extract the model endpoint config from a parsed opencode config object.
 * The top-level `model` is "<provider>/<modelId>"; the provider's options hold
 * baseURL + apiKey (openai-compatible).
 */
export function extractModelConfig(raw: unknown): ModelConfig {
  const cfg = raw as {
    model?: string;
    provider?: Record<string, { options?: { baseURL?: string; apiKey?: string } }>;
  };
  if (!cfg.model || typeof cfg.model !== "string") {
    throw new Error("opencode config: missing top-level `model`");
  }
  const slash = cfg.model.indexOf("/");
  if (slash === -1) {
    throw new Error(`opencode config: model "${cfg.model}" is not "<provider>/<modelId>"`);
  }
  const providerId = cfg.model.slice(0, slash);
  const modelId = cfg.model.slice(slash + 1);
  const provider = cfg.provider?.[providerId];
  if (!provider) {
    throw new Error(`opencode config: provider "${providerId}" not found`);
  }
  const baseURL = provider.options?.baseURL;
  const apiKey = provider.options?.apiKey;
  if (!baseURL) throw new Error(`opencode config: provider "${providerId}" has no baseURL`);
  if (!apiKey) throw new Error(`opencode config: provider "${providerId}" has no apiKey`);
  return { baseURL, apiKey, model: modelId };
}

/** Default path to the user's global opencode config. */
export function defaultOpencodeConfigPath(): string {
  return join(homedir(), ".config", "opencode", "opencode.json");
}

/** Load and resolve the model config from the opencode config file. */
export function loadModelConfig(path = defaultOpencodeConfigPath()): ModelConfig {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return extractModelConfig(raw);
}

/** Minimal OpenAI-compatible chat client. */
export class LlmClient {
  constructor(
    private readonly cfg: ModelConfig,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  async chat(messages: ChatMessage[]): Promise<string> {
    const res = await this.fetchFn(`${this.cfg.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify({ model: this.cfg.model, messages, stream: false }),
    });
    if (!res.ok) {
      const detail = typeof res.text === "function" ? await res.text().catch(() => "") : "";
      throw new Error(`LLM request failed: ${res.status} ${detail}`);
    }
    const text = typeof res.text === "function" ? await res.text() : "";
    return parseCompletion(text);
  }
}

/**
 * Extract assistant text from a chat-completions response. Handles both a plain
 * JSON body and an SSE stream (`data: {...}` lines) — some openai-compatible
 * gateways stream even when stream:false is requested.
 */
export function parseCompletion(body: string): string {
  const trimmed = body.trimStart();
  // SSE stream: accumulate delta.content (or message.content) across data lines.
  if (trimmed.startsWith("data:")) {
    let out = "";
    for (const line of body.split("\n")) {
      const l = line.trim();
      if (!l.startsWith("data:")) continue;
      const payload = l.slice("data:".length).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const chunk = JSON.parse(payload) as {
          choices?: { delta?: { content?: string }; message?: { content?: string } }[];
        };
        const choice = chunk.choices?.[0];
        out += choice?.delta?.content ?? choice?.message?.content ?? "";
      } catch {
        // skip malformed chunk
      }
    }
    return out;
  }
  // Plain JSON body.
  try {
    const data = JSON.parse(body) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? "";
  } catch {
    return "";
  }
}
