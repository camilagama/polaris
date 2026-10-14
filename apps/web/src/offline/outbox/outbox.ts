import { readUnverifiedOfflineLease } from "../../lib/offline-lease-token";
import {
  assertOutboxCommandInput,
  assertRejectionCode,
  InvalidOutboxCommandError,
  OUTBOX_MAX_PENDING,
  type OutboxCommand,
  type OutboxCommandInput,
  sameOutboxCommand,
} from "./command";

/**
 * The durable command outbox (plan PR52). Commands are appended in a local
 * monotonic order and sent in that order; a command whose answer is unknown is
 * resent with the same command ID (the server replays it), and one the server
 * refuses blocks those behind it until a person resolves it. Nothing is ever
 * dropped silently: removing a command is an explicit acknowledgement or an
 * explicit discard.
 *
 * Storage is behind `OutboxStorage` so the rules run the same on IndexedDB and
 * on an in-memory fake. Every method is one atomic storage transaction.
 */
export interface OutboxTransaction {
  all: () => Promise<OutboxCommand[]>;
  delete: (commandId: string) => Promise<void>;
  get: (commandId: string) => Promise<OutboxCommand | undefined>;
  /** The next local sequence number; never reused, even after deletions. */
  nextSeq: () => Promise<number>;
  put: (command: OutboxCommand) => Promise<void>;
}

export interface OutboxStorage {
  transaction: <T>(work: (tx: OutboxTransaction) => Promise<T>) => Promise<T>;
}

export class OutboxCommandConflictError extends Error {
  constructor() {
    super("outbox_command_conflict");
    this.name = "OutboxCommandConflictError";
  }
}

class OutboxFullError extends Error {
  constructor() {
    super("outbox_full");
    this.name = "OutboxFullError";
  }
}

export class OutboxCommandNotFoundError extends Error {
  constructor() {
    super("outbox_command_not_found");
    this.name = "OutboxCommandNotFoundError";
  }
}

export class OutboxCommandStateError extends Error {
  constructor(expected: string, actual: string) {
    super(`outbox_command_state:${expected}:${actual}`);
    this.name = "OutboxCommandStateError";
  }
}

/** New mutations are blocked: the lease is missing, mismatched or expired. */
export class OfflineLeaseUnusableError extends Error {
  readonly reason: "expired" | "invalid" | "mismatch";

  constructor(reason: "expired" | "invalid" | "mismatch") {
    super(`offline_lease_unusable:${reason}`);
    this.name = "OfflineLeaseUnusableError";
    this.reason = reason;
  }
}

export interface OutboxContext {
  deviceId: string;
  now?: () => Date;
  organizationId: string;
  storage: OutboxStorage;
  userId: string;
}

export interface OutboxSnapshot {
  blockedBy: OutboxCommand | null;
  commands: OutboxCommand[];
  pending: number;
  rejected: number;
  sending: number;
}

export class Outbox {
  private readonly context: OutboxContext;

  constructor(context: OutboxContext) {
    this.context = context;
  }

  private now(): Date {
    return (this.context.now ?? (() => new Date()))();
  }

  /**
   * Checks that the lease still authorizes new mutations on this device for
   * this user and organization. Expiry only stops NEW commands: queued ones are
   * preserved, and the server revalidates everything at sync anyway.
   */
  private assertLeaseUsable(lease: string): void {
    const claims = readUnverifiedOfflineLease(lease);
    if (claims === null) {
      throw new OfflineLeaseUnusableError("invalid");
    }
    if (
      claims.sub !== this.context.userId ||
      claims.org !== this.context.organizationId ||
      claims.dev !== this.context.deviceId
    ) {
      throw new OfflineLeaseUnusableError("mismatch");
    }
    if (this.now().getTime() >= claims.exp * 1000) {
      throw new OfflineLeaseUnusableError("expired");
    }
  }

