import { describe, it, expect } from "vitest";
import { parseSseChunk } from "../src/event-listener.js";

describe("parseSseChunk", () => {
  it("parses a single data line into an event object", () => {
    const events = parseSseChunk('data: {"type":"session.idle","properties":{"sessionID":"ses_1"}}\n\n');
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("session.idle");
    expect(events[0]!.properties.sessionID).toBe("ses_1");
  });

  it("ignores non-data lines and blank keepalives", () => {
    const events = parseSseChunk(": keepalive\n\n");
    expect(events).toHaveLength(0);
  });

  it("parses multiple events in one chunk", () => {
    const chunk =
      'data: {"type":"a","properties":{}}\n\n' +
      'data: {"type":"b","properties":{}}\n\n';
    const events = parseSseChunk(chunk);
    expect(events.map((e) => e.type)).toEqual(["a", "b"]);
  });
});
