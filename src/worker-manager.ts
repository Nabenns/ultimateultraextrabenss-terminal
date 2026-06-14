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
