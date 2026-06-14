# Multi-Agent Terminal Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Node/TypeScript "Hub" that orchestrates multiple `opencode` worker processes (each in its own Windows Terminal tab), routes tasks and inter-worker messages, tracks job status, and exposes an MCP server so Hermes can drive and correct the whole system.

**Architecture:** A single Hub process fuses four roles — message bus, status board, orchestrator logic, and MCP (HTTP) server. Workers are long-running `opencode serve` instances controlled purely over their HTTP API (`prompt_async` for parallelism, SSE `/event` for completion, `/todo` for remaining work). Hermes connects to the Hub over MCP HTTP transport.

**Tech Stack:** Node.js 24, TypeScript, `@modelcontextprotocol/sdk` (MCP server, Streamable HTTP transport), native `fetch` + SSE for opencode HTTP API, `wt.exe` for spawning worker tabs, Vitest for tests, Zod for config/validation.

---

## File Structure

- `package.json` — deps, scripts (`build`, `test`, `start`)
- `tsconfig.json` — strict TS config
- `vitest.config.ts` — test config
- `agents.config.json` — declares worker roles (name, port, cwd, agent, model, attach)
- `src/config.ts` — load + validate `agents.config.json` (Zod schema)
- `src/types.ts` — shared types (Job, JobState, WorkerSpec, BusMessage)
- `src/opencode-client.ts` — typed wrapper over one worker's opencode HTTP API
- `src/worker-manager.ts` — spawn/stop worker processes via `wt.exe`, track PIDs
- `src/status-board.ts` — authoritative in-memory job state + log-file mirror
- `src/bus.ts` — message bus: route worker→worker messages through the Hub
- `src/orchestrator.ts` — decomposition/routing/verification logic
- `src/event-listener.ts` — subscribe to each worker's SSE `/event`, update board
- `src/mcp-server.ts` — MCP server exposing dispatch_task/get_status/get_results/send_message
- `src/hub.ts` — wires everything together; the process entrypoint
- `tests/*.test.ts` — one test file per module

---

## Task 0: Project Scaffolding

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore` (already exists, verify)

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "ultimateultraextrabenss-terminal",
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "start": "node dist/hub.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*", "tests/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, no errors.

- [ ] **Step 5: Verify the toolchain builds**

Run: `npm run build`
Expected: PASS (no source files yet, `tsc` exits 0).

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts package-lock.json
git commit -m "chore: scaffold Node/TS project with vitest and MCP SDK"
```

---

## Task 1: Shared Types

**Files:**
- Create: `src/types.ts`
- Test: `tests/types.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { isTerminalState, type JobState } from "../src/types.js";

describe("isTerminalState", () => {
  it("treats done and failed as terminal", () => {
    expect(isTerminalState("done")).toBe(true);
    expect(isTerminalState("failed")).toBe(true);
  });
  it("treats queued and running as non-terminal", () => {
    expect(isTerminalState("queued")).toBe(false);
    expect(isTerminalState("running")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/types.test.ts`
Expected: FAIL — cannot find module `../src/types.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/types.ts

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
  to: string; // worker name, or "*" for broadcast
  text: string;
  timestamp: number;
}

export function isTerminalState(state: JobState): boolean {
  return state === "done" || state === "failed";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts tests/types.test.ts
git commit -m "feat: add shared types for jobs, workers, and bus messages"
```

---

## Task 2: Config Loader

**Files:**
- Create: `src/config.ts`, `agents.config.json`
- Test: `tests/config.test.ts`

The config declares the worker roster. Eleven roles across three bands plus
the orchestrator (orchestrator runs as Hub logic, so it is NOT in this file —
only spawnable workers are). Ports are assigned 4101–4111.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { parseConfig } from "../src/config.js";

