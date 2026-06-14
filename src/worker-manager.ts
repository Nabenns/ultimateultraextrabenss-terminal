import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { WorkerSpec } from "./types.js";

export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => { pid?: number };

/**
 * Build `wt.exe` args for one worker: a titled new tab running the headless
 * opencode server, plus an optional split pane attaching a visible TUI.
 */
// agent/model are per-session settings applied by the Hub when it creates sessions against the running server, not server-launch flags.
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
    const attachCmd = `opencode attach http://127.0.0.1:${spec.port}`;
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
      this.spawnOne(spec.name);
    }
  }

  /** (Re)spawn a single worker by name. Used for startup and auto-restart. */
  spawnOne(name: string): void {
    const spec = this.specs.find((s) => s.name === name);
    if (!spec) throw new Error(`unknown worker: ${name}`);
    const proc = this.spawnFn("wt.exe", buildWtArgs(spec), {
      detached: true,
      stdio: "ignore",
    });
    this.procs.set(spec.name, proc);
  }

  pidOf(name: string): number | undefined {
    return this.procs.get(name)?.pid;
  }
}

function defaultSpawn(cmd: string, args: string[], opts: SpawnOptions): ChildProcess {
  const child = spawn(cmd, args, opts);
  child.unref();
  return child;
}
