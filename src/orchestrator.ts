import type { Job } from "./types.js";
import type { StatusBoard } from "./status-board.js";

export interface Assignment {
  role: string;
  task: string;
}

/** Minimal client surface the orchestrator needs (matches OpencodeClient). */
export interface WorkerClient {
  createSession(title: string): Promise<string>;
  promptAsync(sessionID: string, text: string, agent?: string | null, model?: string | null): Promise<void>;
  remainingTodos(sessionID: string): Promise<string[]>;
  abort(sessionID: string): Promise<void>;
  isHealthy(): Promise<boolean>;
}

export type ClientFactory = (role: string) => WorkerClient;

export class Orchestrator {
  private sessions = new Map<string, string>(); // role -> sessionID

  constructor(
    private readonly board: StatusBoard,
    private readonly clientFor: ClientFactory,
  ) {}

  // Single-writer assumption: dispatch is driven sequentially by the Hub
  // (Hermes via MCP), so this check-then-create is not guarded against
  // concurrent same-role dispatch. Add locking only if that assumption changes.
  private async sessionFor(role: string): Promise<{ client: WorkerClient; sessionID: string }> {
    const client = this.clientFor(role);
    let sessionID = this.sessions.get(role);
    if (!sessionID) {
      sessionID = await client.createSession(`${role} session`);
      this.sessions.set(role, sessionID);
    }
    return { client, sessionID };
  }

  async dispatch(assignments: Assignment[]): Promise<Job[]> {
    const jobs: Job[] = [];
    for (const a of assignments) {
      const job = this.board.addJob(a.role, a.task);
      const { client, sessionID } = await this.sessionFor(a.role);
      // Job is marked running before the prompt is fired. If promptAsync
      // throws, the error propagates out of dispatch (remaining assignments
      // in this batch are skipped); recovery is via SSE-driven verify and
      // Hermes re-dispatch. "failed" state is reserved for worker-reported failure.
      this.board.update(job.id, { state: "running", sessionID });
      await client.promptAsync(sessionID, a.task, null, null);
      jobs.push(this.board.get(job.id)!);
    }
    return jobs;
  }

  async verify(jobId: string): Promise<void> {
    const job = this.board.get(jobId);
    if (!job || !job.sessionID) return;
    const client = this.clientFor(job.role);
    const remaining = await client.remainingTodos(job.sessionID);
    if (remaining.length === 0) {
      this.board.update(jobId, { state: "done", remainingTodos: [] });
    } else {
      this.board.update(jobId, { state: "running", remainingTodos: remaining });
    }
  }
}
