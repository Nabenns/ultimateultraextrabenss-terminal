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
});
