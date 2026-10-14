import type { OutboxCommand } from "./command";
import type { OutboxStorage, OutboxTransaction } from "./outbox";

/**
 * An in-memory outbox storage with the same atomicity as the durable one:
 * a transaction either applies all its writes or none. For tests and for the
 * shared contract the IndexedDB storage is also held to.
 */
export class MemoryOutboxStorage implements OutboxStorage {
  private commands = new Map<string, OutboxCommand>();
  private lastSeq = 0;
  private queue: Promise<unknown> = Promise.resolve();

  /** Serialized like an IndexedDB readwrite transaction. */
  transaction<T>(work: (tx: OutboxTransaction) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const staged = new Map(this.commands);
      let seq = this.lastSeq;
      const tx: OutboxTransaction = {
        all: () => Promise.resolve([...staged.values()]),
        delete: (commandId) => {
          staged.delete(commandId);
          return Promise.resolve();
        },
        get: (commandId) => Promise.resolve(staged.get(commandId)),
        nextSeq: () => {
          seq += 1;
          return Promise.resolve(seq);
        },
        put: (command) => {
          staged.set(command.commandId, command);
          return Promise.resolve();
        },
      };
      const result = await work(tx);
      this.commands = staged;
      this.lastSeq = seq;
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
