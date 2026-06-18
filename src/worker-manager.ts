import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { WorkerSpec } from "./types.js";

export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => { pid?: number };

/** Kills whatever process is listening on a TCP port. Injected for testability. */
export type PortKiller = (port: number) => void;

/**
 * Build `wt.exe` args for one worker: a titled new tab running the headless
 * opencode server, plus an optional split pane attaching a visible TUI.
 */
// agent/model are per-session settings applied by the Hub when it creates sessions against the running server, not server-launch flags.

// Headless workers have no TUI to approve permission prompts, so an inherited
// "bash"/"edit": "ask" would hang the worker forever the moment it runs a tool.
// We pass a worker-only config via the OPENCODE_CONFIG_CONTENT env var (merged
// last by opencode) that auto-allows actions — without touching the user's
// global config. It goes through the spawn ENVIRONMENT (inherited wt → pwsh →
// opencode), NOT the command line, to avoid colliding with wt.exe's ';'
// subcommand delimiter.
export const WORKER_PERMISSION_CONFIG = JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  permission: { bash: "allow", edit: "allow", webfetch: "allow" },
});

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
    private readonly killPort: PortKiller = defaultKillPort,
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
      // Forwarded by wt.exe to the pane's shell and inherited by opencode.
      env: { ...process.env, OPENCODE_CONFIG_CONTENT: WORKER_PERMISSION_CONFIG },
    });
    this.procs.set(spec.name, proc);
  }

  /**
   * Kill the opencode server on a worker's port. Workers are launched via
   * wt.exe (which forwards then exits), so we can't track the opencode PID —
   * killing by the known port is the reliable cleanup path on Windows.
   */
  killOne(name: string): void {
    const spec = this.specs.find((s) => s.name === name);
    if (!spec) throw new Error(`unknown worker: ${name}`);
    this.killPort(spec.port);
  }

  /** Kill every configured worker's server. Used for cleanup on shutdown. */
  killAll(): void {
    for (const spec of this.specs) {
      try {
        this.killPort(spec.port);
      } catch {
        // best-effort cleanup; keep going
      }
    }
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

/** Windows: find the PID listening on `port` and taskkill it (and its tree). */
function defaultKillPort(port: number): void {
  // PowerShell one-liner: resolve owning PID via Get-NetTCPConnection, then kill.
  const ps = `$p=(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess; if ($p) { taskkill /PID $p /T /F }`;
  const child = spawn("powershell", ["-NoProfile", "-Command", ps], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}
