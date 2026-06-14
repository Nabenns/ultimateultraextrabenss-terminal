export type JobState = "queued" | "running" | "done" | "failed";

export interface Job {
  id: string;
  role: string;
  state: JobState;
  sessionID: string | null;
  prompt: string;
  summary: string | null;
  remainingTodos: string[];
  lastUpdate: number;
  /** ms epoch when the job entered the "running" state (null until then). */
  startedAt: number | null;
  /** ms epoch when the job reached a terminal state (null until then). */
  finishedAt: number | null;
}

export interface WorkerSpec {
  name: string;
  port: number;
  cwd: string;
  agent: string | null;
  model: string | null;
  attach: boolean;
}

export interface BusMessage {
  from: string;
  to: string;
  text: string;
  timestamp: number;
}

export function isTerminalState(state: JobState): boolean {
  return state === "done" || state === "failed";
}
