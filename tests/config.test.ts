import { describe, it, expect } from "vitest";
import { parseConfig } from "../src/config.js";

describe("parseConfig", () => {
  it("parses a valid config with defaults applied", () => {
    const raw = {
      workers: [
        { name: "frontend", port: 4105, cwd: "." },
      ],
    };
    const cfg = parseConfig(raw);
    expect(cfg.workers[0]!.name).toBe("frontend");
    expect(cfg.workers[0]!.attach).toBe(true); // default
    expect(cfg.workers[0]!.agent).toBeNull(); // default
  });

  it("rejects duplicate ports", () => {
    const raw = {
      workers: [
        { name: "a", port: 4101, cwd: "." },
        { name: "b", port: 4101, cwd: "." },
      ],
    };
    expect(() => parseConfig(raw)).toThrow(/duplicate port/i);
  });

  it("rejects duplicate names", () => {
    const raw = {
      workers: [
        { name: "a", port: 4101, cwd: "." },
        { name: "a", port: 4102, cwd: "." },
      ],
    };
    expect(() => parseConfig(raw)).toThrow(/duplicate name/i);
  });
});
