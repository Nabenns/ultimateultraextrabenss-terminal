export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

interface TodoItem {
  content: string;
  status: string;
}

export class OpencodeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  private async post(path: string, body?: unknown): Promise<Response> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST ${path} -> ${res.status}`);
    return res;
  }

  private async get(path: string): Promise<Response> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`);
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
    return res;
  }

  async isHealthy(): Promise<boolean> {
    try {
      const res = await this.get("/global/health");
      const data = (await res.json()) as { healthy?: boolean };
      return data.healthy === true;
    } catch {
      return false;
    }
  }

  async createSession(title: string): Promise<string> {
    const res = await this.post("/session", { title });
    const data = (await res.json()) as { id: string };
    return data.id;
  }

  /** Fire-and-forget task assignment (enables parallelism across workers). */
  async promptAsync(
    sessionID: string,
    text: string,
    agent?: string | null,
    model?: string | null,
  ): Promise<void> {
    const parts = [{ type: "text", text }];
    await this.post(`/session/${sessionID}/prompt_async`, {
      parts,
      ...(agent ? { agent } : {}),
      ...(model ? { model } : {}),
    });
  }

  async remainingTodos(sessionID: string): Promise<string[]> {
    const res = await this.get(`/session/${sessionID}/todo`);
    const todos = (await res.json()) as TodoItem[];
    return todos.filter((t) => t.status !== "completed").map((t) => t.content);
  }

  /**
   * Best-effort: returns concatenated text of the last assistant message's
   * text-parts, or null if none / shape is unexpected. Never throws on a
   * malformed payload — used only for summary enrichment.
   */
  async lastAssistantText(sessionID: string): Promise<string | null> {
    try {
      const res = await this.get(`/session/${sessionID}/message`);
      const messages = (await res.json()) as unknown;
      if (!Array.isArray(messages)) return null;
      for (let i = messages.length - 1; i >= 0; i--) {
        const entry = messages[i] as { info?: { role?: string }; parts?: unknown };
        if (entry?.info?.role !== "assistant") continue;
        if (!Array.isArray(entry.parts)) return null;
        const text = entry.parts
          .filter(
            (p): p is { type: "text"; text: string } =>
              !!p && (p as { type?: string }).type === "text" &&
              typeof (p as { text?: unknown }).text === "string",
          )
          .map((p) => p.text)
          .join("");
        return text;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Best-effort: the newest part timestamp (ms epoch) across a session's
   * messages — the true "last activity" signal. Returns null on error/none.
   */
  async lastActivityAt(sessionID: string): Promise<number | null> {
    try {
      const res = await this.get(`/session/${sessionID}/message`);
      const messages = (await res.json()) as unknown;
      return newestPartTime(messages);
    } catch {
      return null;
    }
  }

  async abort(sessionID: string): Promise<void> {
    await this.post(`/session/${sessionID}/abort`);
  }

  /**
   * Best-effort: sum token usage and cost across a session's assistant messages.
   * Returns zeros on error/unexpected shape (never throws).
   */
  async sessionUsage(sessionID: string): Promise<UsageTotals> {
    try {
      const res = await this.get(`/session/${sessionID}/message`);
      const messages = (await res.json()) as unknown;
      return sumUsage(messages);
    } catch {
      return { tokens: 0, cost: 0 };
    }
  }

  /**
   * Best-effort: returns the full conversation (user/assistant turns with their
   * concatenated text) for a session, or [] on error/unexpected shape.
   */
  async conversation(sessionID: string): Promise<ConversationTurn[]> {
    try {
      const res = await this.get(`/session/${sessionID}/message`);
      const messages = (await res.json()) as unknown;
      return extractConversation(messages);
    } catch {
      return [];
    }
  }
}

export interface UsageTotals {
  tokens: number;
  cost: number;
}

/** Newest part timestamp (ms epoch) across an opencode /message payload, or null. */
export function newestPartTime(messages: unknown): number | null {
  if (!Array.isArray(messages)) return null;
  let newest = 0;
  for (const entry of messages) {
    const parts = (entry as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) continue;
    for (const p of parts) {
      const time = (p as { time?: { start?: number; end?: number } }).time;
      const t = time?.end ?? time?.start;
      if (typeof t === "number" && t > newest) newest = t;
    }
  }
  return newest > 0 ? newest : null;
}

/** Sum tokens.total + cost across an opencode /message payload. */
export function sumUsage(messages: unknown): UsageTotals {
  if (!Array.isArray(messages)) return { tokens: 0, cost: 0 };
  let tokens = 0;
  let cost = 0;
  for (const entry of messages) {
    const info = (entry as { info?: { tokens?: { total?: number }; cost?: number } }).info;
    if (!info) continue;
    if (typeof info.tokens?.total === "number") tokens += info.tokens.total;
    if (typeof info.cost === "number") cost += info.cost;
  }
  return { tokens, cost };
}

export interface ConversationTurn {
  role: string;
  text: string;
  /** "text" (default), "tool" (file/command activity), or "reasoning". */
  kind?: "text" | "tool" | "reasoning";
}

/** Short human label for a tool part, e.g. `read package.json` or `bash: npm test`. */
function describeTool(part: { tool?: unknown; state?: unknown }): string {
  const tool = typeof part.tool === "string" ? part.tool : "tool";
  const state = part.state as { status?: string; input?: Record<string, unknown> } | undefined;
  const input = state?.input ?? {};
  const status = state?.status ? ` [${state.status}]` : "";
  // Pull the most informative arg per common tool.
  const arg =
    (typeof input.filePath === "string" && input.filePath) ||
    (typeof input.path === "string" && input.path) ||
    (typeof input.pattern === "string" && input.pattern) ||
    (typeof input.command === "string" && input.command) ||
    (typeof input.query === "string" && input.query) ||
    "";
  return `${tool}${status}${arg ? ` — ${arg}` : ""}`;
}

/**
 * Extract a rich activity feed from an opencode /message payload: assistant/user
 * text, tool calls (file reads, commands), and reasoning — so the UI can show
 * what a worker is actually doing while it runs.
 */
export function extractConversation(messages: unknown): ConversationTurn[] {
  if (!Array.isArray(messages)) return [];
  const turns: ConversationTurn[] = [];
  for (const entry of messages) {
    const role = (entry as { info?: { role?: string } })?.info?.role;
    const parts = (entry as { parts?: unknown }).parts;
    if (typeof role !== "string" || !Array.isArray(parts)) continue;
    for (const p of parts) {
      const part = p as { type?: string; text?: unknown; tool?: unknown; state?: unknown };
      if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
        turns.push({ role, text: part.text, kind: "text" });
      } else if (part.type === "tool") {
        turns.push({ role, text: describeTool(part), kind: "tool" });
      } else if (part.type === "reasoning" && typeof part.text === "string" && part.text.trim()) {
        turns.push({ role, text: part.text, kind: "reasoning" });
      }
    }
  }
  return turns;
}
