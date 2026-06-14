import type { BusMessage } from "./types.js";

export interface WorkerHandle {
  sessionID: string;
  deliver: (text: string) => Promise<void>;
}

export type WorkerResolver = (name: string) => Promise<WorkerHandle | null> | WorkerHandle | null;

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
      // Fault-isolated fan-out: one worker's delivery failure must not abort
      // the broadcast to the rest. Failures are logged, not propagated.
      await Promise.all(
        targets.map(async (name) => {
          const handle = await this.resolve(name);
          if (!handle) return;
          try {
            await handle.deliver(wrapped);
          } catch (err) {
            console.error(`bus broadcast to ${name} failed:`, err);
          }
        }),
      );
      return;
    }

    const handle = await this.resolve(msg.to);
    if (!handle) throw new Error(`unknown worker: ${msg.to}`);
    await handle.deliver(wrapped);
  }

  history(): BusMessage[] {
    return [...this.log];
  }
}