describe("parseConfig", () => {
  it("parses a valid config with defaults applied", () => {
    const raw = {
      workers: [
        { name: "frontend", port: 4105, cwd: "." },
      ],
    };
    const cfg = parseConfig(raw);
    expect(cfg.workers[0]!.name).toBe("frontend");
    expect(cfg.workers[0]!.attach).toBe(true); // default
    expect(cfg.workers[0]!.agent).toBeNull(); // default
  });

  it("rejects duplicate ports", () => {
    const raw = {
      workers: [
        { name: "a", port: 4101, cwd: "." },
        { name: "b", port: 4101, cwd: "." },
      ],
    };
    expect(() => parseConfig(raw)).toThrow(/duplicate port/i);
  });

  it("rejects duplicate names", () => {
    const raw = {
      workers: [
        { name: "a", port: 4101, cwd: "." },
        { name: "a", port: 4102, cwd: "." },
      ],
    };
    expect(() => parseConfig(raw)).toThrow(/duplicate name/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — cannot find module `../src/config.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/config.ts
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { WorkerSpec } from "./types.js";

const WorkerSchema = z.object({
  name: z.string().min(1),
  port: z.number().int().min(1024).max(65535),
  cwd: z.string().min(1),
  agent: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  attach: z.boolean().default(true),
});

const ConfigSchema = z.object({
  workers: z.array(WorkerSchema).min(1),
});

export interface HubConfig {
  workers: WorkerSpec[];
}

export function parseConfig(raw: unknown): HubConfig {
  const parsed = ConfigSchema.parse(raw);

  const names = new Set<string>();
  const ports = new Set<number>();
  for (const w of parsed.workers) {
    if (names.has(w.name)) throw new Error(`duplicate name: ${w.name}`);
    if (ports.has(w.port)) throw new Error(`duplicate port: ${w.port}`);
    names.add(w.name);
    ports.add(w.port);
  }
  return { workers: parsed.workers };
}

export function loadConfig(path = "agents.config.json"): HubConfig {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return parseConfig(raw);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Create `agents.config.json` with the full roster**

```json
{
  "workers": [
    { "name": "visionary", "port": 4101, "cwd": ".", "agent": null, "model": null, "attach": true },
    { "name": "advocate", "port": 4102, "cwd": ".", "agent": null, "model": null, "attach": true },
    { "name": "skeptic", "port": 4103, "cwd": ".", "agent": null, "model": null, "attach": true },
    { "name": "decider", "port": 4104, "cwd": ".", "agent": null, "model": null, "attach": true },
    { "name": "architect", "port": 4105, "cwd": ".", "agent": null, "model": null, "attach": true },
    { "name": "frontend", "port": 4106, "cwd": ".", "agent": null, "model": null, "attach": true },
    { "name": "backend", "port": 4107, "cwd": ".", "agent": null, "model": null, "attach": true },
    { "name": "tester", "port": 4108, "cwd": ".", "agent": null, "model": null, "attach": true },
    { "name": "reviewer", "port": 4109, "cwd": ".", "agent": null, "model": null, "attach": true },
    { "name": "researcher", "port": 4110, "cwd": ".", "agent": null, "model": null, "attach": true },
    { "name": "docs", "port": 4111, "cwd": ".", "agent": null, "model": null, "attach": true }
  ]
}
```

- [ ] **Step 6: Verify config loads**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS (still green).

- [ ] **Step 7: Commit**

```bash
git add src/config.ts agents.config.json tests/config.test.ts
git commit -m "feat: add config loader and default 11-role worker roster"
```

---

## Task 3: opencode HTTP Client

**Files:**
- Create: `src/opencode-client.ts`
- Test: `tests/opencode-client.test.ts`

Typed wrapper over one worker's opencode HTTP API. Endpoints used (verified
against opencode server docs): `GET /global/health`, `POST /session`,
`POST /session/:id/prompt_async`, `GET /session/:id/message`,
`GET /session/:id/todo`, `POST /session/:id/abort`.

Tests inject a `fetch` function so no real server is needed.

- [ ] **Step 1: Write the failing test**

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/opencode-client.test.ts`
Expected: FAIL — cannot find module `../src/opencode-client.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/opencode-client.ts

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
  async promptAsync(sessionID: string, text: string, agent?: string | null, model?: string | null): Promise<void> {
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/opencode-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/opencode-client.ts tests/opencode-client.test.ts
git commit -m "feat: add typed opencode HTTP client wrapper"
```

---

## Task 4: Status Board

**Files:**
- Create: `src/status-board.ts`
- Test: `tests/status-board.test.ts`

Authoritative in-memory job state. Answers "what's done / running / failed"
and "what remains". Mirrors each change to a log file via an injected writer
(injected so tests stay filesystem-free).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { StatusBoard } from "../src/status-board.js";

describe("StatusBoard", () => {
  it("adds a queued job and lists it", () => {
    const board = new StatusBoard();
    const job = board.addJob("frontend", "build login form");
    expect(job.state).toBe("queued");
    expect(board.getAll()).toHaveLength(1);
  });

  it("transitions a job and records summary + remaining todos", () => {
    const board = new StatusBoard();
    const job = board.addJob("frontend", "build login form");
    board.update(job.id, { state: "running", sessionID: "ses_1" });
    board.update(job.id, { state: "done", summary: "form built", remainingTodos: [] });
    const got = board.get(job.id)!;
    expect(got.state).toBe("done");
    expect(got.sessionID).toBe("ses_1");
    expect(got.summary).toBe("form built");
  });

  it("summarizes counts by state", () => {
    const board = new StatusBoard();
    const a = board.addJob("frontend", "a");
    const b = board.addJob("backend", "b");
    board.update(a.id, { state: "done" });
    board.update(b.id, { state: "running" });
    expect(board.summary()).toEqual({ queued: 0, running: 1, done: 1, failed: 0 });
  });

  it("writes a log line on every change", () => {
    const writer = vi.fn();
    const board = new StatusBoard(writer);
    const job = board.addJob("frontend", "a");
    board.update(job.id, { state: "running" });
    expect(writer).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/status-board.test.ts`
Expected: FAIL — cannot find module `../src/status-board.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/status-board.ts
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

  summary(): Record<JobState, number> {
    const counts: Record<JobState, number> = { queued: 0, running: 0, done: 0, failed: 0 };
    for (const j of this.jobs.values()) counts[j.state]++;
    return counts;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/status-board.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/status-board.ts tests/status-board.test.ts
git commit -m "feat: add status board with state tracking and log mirroring"
```

---

## Task 5: Worker Manager

**Files:**
- Create: `src/worker-manager.ts`
- Test: `tests/worker-manager.test.ts`

Spawns each worker as a Windows Terminal tab running `opencode serve --port N`,
and (if `attach`) a second pane running `opencode attach`. The command-line
construction is the testable part; process spawning is injected so tests don't
launch real terminals. Also polls each worker's `/global/health` until ready.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { buildWtArgs, WorkerManager } from "../src/worker-manager.js";
import type { WorkerSpec } from "../src/types.js";

const spec: WorkerSpec = {
  name: "frontend",
  port: 4106,
  cwd: "C:\\proj",
  agent: null,
  model: null,
  attach: true,
};

describe("buildWtArgs", () => {
  it("builds a new-tab command running opencode serve on the right port", () => {
    const args = buildWtArgs(spec);
    const joined = args.join(" ");
    expect(joined).toContain("new-tab");
    expect(joined).toContain("--title");
    expect(joined).toContain("frontend");
    expect(joined).toContain("opencode serve --port 4106");
  });

  it("omits attach pane when attach is false", () => {
    const args = buildWtArgs({ ...spec, attach: false });
    expect(args.join(" ")).not.toContain("split-pane");
  });

  it("includes a split-pane attach when attach is true", () => {
    const args = buildWtArgs(spec);
    expect(args.join(" ")).toContain("split-pane");
    expect(args.join(" ")).toContain("opencode attach http://localhost:4106");
  });
});

describe("WorkerManager.spawnAll", () => {
  it("spawns one wt process per worker", async () => {
    const spawnFn = vi.fn(() => ({ pid: 999 }) as never);
    const mgr = new WorkerManager([spec], spawnFn);
    mgr.spawnAll();
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(spawnFn.mock.calls[0]![0]).toBe("wt.exe");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/worker-manager.test.ts`
Expected: FAIL — cannot find module `../src/worker-manager.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/worker-manager.ts
import { spawn, type ChildProcess } from "node:child_process";
import type { WorkerSpec } from "./types.js";

export type SpawnFn = (cmd: string, args: string[], opts: object) => { pid?: number };

/**
 * Build `wt.exe` args for one worker: a titled new tab running the headless
 * opencode server, plus an optional split pane attaching a visible TUI.
 */
export function buildWtArgs(spec: WorkerSpec): string[] {
  const serveCmd = `opencode serve --port ${spec.port} --hostname 127.0.0.1`;
  const args = [
    "new-tab",
    "--title",
    spec.name,
    "-d",
    spec.cwd,
    "powershell",
    "-NoExit",
    "-Command",
    serveCmd,
  ];
  if (spec.attach) {
    const attachCmd = `opencode attach http://localhost:${spec.port}`;
    args.push(
      ";",
      "split-pane",
      "-d",
      spec.cwd,
      "powershell",
      "-NoExit",
      "-Command",
      attachCmd,
    );
  }
  return args;
}

export class WorkerManager {
  private procs = new Map<string, { pid?: number }>();

  constructor(
    private readonly specs: WorkerSpec[],
    private readonly spawnFn: SpawnFn = defaultSpawn,
  ) {}

  spawnAll(): void {
    for (const spec of this.specs) {
      const proc = this.spawnFn("wt.exe", buildWtArgs(spec), {
        detached: true,
        stdio: "ignore",
      });
      this.procs.set(spec.name, proc);
    }
  }

  pidOf(name: string): number | undefined {
    return this.procs.get(name)?.pid;
  }
}

function defaultSpawn(cmd: string, args: string[], opts: object): ChildProcess {
  const child = spawn(cmd, args, opts as never);
  child.unref();
  return child;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/worker-manager.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker-manager.ts tests/worker-manager.test.ts
git commit -m "feat: add worker manager that spawns opencode workers in WT tabs"
```

---

## Task 6: Event Listener (SSE)

**Files:**
- Create: `src/event-listener.ts`
- Test: `tests/event-listener.test.ts`

Subscribes to a worker's `GET /event` SSE stream and emits parsed events to a
callback. opencode emits `session.idle` when a session finishes its turn — this
is how the Hub knows a worker completed without polling. The SSE line parser is
the testable unit; the stream source is injected as an async iterable.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { parseSseChunk } from "../src/event-listener.js";

describe("parseSseChunk", () => {
  it("parses a single data line into an event object", () => {
    const events = parseSseChunk('data: {"type":"session.idle","properties":{"sessionID":"ses_1"}}\n\n');
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("session.idle");
    expect(events[0]!.properties.sessionID).toBe("ses_1");
  });

  it("ignores non-data lines and blank keepalives", () => {
    const events = parseSseChunk(": keepalive\n\n");
    expect(events).toHaveLength(0);
  });

  it("parses multiple events in one chunk", () => {
    const chunk =
      'data: {"type":"a","properties":{}}\n\n' +
      'data: {"type":"b","properties":{}}\n\n';
    const events = parseSseChunk(chunk);
    expect(events.map((e) => e.type)).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/event-listener.test.ts`
Expected: FAIL — cannot find module `../src/event-listener.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/event-listener.ts

export interface OpencodeEvent {
  type: string;
  properties: Record<string, unknown> & { sessionID?: string };
}

/** Parse a raw SSE text chunk into zero or more events. */
export function parseSseChunk(chunk: string): OpencodeEvent[] {
  const events: OpencodeEvent[] = [];
  for (const block of chunk.split("\n\n")) {
    for (const line of block.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice("data:".length).trim();
      if (!payload) continue;
      try {
        events.push(JSON.parse(payload) as OpencodeEvent);
      } catch {
        // ignore malformed lines
      }
    }
  }
  return events;
}

export type EventHandler = (workerName: string, event: OpencodeEvent) => void;

/**
 * Connect to one worker's SSE stream and forward parsed events.
 * Reconnects on stream end. Returns a stop function.
 */
export function listenToWorker(
  workerName: string,
  baseUrl: string,
  onEvent: EventHandler,
  fetchFn: typeof fetch = fetch,
): () => void {
  let stopped = false;

  async function loop(): Promise<void> {
    while (!stopped) {
      try {
        const res = await fetchFn(`${baseUrl}/event`);
        if (!res.body) throw new Error("no body");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!stopped) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const split = buffer.lastIndexOf("\n\n");
          if (split === -1) continue;
          const ready = buffer.slice(0, split + 2);
          buffer = buffer.slice(split + 2);
          for (const ev of parseSseChunk(ready)) onEvent(workerName, ev);
        }
      } catch {
        if (!stopped) await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  void loop();
  return () => {
    stopped = true;
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/event-listener.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/event-listener.ts tests/event-listener.test.ts
git commit -m "feat: add SSE event listener for worker completion signals"
```

---

## Task 7: Message Bus

**Files:**
- Create: `src/bus.ts`
- Test: `tests/bus.test.ts`

Routes worker→worker (and broadcast) messages. Workers never connect to each
other; a message goes to the bus, which delivers it by issuing a `promptAsync`
to the target worker's opencode session. Every message is recorded for tracing.
The bus needs a way to resolve a worker name to its `OpencodeClient` + active
sessionID — provided via an injected resolver so it stays testable.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { MessageBus } from "../src/bus.js";

function makeResolver(names: string[]) {
  const calls: { name: string; text: string }[] = [];
  const resolver = (name: string) => {
    if (!names.includes(name)) return null;
    return {
      sessionID: `ses_${name}`,
      deliver: async (text: string) => {
        calls.push({ name, text });
      },
    };
  };
  return { resolver, calls };
}

describe("MessageBus", () => {
  it("delivers a directed message to one worker and records it", async () => {
    const { resolver, calls } = makeResolver(["backend"]);
    const bus = new MessageBus(resolver);
    await bus.send({ from: "frontend", to: "backend", text: "need API contract", timestamp: 1 });
    expect(calls).toEqual([{ name: "backend", text: expect.stringContaining("frontend") }]);
    expect(bus.history()).toHaveLength(1);
  });

  it("broadcasts to all workers except the sender", async () => {
    const { resolver, calls } = makeResolver(["frontend", "backend", "tester"]);
    const bus = new MessageBus(resolver, ["frontend", "backend", "tester"]);
    await bus.send({ from: "frontend", to: "*", text: "heads up", timestamp: 2 });
    expect(calls.map((c) => c.name).sort()).toEqual(["backend", "tester"]);
  });

  it("throws when target worker is unknown", async () => {
    const { resolver } = makeResolver(["backend"]);
    const bus = new MessageBus(resolver);
    await expect(
      bus.send({ from: "frontend", to: "ghost", text: "hi", timestamp: 3 }),
    ).rejects.toThrow(/unknown worker/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/bus.test.ts`
Expected: FAIL — cannot find module `../src/bus.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/bus.ts
import type { BusMessage } from "./types.js";

export interface WorkerHandle {
  sessionID: string;
  deliver: (text: string) => Promise<void>;
}

export type WorkerResolver = (name: string) => WorkerHandle | null;

export class MessageBus {
  private log: BusMessage[] = [];

  constructor(
    private readonly resolve: WorkerResolver,
    private readonly allWorkerNames: string[] = [],
  ) {}

  async send(msg: BusMessage): Promise<void> {
    this.log.push(msg);
    const wrapped = `[message from ${msg.from}] ${msg.text}`;

    if (msg.to === "*") {
      const targets = this.allWorkerNames.filter((n) => n !== msg.from);
      for (const name of targets) {
        const handle = this.resolve(name);
        if (handle) await handle.deliver(wrapped);
      }
      return;
    }

    const handle = this.resolve(msg.to);
    if (!handle) throw new Error(`unknown worker: ${msg.to}`);
    await handle.deliver(wrapped);
  }

  history(): BusMessage[] {
    return [...this.log];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/bus.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bus.ts tests/bus.test.ts
git commit -m "feat: add message bus for traced inter-worker communication"
```

---

## Task 8: Orchestrator

**Files:**
- Create: `src/orchestrator.ts`
- Test: `tests/orchestrator.test.ts`

The decision brain. Given a high-level goal and an explicit assignment (which
roles, what each should do), it: ensures each target worker has a session,
records a job on the board, and fires the task via `promptAsync`. It also
verifies completion by reading remaining todos. It does NOT itself call an LLM
to decompose — Hermes (Layer 3) provides the decomposition via the MCP
`dispatch_task` arguments. The orchestrator turns that structured assignment
into worker actions and tracked jobs.

Role bands are advisory metadata the orchestrator exposes so Hermes can sequence
deliberation (visionary/advocate/skeptic/decider) before execution
(architect/frontend/backend/tester) and support (reviewer/researcher/docs).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { Orchestrator } from "../src/orchestrator.js";
import { StatusBoard } from "../src/status-board.js";

function fakeClient() {
  return {
    createSession: vi.fn(async () => "ses_x"),
    promptAsync: vi.fn(async () => {}),
    remainingTodos: vi.fn(async () => [] as string[]),
    abort: vi.fn(async () => {}),
    isHealthy: vi.fn(async () => true),
  };
}

describe("Orchestrator", () => {
  it("dispatches assignments: creates a session, records a job, prompts worker", async () => {
    const board = new StatusBoard();
    const client = fakeClient();
    const orch = new Orchestrator(board, () => client as never);

    const jobs = await orch.dispatch([
      { role: "frontend", task: "build login form" },
    ]);

    expect(client.createSession).toHaveBeenCalledTimes(1);
    expect(client.promptAsync).toHaveBeenCalledWith("ses_x", "build login form", null, null);
    expect(jobs[0]!.state).toBe("running");
    expect(jobs[0]!.sessionID).toBe("ses_x");
    expect(board.getAll()).toHaveLength(1);
  });

  it("reuses an existing session for a role on a second dispatch", async () => {
    const board = new StatusBoard();
    const client = fakeClient();
    const orch = new Orchestrator(board, () => client as never);
    await orch.dispatch([{ role: "frontend", task: "a" }]);
    await orch.dispatch([{ role: "frontend", task: "b" }]);
    expect(client.createSession).toHaveBeenCalledTimes(1);
  });

  it("verifies a job: done when no todos remain", async () => {
    const board = new StatusBoard();
    const client = fakeClient();
    const orch = new Orchestrator(board, () => client as never);
    const [job] = await orch.dispatch([{ role: "frontend", task: "a" }]);
    await orch.verify(job!.id);
    expect(board.get(job!.id)!.state).toBe("done");
  });

  it("verifies a job: stays running when todos remain", async () => {
    const board = new StatusBoard();
    const client = fakeClient();
    client.remainingTodos = vi.fn(async () => ["finish wiring"]);
    const orch = new Orchestrator(board, () => client as never);
    const [job] = await orch.dispatch([{ role: "frontend", task: "a" }]);
    await orch.verify(job!.id);
    const got = board.get(job!.id)!;
    expect(got.state).toBe("running");
    expect(got.remainingTodos).toEqual(["finish wiring"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/orchestrator.test.ts`
Expected: FAIL — cannot find module `../src/orchestrator.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/orchestrator.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/orchestrator.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator.ts tests/orchestrator.test.ts
git commit -m "feat: add orchestrator for dispatch and completion verification"
```

---

## Task 9: MCP Server

**Files:**
- Create: `src/mcp-server.ts`
- Test: `tests/mcp-server.test.ts`

Exposes four tools to Hermes over MCP Streamable HTTP transport:
`dispatch_task`, `get_status`, `get_results`, `send_message`. The tool handlers
are thin adapters over Orchestrator + StatusBoard + MessageBus. We test the
handler logic directly (the MCP SDK wiring is covered by the smoke test in
Task 10).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { createToolHandlers } from "../src/mcp-server.js";
import { StatusBoard } from "../src/status-board.js";

function deps() {
  const board = new StatusBoard();
  const orchestrator = {
    dispatch: vi.fn(async (assignments: { role: string; task: string }[]) =>
      assignments.map((a) => board.addJob(a.role, a.task)),
    ),
    verify: vi.fn(async () => {}),
  };
  const bus = { send: vi.fn(async () => {}), history: () => [] };
  return { board, orchestrator, bus };
}

describe("MCP tool handlers", () => {
  it("dispatch_task forwards assignments to the orchestrator", async () => {
    const { board, orchestrator, bus } = deps();
    const handlers = createToolHandlers({ board, orchestrator: orchestrator as never, bus: bus as never });
    const res = await handlers.dispatch_task({
      assignments: [{ role: "frontend", task: "build form" }],
    });
    expect(orchestrator.dispatch).toHaveBeenCalledTimes(1);
    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0]!.role).toBe("frontend");
  });

  it("get_status returns the board summary and jobs", async () => {
    const { board, orchestrator, bus } = deps();
    board.addJob("frontend", "x");
    const handlers = createToolHandlers({ board, orchestrator: orchestrator as never, bus: bus as never });
    const res = await handlers.get_status({});
    expect(res.summary).toEqual({ queued: 1, running: 0, done: 0, failed: 0 });
    expect(res.jobs).toHaveLength(1);
  });

  it("send_message routes through the bus", async () => {
    const { board, orchestrator, bus } = deps();
    const handlers = createToolHandlers({ board, orchestrator: orchestrator as never, bus: bus as never });
    await handlers.send_message({ from: "orchestrator", to: "backend", text: "go" });
    expect(bus.send).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp-server.test.ts`
Expected: FAIL — cannot find module `../src/mcp-server.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/mcp-server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createServer } from "node:http";
import type { StatusBoard } from "./status-board.js";
import type { Orchestrator } from "./orchestrator.js";
import type { MessageBus } from "./bus.js";
import type { Job } from "./types.js";

export interface McpDeps {
  board: StatusBoard;
  orchestrator: Orchestrator;
  bus: MessageBus;
}

/** Pure tool handlers, independent of MCP transport — directly testable. */
export function createToolHandlers(deps: McpDeps) {
  return {
    async dispatch_task(args: { assignments: { role: string; task: string }[] }): Promise<{ jobs: Job[] }> {
      const jobs = await deps.orchestrator.dispatch(args.assignments);
      return { jobs };
    },
    async get_status(_args: Record<string, never>): Promise<{ summary: ReturnType<StatusBoard["summary"]>; jobs: Job[] }> {
      return { summary: deps.board.summary(), jobs: deps.board.getAll() };
    },
    async get_results(args: { jobId?: string }): Promise<{ jobs: Job[] }> {
      if (args.jobId) {
        const job = deps.board.get(args.jobId);
        return { jobs: job ? [job] : [] };
      }
      return { jobs: deps.board.getAll() };
    },
    async send_message(args: { from: string; to: string; text: string }): Promise<{ ok: true }> {
      await deps.bus.send({ ...args, timestamp: Date.now() });
      return { ok: true };
    },
  };
}

/** Register tools on an McpServer and start an HTTP transport on `port`. */
export async function startMcpServer(deps: McpDeps, port: number): Promise<() => void> {
  const handlers = createToolHandlers(deps);
  const server = new McpServer({ name: "ben-terminal-hub", version: "0.1.0" });

  server.registerTool(
    "dispatch_task",
    {
      description: "Decompose a goal into per-role assignments and run them in parallel.",
      inputSchema: {
        assignments: z.array(z.object({ role: z.string(), task: z.string() })),
      },
    },
    async (args) => {
      const res = await handlers.dispatch_task(args as never);
      return { content: [{ type: "text", text: JSON.stringify(res) }] };
    },
  );

  server.registerTool(
    "get_status",
    { description: "Return job board: counts by state and all jobs.", inputSchema: {} },
    async () => {
      const res = await handlers.get_status({});
      return { content: [{ type: "text", text: JSON.stringify(res) }] };
    },
  );

  server.registerTool(
    "get_results",
    { description: "Return outputs/remaining todos for one job or all jobs.", inputSchema: { jobId: z.string().optional() } },
    async (args) => {
      const res = await handlers.get_results(args as never);
      return { content: [{ type: "text", text: JSON.stringify(res) }] };
    },
  );

  server.registerTool(
    "send_message",
    {
      description: "Send a directed (or broadcast with to='*') message to a worker.",
      inputSchema: { from: z.string(), to: z.string(), text: z.string() },
    },
    async (args) => {
      const res = await handlers.send_message(args as never);
      return { content: [{ type: "text", text: JSON.stringify(res) }] };
    },
  );

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);

  const http = createServer((req, res) => {
    void transport.handleRequest(req, res);
  });
  http.listen(port, "127.0.0.1");

  return () => {
    http.close();
    void server.close();
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp-server.test.ts`
Expected: PASS.

> **Note:** If the installed MCP SDK version exposes a different registration
> API (e.g. `server.tool(...)` instead of `server.registerTool(...)`), adapt the
> `startMcpServer` wiring to match. The handler logic in `createToolHandlers`
> and its tests are SDK-independent and must stay unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server.ts tests/mcp-server.test.ts
git commit -m "feat: add MCP server exposing dispatch/status/results/message tools"
```

---

## Task 10: Hub Wiring + Event Integration

**Files:**
- Create: `src/hub.ts`
- Test: `tests/hub.test.ts`

Wires everything: load config → build an `OpencodeClient` per worker → start
worker manager (spawns WT tabs) → start SSE listeners → on `session.idle`,
auto-verify the matching job → build the bus resolver → start the MCP server.
The pure wiring logic we test is the SSE→verify bridge (`handleWorkerEvent`).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { handleWorkerEvent } from "../src/hub.js";
import { StatusBoard } from "../src/status-board.js";

describe("handleWorkerEvent", () => {
  it("verifies the job tied to a session when it goes idle", async () => {
    const board = new StatusBoard();
    const job = board.addJob("frontend", "a");
    board.update(job.id, { state: "running", sessionID: "ses_1" });
    const orchestrator = { verify: vi.fn(async () => {}), dispatch: vi.fn() };

    await handleWorkerEvent(board, orchestrator as never, "frontend", {
      type: "session.idle",
      properties: { sessionID: "ses_1" },
    });

    expect(orchestrator.verify).toHaveBeenCalledWith(job.id);
  });

  it("ignores non-idle events", async () => {
    const board = new StatusBoard();
    const orchestrator = { verify: vi.fn(async () => {}), dispatch: vi.fn() };
    await handleWorkerEvent(board, orchestrator as never, "frontend", {
      type: "message.updated",
      properties: { sessionID: "ses_1" },
    });
    expect(orchestrator.verify).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/hub.test.ts`
Expected: FAIL — cannot find module `../src/hub.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/hub.ts
import { appendFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { OpencodeClient } from "./opencode-client.js";
import { StatusBoard } from "./status-board.js";
import { WorkerManager } from "./worker-manager.js";
import { Orchestrator } from "./orchestrator.js";
import { MessageBus, type WorkerHandle } from "./bus.js";
import { listenToWorker, type OpencodeEvent } from "./event-listener.js";
import { startMcpServer } from "./mcp-server.js";
import type { WorkerSpec } from "./types.js";

const MCP_PORT = 4100;

/** SSE→verify bridge: when a worker's session goes idle, verify its job. */
export async function handleWorkerEvent(
  board: StatusBoard,
  orchestrator: Pick<Orchestrator, "verify">,
  _workerName: string,
  event: OpencodeEvent,
): Promise<void> {
  if (event.type !== "session.idle") return;
  const sessionID = event.properties.sessionID;
  if (!sessionID) return;
  const job = board.findBySession(sessionID);
  if (job) await orchestrator.verify(job.id);
}

export async function main(): Promise<void> {
  const cfg = loadConfig();
  const board = new StatusBoard((line) => appendFileSync("hub.log", line + "\n"));

  const clients = new Map<string, OpencodeClient>();
  const baseUrls = new Map<string, string>();
  for (const w of cfg.workers) {
    const url = `http://localhost:${w.port}`;
    baseUrls.set(w.name, url);
    clients.set(w.name, new OpencodeClient(url));
  }

  const clientFor = (role: string): OpencodeClient => {
    const c = clients.get(role);
    if (!c) throw new Error(`no client for role: ${role}`);
    return c;
  };

  const orchestrator = new Orchestrator(board, clientFor);

  // Bus resolver: map worker name -> handle that delivers via its active session.
  const resolver = (name: string): WorkerHandle | null => {
    const job = board.getAll().find((j) => j.role === name && j.sessionID);
    const client = clients.get(name);
    if (!job || !job.sessionID || !client) return null;
    const sessionID = job.sessionID;
    return { sessionID, deliver: (text: string) => client.promptAsync(sessionID, text) };
  };
  const bus = new MessageBus(resolver, cfg.workers.map((w) => w.name));

  // Spawn worker terminals.
  const manager = new WorkerManager(cfg.workers);
  manager.spawnAll();

  // Wait for each worker to become healthy, then listen to its events.
  await waitForWorkers(cfg.workers, clients);
  for (const w of cfg.workers) {
    listenToWorker(w.name, baseUrls.get(w.name)!, (name, ev) => {
      void handleWorkerEvent(board, orchestrator, name, ev);
    });
  }

  const stopMcp = await startMcpServer({ board, orchestrator, bus }, MCP_PORT);
  console.log(`Hub MCP server listening on http://localhost:${MCP_PORT}/mcp`);

  process.on("SIGINT", () => {
    stopMcp();
    process.exit(0);
  });
}

async function waitForWorkers(
  workers: WorkerSpec[],
  clients: Map<string, OpencodeClient>,
  timeoutMs = 60000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (const w of workers) {
    const client = clients.get(w.name)!;
    while (Date.now() < deadline) {
      if (await client.isHealthy()) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// Entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/hub.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all test files PASS.

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: PASS, `dist/` populated.

- [ ] **Step 7: Commit**

```bash
git add src/hub.ts tests/hub.test.ts
git commit -m "feat: wire Hub end-to-end with SSE-driven job verification"
```

---

## Task 11: Manual Smoke Test (one worker, real opencode)

**Files:**
- Create: `agents.smoke.json` (single worker for a low-friction manual check)

This is a manual verification step — no automated test. It confirms the Hub
actually drives a real opencode worker on this machine.

- [ ] **Step 1: Create a one-worker smoke config**

```json
{
  "workers": [
    { "name": "frontend", "port": 4106, "cwd": ".", "agent": null, "model": null, "attach": true }
  ]
}
```

- [ ] **Step 2: Start the Hub against the smoke config**

Run: `node dist/hub.js` after temporarily copying `agents.smoke.json` to
`agents.config.json` (or extend `loadConfig` to honor a `HUB_CONFIG` env var and
run `HUB_CONFIG=agents.smoke.json node dist/hub.js`).
Expected: a Windows Terminal tab titled `frontend` opens, `opencode serve` runs
on port 4106, an attach pane shows the TUI, and the Hub logs
`Hub MCP server listening on http://localhost:4100/mcp`.

- [ ] **Step 3: Verify worker health from another shell**

Run: `curl http://localhost:4106/global/health`
Expected: JSON `{ "healthy": true, ... }`.

- [ ] **Step 4: Verify the MCP endpoint is reachable**

Run: `curl http://localhost:4100/mcp` (expect an MCP/HTTP handshake response or
405 for a bare GET — a connection, not a refusal, is the signal it's listening).
Expected: a response from the server (not "connection refused").

- [ ] **Step 5: Document the result**

Note in the PR/commit whether the worker tab spawned, health passed, and the MCP
port accepted a connection.

- [ ] **Step 6: Commit**

```bash
git add agents.smoke.json
git commit -m "test: add single-worker smoke config for manual Hub verification"
```

---

## Hermes Integration (post-implementation note)

After Task 11 passes, connect Hermes to the Hub by adding the Hub as an MCP
server in Hermes's MCP config, pointing at `http://localhost:4100/mcp`
(Streamable HTTP). Hermes then sees `dispatch_task`, `get_status`,
`get_results`, and `send_message`. The correction loop is: Hermes calls
`dispatch_task` with role assignments → polls `get_status` → on incomplete jobs,
calls `dispatch_task` again with corrective tasks. Verify the exact MCP client
config against the Hermes docs (`hermes mcp` / config file) at integration time.

---

## Self-Review

- **Spec coverage:**
  - 3-layer architecture → Tasks 8 (orchestrator), 9 (MCP/Hermes seam), 5 (workers). ✓
  - Hub = bus + status board + MCP + orchestrator → Tasks 4, 7, 8, 9, wired in 10. ✓
  - Workers as `opencode serve` + `attach` in WT tabs → Task 5. ✓
  - Worker control via HTTP API (prompt_async, SSE, todo, abort) → Tasks 3, 6. ✓
  - Inter-worker comms through Hub bus → Task 7. ✓
  - 4 MCP tools → Task 9. ✓
  - Status board answers "done/remaining" → Tasks 4, 8 (verify). ✓
  - Localhost-only, no auth v1 → reflected in client/manager (127.0.0.1). ✓
  - 11-role roster + JSON config → Task 2. ✓
  - HTTP MCP transport → Task 9. ✓
- **Placeholder scan:** No TBD/TODO; every code step has full code. ✓
- **Type consistency:** `WorkerClient` surface in Task 8 matches `OpencodeClient`
  methods in Task 3 (`createSession`, `promptAsync`, `remainingTodos`, `abort`,
  `isHealthy`). `WorkerHandle`/`WorkerResolver` in Task 7 match the resolver
  built in Task 10. `OpencodeEvent` in Task 6 matches usage in Task 10. ✓

