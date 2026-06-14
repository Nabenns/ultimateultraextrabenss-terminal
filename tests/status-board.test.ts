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

  it("update throws on unknown job id", () => {
    const board = new StatusBoard();
    expect(() => board.update("nope", { state: "done" })).toThrow(/unknown job/i);
  });

  it("findBySession returns the job matching a sessionID", () => {
    const board = new StatusBoard();
    const job = board.addJob("frontend", "build login form");
    board.update(job.id, { sessionID: "ses_42" });
    expect(board.findBySession("ses_42")).toBe(board.get(job.id));
    expect(board.findBySession("missing")).toBeUndefined();
  });
});
