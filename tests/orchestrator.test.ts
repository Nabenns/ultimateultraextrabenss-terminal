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
