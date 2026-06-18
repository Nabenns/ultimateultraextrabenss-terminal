import { describe, it, expect } from "vitest";
import { parseSseChunk, listenToWorker } from "../src/event-listener.js";

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

describe("listenToWorker", () => {
  it("stop() aborts the stream and stops delivering events", async () => {
    const received: string[] = [];
    let pulled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled) return; // only emit once, then park
        pulled = true;
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"type":"session.idle","properties":{"sessionID":"ses_1"}}\n\n',
          ),
        );
      },
    });
    const fetchFn = (async (_url: string, _init?: RequestInit) =>
      new Response(stream)) as unknown as typeof fetch;

    const stop = listenToWorker(
      "frontend",
      "http://127.0.0.1:4106",
      (_n, ev) => received.push(ev.type),
      fetchFn,
    );
    // allow the microtasks to flush the first event
    await new Promise((r) => setTimeout(r, 50));
    stop();
    expect(received).toContain("session.idle");
  });
});
