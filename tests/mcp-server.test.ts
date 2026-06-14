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
