import type { BusMessage } from "./types.js";

export interface WorkerHandle {
  sessionID: string;
  deliver: (text: string) => Promise<void>;
}

export type WorkerResolver = (name: string) => WorkerHandle | null;

export class MessageBus {
  private log: BusMessage[] = [];

  constructor(
    private readonly resolve: WorkerResolver,
    private readonly allWorkerNames: string[] = [],
  ) {}

  async send(msg: BusMessage): Promise<void> {
    this.log.push(msg);
    const wrapped = `[message from ${msg.from}] ${msg.text}`;

    if (msg.to === "*") {
      const targets = this.allWorkerNames.filter((n) => n !== msg.from);
      for (const name of targets) {
        const handle = this.resolve(name);
        if (handle) await handle.deliver(wrapped);
      }
      return;
    }

    const handle = this.resolve(msg.to);
    if (!handle) throw new Error(`unknown worker: ${msg.to}`);
    await handle.deliver(wrapped);
  }

  history(): BusMessage[] {
    return [...this.log];
  }
}
