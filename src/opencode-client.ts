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

  async abort(sessionID: string): Promise<void> {
    await this.post(`/session/${sessionID}/abort`);
  }
}
