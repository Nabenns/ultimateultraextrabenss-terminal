import { randomUUID } from "node:crypto";
import type { Job, JobState } from "./types.js";

export type LogWriter = (line: string) => void;

const noopWriter: LogWriter = () => {};

export class StatusBoard {
  private jobs = new Map<string, Job>();

  constructor(private readonly write: LogWriter = noopWriter) {}

  addJob(role: string, prompt: string): Job {
    const job: Job = {
      id: randomUUID(),
      role,
      state: "queued",
      sessionID: null,
      prompt,
      summary: null,
      remainingTodos: [],
      lastUpdate: Date.now(),
    };
    this.jobs.set(job.id, job);
    this.write(JSON.stringify({ event: "add", job }));
    return job;
  }

  /** The only sanctioned mutation path — mutating a Job returned by get()/getAll() bypasses logging and lastUpdate. */
  update(id: string, patch: Partial<Omit<Job, "id">>): void {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`unknown job: ${id}`);
    Object.assign(job, patch, { lastUpdate: Date.now() });
    this.write(JSON.stringify({ event: "update", job }));
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  getAll(): Job[] {
    return [...this.jobs.values()];
  }

  findBySession(sessionID: string): Job | undefined {
    return this.getAll().find((j) => j.sessionID === sessionID);
  }

  /** Returns the most-recently-updated job sharing a sessionID (the active job on a shared session). */
  findLatestBySession(sessionID: string): Job | undefined {
    let latest: Job | undefined;
    for (const j of this.jobs.values()) {
      if (j.sessionID !== sessionID) continue;
      if (!latest || j.lastUpdate >= latest.lastUpdate) latest = j;
    }
    return latest;
  }

  summary(): Record<JobState, number> {
    const counts: Record<JobState, number> = { queued: 0, running: 0, done: 0, failed: 0 };
    for (const j of this.jobs.values()) counts[j.state]++;
    return counts;
  }
}
