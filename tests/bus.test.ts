import { describe, it, expect, vi } from "vitest";
import { MessageBus } from "../src/bus.js";

function makeResolver(names: string[]) {
  const calls: { name: string; text: string }[] = [];
  const resolver = (name: string) => {
    if (!names.includes(name)) return null;
    return {
      sessionID: `ses_${name}`,
      deliver: async (text: string) => {
        calls.push({ name, text });
      },
    };
  };
  return { resolver, calls };
}

describe("MessageBus", () => {
  it("delivers a directed message to one worker and records it", async () => {
    const { resolver, calls } = makeResolver(["backend"]);
    const bus = new MessageBus(resolver);
    await bus.send({ from: "frontend", to: "backend", text: "need API contract", timestamp: 1 });
    expect(calls).toEqual([{ name: "backend", text: expect.stringContaining("frontend") }]);
    expect(bus.history()).toHaveLength(1);
  });

  it("broadcasts to all workers except the sender", async () => {
    const { resolver, calls } = makeResolver(["frontend", "backend", "tester"]);
    const bus = new MessageBus(resolver, ["frontend", "backend", "tester"]);
    await bus.send({ from: "frontend", to: "*", text: "heads up", timestamp: 2 });
    expect(calls.map((c) => c.name).sort()).toEqual(["backend", "tester"]);
  });

  it("throws when target worker is unknown", async () => {
    const { resolver } = makeResolver(["backend"]);
    const bus = new MessageBus(resolver);
    await expect(
      bus.send({ from: "frontend", to: "ghost", text: "hi", timestamp: 3 }),
    ).rejects.toThrow(/unknown worker/i);
  });

  it("isolates broadcast failures: one failing worker doesn't block the rest", async () => {
    const delivered: string[] = [];
    const resolver = (name: string) => ({
      sessionID: `ses_${name}`,
      deliver: async () => {
        if (name === "backend") throw new Error("backend down");
        delivered.push(name);
      },
    });
    const bus = new MessageBus(resolver, ["frontend", "backend", "tester"]);
    await expect(
      bus.send({ from: "frontend", to: "*", text: "ping", timestamp: 4 }),
    ).resolves.toBeUndefined();
    // backend threw, but tester still received.
    expect(delivered).toEqual(["tester"]);
  });

  it("supports an async resolver (e.g. session creation on demand)", async () => {
    const calls: string[] = [];
    const resolver = async (name: string) => {
      await new Promise((r) => setTimeout(r, 1));
      return { sessionID: `ses_${name}`, deliver: async () => { calls.push(name); } };
    };
    const bus = new MessageBus(resolver, ["frontend", "backend"]);
    await bus.send({ from: "frontend", to: "backend", text: "hi", timestamp: 5 });
    expect(calls).toEqual(["backend"]);
  });
});
