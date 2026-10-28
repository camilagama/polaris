import type {
  PushCommandReadModel,
  PushResultReadModel,
} from "@polaris/contracts";
import { isPayloadTooLarge } from "../lib/rpc-error";
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
 * One refusal is not kept for the person: an edit of a customer the owner
 * removed from the register for privacy (`customer_anonymized`). Nothing can be
 * done with it, and keeping it would keep the typed name, phone and email on
 * the device, so it is dropped and the queue goes on (ADR 0079).
 *
 * A batch closes by size too: the server refuses a body above `RPC_BODY_MAX_BYTES`
 * (413), and a queue of big commands sent by count alone would meet that wall again
 * with the same batch, forever. The batch closes at `PUSH_BATCH_TARGET_BYTES`, always
 * with at least one command (one alone is at most ~262 KiB). If the server still answers
 * 413, the batch goes back to waiting and the next one is half as long; a single command
 * that is still refused stays in the queue (it is neither dropped nor rejected) and the
 * run ends with `PushPayloadTooLargeError`.
 *
 * A request that fails (no network, server down) puts the batch back to waiting
 * and throws: the same commands, with the same IDs, go out next time, and the
 * server replays what it already did. Sending twice is always safe.
 */
export type PushFunction = (input: {
  commands: PushCommandReadModel[];
}) => Promise<{
  results: PushResultReadModel[];
}>;

/** The target size of a `sync.push` body: the server's ceiling is 512 KiB, the rest is the margin of the envelope. */
export const PUSH_BATCH_TARGET_BYTES = 400 * 1024;

/** One command is still refused as too large: it stays in the queue, and the run stops without a quick retry. */
export class PushPayloadTooLargeError extends Error {
  constructor(options: { cause: unknown }) {
    super("sync_push_payload_too_large", options);
    this.name = "PushPayloadTooLargeError";
  }
}

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
  /** Commands dropped because their content may no longer be kept (an anonymized customer). */
  discarded: number;
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

const encoder = new TextEncoder();

/** The bytes the command takes on the wire (UTF-8 of its JSON). */
function pushCommandBytes(command: OutboxCommand): number {
  return encoder.encode(JSON.stringify(toPushCommand(command))).length;
}

async function waitingHead(
  outbox: Outbox,
  batchSize: number
): Promise<OutboxCommand[]> {
  const { commands } = await outbox.snapshot();
  const batch: OutboxCommand[] = [];
  let bytes = 0;
  for (const command of commands) {
    if (command.status !== "pending" || batch.length >= batchSize) {
      break;
    }
    const size = pushCommandBytes(command);
    if (batch.length > 0 && bytes + size > PUSH_BATCH_TARGET_BYTES) {
      break;
    }
    bytes += size;
    batch.push(command);
  }
  return batch;
}

/** A refusal after which the command's content must not stay on the device. */
function dropsContent(command: OutboxCommand, code: string | null): boolean {
  return command.type === "customer.update" && code === "customer_anonymized";
}

/** Drops what an earlier version kept refused for the same reason. */
async function dropStaleRefusals(
  outbox: Outbox,
  summary: SyncOutboxSummary
): Promise<void> {
  const { commands } = await outbox.snapshot();
  for (const command of commands) {
    if (
      command.status === "rejected" &&
      dropsContent(command, command.rejection?.code ?? null)
    ) {
      // biome-ignore lint/performance/noAwaitInLoops: each removal is its own transaction
      await outbox.discard(command.commandId);
      summary.discarded += 1;
    }
  }
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
  // After a dropped command the server stopped the batch, but nothing is left
  // to block it: the rest goes back to waiting and is sent next.
  let dropped = false;
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
    } else if (
      result?.status === "rejected" &&
      dropsContent(command, result.code)
    ) {
      await outbox.discard(command.commandId);
      summary.discarded += 1;
      dropped = true;
    } else if (result?.status === "rejected") {
      await outbox.reject(command.commandId, result.code ?? "rejected");
      summary.rejected += 1;
      stop = true;
    } else {
      await outbox.retry(command.commandId);
      summary.notProcessed += 1;
      stop = stop || !dropped;
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

/**
 * Marks the batch "sending" and pushes it. A 413 puts it back and answers the size of the next one (half as
 * many commands); a 413 of a single command stays in the queue and ends the run. Any other failure puts it back and throws.
 */
async function sendBatch(
  outbox: Outbox,
  batch: OutboxCommand[],
  push: PushFunction
): Promise<
  | { response: Awaited<ReturnType<PushFunction>> }
  | { refusedAlone: unknown }
  | { splitTo: number }
> {
  for (const command of batch) {
    // biome-ignore lint/performance/noAwaitInLoops: marked one by one, in order
    await outbox.markSending(command.commandId);
  }
  try {
    return { response: await push({ commands: batch.map(toPushCommand) }) };
  } catch (error) {
    await putBack(outbox, batch);
    if (!isPayloadTooLarge(error)) {
      throw error;
    }
    if (batch.length === 1) {
      return { refusedAlone: error };
    }
    return { splitTo: Math.max(1, Math.floor(batch.length / 2)) };
  }
}

export async function syncOutbox(
  request: SyncOutboxRequest
): Promise<SyncOutboxSummary> {
  const { outbox, push } = request;
  let batchSize = Math.max(1, Math.min(request.batchSize ?? 20, 50));
  if (request.recover !== false) {
    await outbox.recoverInterrupted();
  }
  const summary: SyncOutboxSummary = {
    accepted: 0,
    acceptedCommands: [],
    blockedBy: null,
    discarded: 0,
    notProcessed: 0,
    rejected: 0,
    replayed: 0,
    requests: 0,
  };
  await dropStaleRefusals(outbox, summary);

  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: batches are sent strictly in order
    const batch = await waitingHead(outbox, batchSize);
    if (batch.length === 0) {
      break;
    }
    summary.requests += 1;
    const sent = await sendBatch(outbox, batch, push);
    if ("refusedAlone" in sent) {
      throw new PushPayloadTooLargeError({ cause: sent.refusedAlone });
    }
    if ("splitTo" in sent) {
      batchSize = sent.splitTo;
      continue;
    }
    const { response } = sent;
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
  // A dropped edit leaves the local customer row behind the server's anonymized one.
  if ((summary.accepted > 0 || summary.discarded > 0) && request.pull) {
    await catchUp(request.pull, request.now);
  }
  return summary;
}
