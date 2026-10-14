import type {
  PushCommandReadModel,
  PushResultReadModel,
} from "@polaris/contracts";
import {
  type BootstrapSource,
  isLocalStoreReady,
  type LocalWriter,
  pullLocalChanges,
} from "./bootstrap";
import type { OutboxCommand } from "./outbox/command";
import type { Outbox } from "./outbox/outbox";

/**
 * Sends the outbox to the server and applies what comes back (plan PR54):
 *
 * 1. the head of the queue, up to a batch, is marked "sending" BEFORE the request
 *    leaves, so a restart knows an answer may be missing;
 * 2. `sync.push` answers each command: accepted (it leaves the outbox), rejected
 *    (it stays, blocking those behind it, with the server's code) or not
 *    processed (back to waiting);
 * 3. if anything was accepted, the local collections are caught up from the
 *    change log, which replaces optimistic rows with the server's.
 *
 * A request that fails (no network, server down) puts the batch back to waiting
 * and throws: the same commands, with the same IDs, go out next time, and the
 * server replays what it already did. Sending twice is always safe.
 */
type PushFunction = (input: { commands: PushCommandReadModel[] }) => Promise<{
  results: PushResultReadModel[];
}>;

class SyncResponseMismatchError extends Error {
  constructor() {
    super("sync_push_response_mismatch");
    this.name = "SyncResponseMismatchError";
  }
}

export interface SyncOutboxRequest {
  /** Commands per request; the server accepts at most 50. */
  batchSize?: number;
  now?: () => Date;
  outbox: Outbox;
  /** Local collections to catch up after commands were accepted. */
  pull?: { source: BootstrapSource; writer: LocalWriter };
  push: PushFunction;
  /** Return interrupted commands to waiting first (once per session). */
  recover?: boolean;
}

/** A command the server accepted in this run, with its domain result. */
interface AcceptedCommand {
  commandId: string;
  result: unknown;
  type: string;
}

export interface SyncOutboxSummary {
  accepted: number;
  acceptedCommands: AcceptedCommand[];
  /** The command that now blocks the queue, if a rejection did. */
  blockedBy: OutboxCommand | null;
  notProcessed: number;
  rejected: number;
  replayed: number;
  requests: number;
}

function toPushCommand(command: OutboxCommand): PushCommandReadModel {
  return {
    baseVersion: command.baseVersion,
    commandId: command.commandId,
    createdAt: command.createdAt,
    deviceId: command.deviceId,
    lease: command.lease,
    payload: command.payload,
    type: command.type,
  };
}

async function waitingHead(
  outbox: Outbox,
  batchSize: number
): Promise<OutboxCommand[]> {
  const { commands } = await outbox.snapshot();
  const batch: OutboxCommand[] = [];
  for (const command of commands) {
    if (command.status !== "pending" || batch.length >= batchSize) {
      break;
    }
    batch.push(command);
  }
  return batch;
}

async function putBack(outbox: Outbox, batch: OutboxCommand[]): Promise<void> {
  for (const command of batch) {
    // biome-ignore lint/performance/noAwaitInLoops: each command is restored in order
    await outbox.retry(command.commandId);
  }
}

/** Applies the server's answers in order; true when the queue must stop. */
async function applyResults(
  outbox: Outbox,
  batch: OutboxCommand[],
  byId: Map<string, PushResultReadModel>,
  summary: SyncOutboxSummary
): Promise<boolean> {
  let stop = false;
  for (const command of batch) {
    const result = byId.get(command.commandId);
    if (result?.status === "accepted") {
      // biome-ignore lint/performance/noAwaitInLoops: results are applied in order
      await outbox.acknowledge(command.commandId);
      summary.accepted += 1;
      summary.acceptedCommands.push({
        commandId: command.commandId,
        result: result.result,
        type: command.type,
      });
      summary.replayed += result.replayed ? 1 : 0;
    } else if (result?.status === "rejected") {
      await outbox.reject(command.commandId, result.code ?? "rejected");
      summary.rejected += 1;
      stop = true;
    } else {
      await outbox.retry(command.commandId);
      summary.notProcessed += 1;
      stop = true;
    }
  }
  return stop;
}

async function catchUp(
  pull: { source: BootstrapSource; writer: LocalWriter },
  now: (() => Date) | undefined
): Promise<void> {
  const meta = await pull.writer.readMeta();
  if (isLocalStoreReady(meta) && meta?.cursor) {
    await pullLocalChanges(
      pull.source,
      pull.writer,
      meta.cursor,
      now ? { now } : {}
    );
  }
}

export async function syncOutbox(
  request: SyncOutboxRequest
): Promise<SyncOutboxSummary> {
  const { outbox, push } = request;
  const batchSize = Math.max(1, Math.min(request.batchSize ?? 20, 50));
  if (request.recover !== false) {
    await outbox.recoverInterrupted();
  }
  const summary: SyncOutboxSummary = {
    accepted: 0,
    acceptedCommands: [],
    blockedBy: null,
    notProcessed: 0,
    rejected: 0,
    replayed: 0,
    requests: 0,
  };

  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: batches are sent strictly in order
    const batch = await waitingHead(outbox, batchSize);
    if (batch.length === 0) {
      break;
    }
    for (const command of batch) {
      // biome-ignore lint/performance/noAwaitInLoops: marked one by one, in order
      await outbox.markSending(command.commandId);
    }
    let response: Awaited<ReturnType<PushFunction>>;
    try {
      summary.requests += 1;
      response = await push({ commands: batch.map(toPushCommand) });
    } catch (error) {
      await putBack(outbox, batch);
      throw error;
    }
    const byId = new Map(response.results.map((r) => [r.commandId, r]));
    if (batch.some((command) => !byId.has(command.commandId))) {
      await putBack(outbox, batch);
      throw new SyncResponseMismatchError();
    }
    if (await applyResults(outbox, batch, byId, summary)) {
      break;
    }
  }

  summary.blockedBy = (await outbox.snapshot()).blockedBy;
  if (summary.accepted > 0 && request.pull) {
    await catchUp(request.pull, request.now);
  }
  return summary;
}
