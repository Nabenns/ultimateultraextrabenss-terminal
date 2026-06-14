import { describe, it, expect, vi } from "vitest";
import type { SpawnOptions } from "node:child_process";
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
    expect(args[0]).toBe("new-tab");
    expect(joined).toContain("--title");
    expect(args[args.indexOf("--title") + 1]).toBe("frontend");
    expect(joined).toContain("opencode serve --port 4106");
  });

  it("omits attach pane when attach is false", () => {
    const args = buildWtArgs({ ...spec, attach: false });
    expect(args.join(" ")).not.toContain("split-pane");
  });

  it("includes a split-pane attach when attach is true", () => {
    const args = buildWtArgs(spec);
    expect(args.join(" ")).toContain("split-pane");
    expect(args.join(" ")).toContain("opencode attach http://127.0.0.1:4106");
  });

  it("chains attach pane with a standalone ; delimiter", () => {
    const withAttach = buildWtArgs(spec);
    expect(withAttach.includes(";")).toBe(true);
    const withoutAttach = buildWtArgs({ ...spec, attach: false });
    expect(withoutAttach.includes(";")).toBe(false);
  });
});

describe("WorkerManager.spawnAll", () => {
  it("spawns one wt process per worker", async () => {
    const spawnFn = vi.fn(
      (_cmd: string, _args: string[], _opts: SpawnOptions) => ({ pid: 999 }),
    );
    const mgr = new WorkerManager([spec], spawnFn);
    mgr.spawnAll();
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(spawnFn.mock.calls[0]![0]).toBe("wt.exe");
  });

  it("records the spawned pid retrievable via pidOf", async () => {
    const spawnFn = vi.fn(
      (_cmd: string, _args: string[], _opts: SpawnOptions) => ({ pid: 999 }),
    );
    const mgr = new WorkerManager([spec], spawnFn);
    mgr.spawnAll();
    expect(mgr.pidOf("frontend")).toBe(999);
  });

  it("spawnOne respawns a single named worker", async () => {
    const spawnFn = vi.fn(
      (_cmd: string, _args: string[], _opts: SpawnOptions) => ({ pid: 777 }),
    );
    const mgr = new WorkerManager([spec], spawnFn);
    mgr.spawnOne("frontend");
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(spawnFn.mock.calls[0]![0]).toBe("wt.exe");
    expect(mgr.pidOf("frontend")).toBe(777);
  });

  it("spawnOne throws for an unknown worker name", async () => {
    const spawnFn = vi.fn(
      (_cmd: string, _args: string[], _opts: SpawnOptions) => ({ pid: 1 }),
    );
    const mgr = new WorkerManager([spec], spawnFn);
    expect(() => mgr.spawnOne("ghost")).toThrow(/unknown worker/i);
  });
});
