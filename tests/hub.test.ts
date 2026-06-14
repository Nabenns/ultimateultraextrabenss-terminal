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

  it("verifies the LATEST job when multiple jobs share a session", async () => {
    const board = new StatusBoard();
    const first = board.addJob("frontend", "a");
    board.update(first.id, { state: "running", sessionID: "ses_1" });
    const second = board.addJob("frontend", "b");
    board.update(second.id, { state: "running", sessionID: "ses_1" });
    const orchestrator = { verify: vi.fn(async () => {}), dispatch: vi.fn() };

    await handleWorkerEvent(board, orchestrator as never, "frontend", {
      type: "session.idle",
      properties: { sessionID: "ses_1" },
    });

    expect(orchestrator.verify).toHaveBeenCalledWith(second.id);
  });

  it("does not reject when orchestrator.verify rejects", async () => {
    const board = new StatusBoard();
    const job = board.addJob("frontend", "a");
    board.update(job.id, { state: "running", sessionID: "ses_1" });
    const orchestrator = {
      verify: vi.fn(async () => {
        throw new Error("HTTP 500");
      }),
      dispatch: vi.fn(),
    };

    await expect(
      handleWorkerEvent(board, orchestrator as never, "frontend", {
        type: "session.idle",
        properties: { sessionID: "ses_1" },
      }),
    ).resolves.toBeUndefined();
  });
});
