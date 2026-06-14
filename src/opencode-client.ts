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

  async abort(sessionID: string): Promise<void> {
    await this.post(`/session/${sessionID}/abort`);
  }
}
