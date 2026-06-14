export interface OpencodeEvent {
  type: string;
  properties: Record<string, unknown> & { sessionID?: string };
}

/** Parse a raw SSE text chunk into zero or more events. */
export function parseSseChunk(chunk: string): OpencodeEvent[] {
  const events: OpencodeEvent[] = [];
  for (const block of chunk.split("\n\n")) {
    for (const line of block.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice("data:".length).trim();
      if (!payload) continue;
      try {
        events.push(JSON.parse(payload) as OpencodeEvent);
      } catch {
        // ignore malformed lines
      }
    }
  }
  return events;
}

export type EventHandler = (workerName: string, event: OpencodeEvent) => void;

/**
 * Connect to one worker's SSE stream and forward parsed events.
 * Reconnects on stream end. Returns a stop function.
 */
export function listenToWorker(
  workerName: string,
  baseUrl: string,
  onEvent: EventHandler,
  fetchFn: typeof fetch = fetch,
): () => void {
  let stopped = false;

  async function loop(): Promise<void> {
    while (!stopped) {
      try {
        const res = await fetchFn(`${baseUrl}/event`);
        if (!res.body) throw new Error("no body");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!stopped) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const split = buffer.lastIndexOf("\n\n");
          if (split === -1) continue;
          const ready = buffer.slice(0, split + 2);
          buffer = buffer.slice(split + 2);
          for (const ev of parseSseChunk(ready)) onEvent(workerName, ev);
        }
      } catch {
        if (!stopped) await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  void loop();
  return () => {
    stopped = true;
  };
}
