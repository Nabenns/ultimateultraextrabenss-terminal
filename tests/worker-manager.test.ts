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
    const spawnFn = vi.fn(
      (_cmd: string, _args: string[], _opts: object) => ({ pid: 999 }),
    );
    const mgr = new WorkerManager([spec], spawnFn);
    mgr.spawnAll();
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(spawnFn.mock.calls[0]![0]).toBe("wt.exe");
  });
});
