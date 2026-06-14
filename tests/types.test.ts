import { describe, it, expect } from "vitest";
import { isTerminalState, type JobState } from "../src/types.js";

describe("isTerminalState", () => {
  it("treats done and failed as terminal", () => {
    expect(isTerminalState("done")).toBe(true);
    expect(isTerminalState("failed")).toBe(true);
  });
  it("treats queued and running as non-terminal", () => {
    expect(isTerminalState("queued")).toBe(false);
    expect(isTerminalState("running")).toBe(false);
  });
});
