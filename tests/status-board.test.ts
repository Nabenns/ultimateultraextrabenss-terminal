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

  it("findLatestBySession returns the most-recently-updated job sharing a sessionID", () => {
    const board = new StatusBoard();
    const a = board.addJob("frontend", "a");
    board.update(a.id, { sessionID: "ses_shared" });
    const b = board.addJob("frontend", "b");
    board.update(b.id, { sessionID: "ses_shared" });
    expect(board.findLatestBySession("ses_shared")).toBe(board.get(b.id));
    expect(board.findLatestBySession("missing")).toBeUndefined();
  });
});

describe("StatusBoard timing", () => {
  it("stamps startedAt on first running transition and finishedAt on terminal", () => {
    const board = new StatusBoard();
    const job = board.addJob("frontend", "x");
    expect(board.get(job.id)!.startedAt).toBeNull();
    expect(board.get(job.id)!.finishedAt).toBeNull();

    board.update(job.id, { state: "running", sessionID: "s1" });
    const started = board.get(job.id)!.startedAt;
    expect(typeof started).toBe("number");

    // a second running update must not reset startedAt
    board.update(job.id, { state: "running" });
    expect(board.get(job.id)!.startedAt).toBe(started);

    board.update(job.id, { state: "done" });
    expect(typeof board.get(job.id)!.finishedAt).toBe("number");
  });
});