  /**
   * Appends a command durably. The same command again (same ID and content)
   * returns the stored one, so a retried tap never queues a sale twice; the same
   * ID with different content is a conflict.
   */
  async enqueue(input: OutboxCommandInput): Promise<OutboxCommand> {
    assertOutboxCommandInput(input);
    if (
      input.organizationId !== this.context.organizationId ||
      input.deviceId !== this.context.deviceId
    ) {
      throw new InvalidOutboxCommandError("wrong_namespace");
    }
    return await this.context.storage.transaction(async (tx) => {
      const existing = await tx.get(input.commandId);
      if (existing) {
        if (sameOutboxCommand(existing, input)) {
          return existing;
        }
        throw new OutboxCommandConflictError();
      }
      this.assertLeaseUsable(input.lease);
      if ((await tx.all()).length >= OUTBOX_MAX_PENDING) {
        throw new OutboxFullError();
      }
      const command: OutboxCommand = {
        ...input,
        attempts: 0,
        createdAt: this.now().toISOString(),
        lastAttemptAt: null,
        rejection: null,
        seq: await tx.nextSeq(),
        status: "pending",
      };
      await tx.put(command);
      return command;
    });
  }

  /** Every command in send order, with what blocks the queue, if anything. */
  async snapshot(): Promise<OutboxSnapshot> {
    const commands = (await this.context.storage.transaction((tx) => tx.all()))
      .slice()
      .sort((left, right) => left.seq - right.seq);
    return {
      blockedBy: commands.find((c) => c.status === "rejected") ?? null,
      commands,
      pending: commands.filter((c) => c.status === "pending").length,
      rejected: commands.filter((c) => c.status === "rejected").length,
      sending: commands.filter((c) => c.status === "sending").length,
    };
  }

  /**
   * The command to send next: the first in order, if it is waiting. Nothing is
   * returned while the head is being sent or has been rejected, so the queue
   * never reorders or skips a refused command.
   */
  async next(): Promise<OutboxCommand | null> {
    const [head] = (await this.snapshot()).commands;
    return head?.status === "pending" ? head : null;
  }

  private update(
    commandId: string,
    change: (command: OutboxCommand) => OutboxCommand
  ): Promise<OutboxCommand> {
    return this.context.storage.transaction(async (tx) => {
      const command = await tx.get(commandId);
      if (!command) {
        throw new OutboxCommandNotFoundError();
      }
      const next = change(command);
      await tx.put(next);
      return next;
    });
  }

  /** Marks the command as sent (answer unknown) before the request leaves. */
  markSending(commandId: string): Promise<OutboxCommand> {
    return this.update(commandId, (command) => {
      if (command.status !== "pending") {
        throw new OutboxCommandStateError("pending", command.status);
      }
      return {
        ...command,
        attempts: command.attempts + 1,
        lastAttemptAt: this.now().toISOString(),
        status: "sending",
      };
    });
  }

  /** The server accepted (or replayed) it: it leaves the outbox. */
  acknowledge(commandId: string): Promise<void> {
    return this.context.storage.transaction(async (tx) => {
      const command = await tx.get(commandId);
      if (!command) {
        throw new OutboxCommandNotFoundError();
      }
      if (command.status !== "sending") {
        throw new OutboxCommandStateError("sending", command.status);
      }
      await tx.delete(commandId);
    });
  }

  /** The server refused it: it stays, blocks the queue and shows its reason. */
  async reject(commandId: string, code: string): Promise<OutboxCommand> {
    assertRejectionCode(code);
    return await this.update(commandId, (command) => {
      if (command.status !== "sending") {
        throw new OutboxCommandStateError("sending", command.status);
      }
      return {
        ...command,
        rejection: { at: this.now().toISOString(), code },
        status: "rejected",
      };
    });
  }

  /** After a person fixed the cause (or after a network failure): send again. */
  retry(commandId: string): Promise<OutboxCommand> {
    return this.update(commandId, (command) => {
      if (command.status === "pending") {
        return command;
      }
      return { ...command, rejection: null, status: "pending" };
    });
  }

  /**
   * Recovery after a restart: a command left "sending" has an unknown answer, so
   * it goes back to waiting. Resending is safe because the command ID is the
   * idempotency key. Returns how many were recovered.
   */
  recoverInterrupted(): Promise<number> {
    return this.context.storage.transaction(async (tx) => {
      const interrupted = (await tx.all()).filter(
        (command) => command.status === "sending"
      );
      for (const command of interrupted) {
        // biome-ignore lint/performance/noAwaitInLoops: one atomic transaction, written in order
        await tx.put({ ...command, status: "pending" });
      }
      return interrupted.length;
    });
  }

  /** The explicit "discard this command" action; never called implicitly. */
  discard(commandId: string): Promise<void> {
    return this.context.storage.transaction(async (tx) => {
      if (!(await tx.get(commandId))) {
        throw new OutboxCommandNotFoundError();
      }
      await tx.delete(commandId);
    });
  }
}
