import { describe, it, expect } from "vitest";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, loadConfig } from "../src/config.js";

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

  it("rejects a worker using the reserved Hub MCP port 4100", () => {
    const raw = {
      workers: [{ name: "frontend", port: 4100, cwd: "." }],
    };
    expect(() => parseConfig(raw)).toThrow(/reserved Hub MCP port 4100/i);
  });
});

describe("loadConfig", () => {
  it("honors HUB_CONFIG env var when no path is passed, and explicit path wins", () => {
    const unique = `hub-config-test-${process.pid}-${Date.now()}`;
    const envFile = join(tmpdir(), `${unique}-env.json`);
    const explicitFile = join(tmpdir(), `${unique}-explicit.json`);
    const prevEnv = process.env.HUB_CONFIG;

    try {
      writeFileSync(
        envFile,
        JSON.stringify({ workers: [{ name: "envworker", port: 4201, cwd: "." }] }),
        "utf8",
      );
      writeFileSync(
        explicitFile,
        JSON.stringify({ workers: [{ name: "explicitworker", port: 4202, cwd: "." }] }),
        "utf8",
      );

      // env var honored when no arg passed
      process.env.HUB_CONFIG = envFile;
      const fromEnv = loadConfig();
      expect(fromEnv.workers).toHaveLength(1);
      expect(fromEnv.workers[0]!.name).toBe("envworker");
      expect(fromEnv.workers[0]!.port).toBe(4201);

      // explicit path beats env
      const fromExplicit = loadConfig(explicitFile);
      expect(fromExplicit.workers[0]!.name).toBe("explicitworker");
    } finally {
      if (prevEnv === undefined) delete process.env.HUB_CONFIG;
      else process.env.HUB_CONFIG = prevEnv;
      rmSync(envFile, { force: true });
      rmSync(explicitFile, { force: true });
    }
  });
});
