import {
  PRODUCT_IMPORT_BATCH_MAX_ROWS,
  type ProductImportRowInput,
  type ProductImportRowResult,
} from "@polaris/contracts";
import { isConnectionFailure, rpcErrorCode } from "../lib/rpc-error";
import { uuidv7 } from "../lib/uuidv7";
import type { ImportReadyRow } from "./product-import-rows";

/**
 * Sending the rows of an import (corte 2.5): one slice at a time, the next only after the answer to the previous one,
 * and at a pace below the bucket of the import (`RPC_BULK_RATE_LIMIT`, 12 calls per minute), so the sales of the
 * same session keep their quota. The IDs of each row (product, variant, stock command) are born once per import and
 * live only in memory, in the `ImportRun`: sending a slice again after a lost answer, or continuing after a stop,
 * sends the same IDs, and the server answers `repeated` instead of creating twice (AC-5). Nothing is kept on the
 * device (AC-7), and nothing goes to the offline queue.
 *
 * A 429 pauses for the time the server asked (`Retry-After`) and sends the same slice once after it, never right
 * away. A failure that may have taken effect (no answer, a fault of the server) is tried again a few times and then
 * stops the run where it was: `runImport` again continues from that slice, one row at a time, so a row that keeps
 * failing is found alone and `skipStuckRow` can leave it out without holding back the rows after it. The plan's
 * refusal stops it for good and says so, for the screen's notice of the limit (corte 1.6).
 */

/** At most one slice every 6 s: 10 calls per minute, below the 12 of the bucket. */
export const IMPORT_SLICE_INTERVAL_MS = 6000;
/** The wait after a 429 whose `Retry-After` did not come through. */
const RATE_LIMITED_FALLBACK_MS = 60_000;
/** The bounds of the wait after a 429: never right away, never longer than the window of the bucket twice. */
const RATE_LIMITED_MIN_MS = 1000;
const RATE_LIMITED_MAX_MS = 120_000;
/** The 429s in a row before the run stops (another tab is importing too). */
const MAX_RATE_LIMITED_IN_A_ROW = 3;
/** The waits before sending again a slice whose answer did not come. */
const TRANSIENT_RETRY_MS = [2000, 5000] as const;

export interface ImportRun {
  readonly importId: string;
  /** The index of the first row not answered yet: where a stopped run continues. */
  nextIndex: number;
  /** Up to this index the rows go one at a time: the slice there stopped without an answer. */
  oneByOneUntil: number;
  readonly results: Map<number, ProductImportRowResult>;
  readonly rows: readonly ProductImportRowInput[];
  /** The rows left out by `skipStuckRow`: they never had an answer, so they may or may not have entered. */
  readonly skipped: Set<number>;
}

/** A new import of the ready rows, with every ID named now, once. */
export function createImportRun(
  rows: readonly ImportReadyRow[],
  newId: () => string = uuidv7
): ImportRun {
  return {
    importId: newId(),
    nextIndex: 0,
    oneByOneUntil: 0,
    results: new Map(),
    rows: rows.map((row) => ({
      categoryId: row.categoryId,
      description: row.description,
      initialStock: row.initialStock
        ? { ...row.initialStock, commandId: newId() }
        : null,
      listPrice: row.listPrice,
      name: row.name,
      productId: newId(),
      rowNumber: row.rowNumber,
      variantId: newId(),
    })),
    skipped: new Set(),
  };
}

/**
 * Leaves out the row where a stopped run is, so the rows after it go on: for a row that, sent alone, kept stopping
 * the run without an answer. It is never answered, so it goes to the file of the rows that failed.
 */
export function skipStuckRow(run: ImportRun): void {
  const row = run.rows[run.nextIndex];
  if (row !== undefined) {
    run.skipped.add(row.rowNumber);
    run.nextIndex += 1;
  }
}

export type ImportStop =
  /** Every row has its answer. */
  | { kind: "done" }
  /** The plan has no more room: the rows not answered did not enter for that reason (the notice of corte 1.6). */
  | { kind: "limit_reached" }
  /** No answer, or a fault of the server: the slice may have entered; `runImport` again continues from it. */
  | { error: unknown; kind: "interrupted" }
  /** The server refused the call itself (the session, the permission, the request): nothing of the slice entered. */
  | { error: unknown; kind: "refused" }
  /** The bucket of the import kept refusing: continue later. */
  | { kind: "rate_limited" }
  | { kind: "aborted" };

export interface ImportSendDependencies {
  now?: () => number;
  /** Each slice answered, for the progress on the screen. */
  onProgress?: (run: ImportRun) => void;
  organizationId: string;
  /** The `Retry-After` of the last 429, once (`connection.takeRetryAfterMs`). */
  retryAfterMs: () => number | null;
  /** `product.importBatch`. */
  send: (input: {
    importId: string;
    organizationId: string;
    rows: ProductImportRowInput[];
  }) => Promise<{ results: ProductImportRowResult[] }>;
  signal?: AbortSignal;
  sliceSize?: number;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function waitFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function isTransient(error: unknown): boolean {
  const code = rpcErrorCode(error);
  return (
    isConnectionFailure(error) ||
    code === undefined ||
    code === "SERVICE_UNAVAILABLE" ||
    code === "INTERNAL_SERVER_ERROR" ||
    code === "BAD_GATEWAY" ||
    code === "GATEWAY_TIMEOUT"
  );
}

type SliceOutcome =
  | { kind: "answered"; results: ProductImportRowResult[] }
  | Exclude<ImportStop, { kind: "done" | "limit_reached" }>;

/** One slice, sent until it has an answer, a 429 pause and the retries of a lost answer included. */
async function sendSlice(
  run: ImportRun,
  rows: ProductImportRowInput[],
  dependencies: ImportSendDependencies,
  wait: NonNullable<ImportSendDependencies["wait"]>
): Promise<SliceOutcome> {
  let rateLimited = 0;
  let transient = 0;
  for (;;) {
    if (dependencies.signal?.aborted) {
      return { kind: "aborted" };
    }
    try {
      // biome-ignore lint/performance/noAwaitInLoops: the same slice is sent again only after its answer
      const answer = await dependencies.send({
        importId: run.importId,
        organizationId: dependencies.organizationId,
        rows,
      });
      return { kind: "answered", results: answer.results };
    } catch (error) {
      if (rpcErrorCode(error) === "TOO_MANY_REQUESTS") {
        rateLimited += 1;
        if (rateLimited >= MAX_RATE_LIMITED_IN_A_ROW) {
          return { kind: "rate_limited" };
        }
        // the refused call ran nothing: the same slice goes again, only after the time the server asked
        await wait(
          Math.min(
            Math.max(
              dependencies.retryAfterMs() ?? RATE_LIMITED_FALLBACK_MS,
              RATE_LIMITED_MIN_MS
            ),
            RATE_LIMITED_MAX_MS
          ),
          dependencies.signal
        );
        continue;
      }
      if (!isTransient(error)) {
        return { error, kind: "refused" };
      }
      const delay = TRANSIENT_RETRY_MS[transient];
      if (delay === undefined) {
        return { error, kind: "interrupted" };
      }
      transient += 1;
      await wait(delay, dependencies.signal);
    }
  }
}

/** The rows of the run that did not enter because of the plan, once a slice said the plan is full. */
function markLimitReached(run: ImportRun): void {
  for (const row of run.rows.slice(run.nextIndex)) {
    if (!run.results.has(row.rowNumber)) {
      run.results.set(row.rowNumber, {
        rowNumber: row.rowNumber,
        status: "limit_reached",
      });
    }
  }
  run.nextIndex = run.rows.length;
}

/** Keeps the answer of each row of the slice; false, keeping nothing, when a row sent has no answer. */
function recordAnswer(
  run: ImportRun,
  rows: readonly ProductImportRowInput[],
  results: readonly ProductImportRowResult[]
): boolean {
  const answered = new Map(results.map((result) => [result.rowNumber, result]));
  const ordered = rows.map((row) => answered.get(row.rowNumber));
  if (ordered.some((result) => result === undefined)) {
    return false;
  }
  for (const result of ordered) {
    if (result) {
      run.results.set(result.rowNumber, result);
    }
  }
  return true;
}

/** Sends the rows of the run from where it stopped, a slice at a time, until every row has its answer or it stops. */
export async function runImport(
  run: ImportRun,
  dependencies: ImportSendDependencies
): Promise<ImportStop> {
  const wait = dependencies.wait ?? waitFor;
  const now = dependencies.now ?? Date.now;
  const sliceSize = Math.min(
    dependencies.sliceSize ?? PRODUCT_IMPORT_BATCH_MAX_ROWS,
    PRODUCT_IMPORT_BATCH_MAX_ROWS
  );
  let lastSentAt: number | null = null;
  while (run.nextIndex < run.rows.length) {
    if (lastSentAt !== null) {
      const elapsed = now() - lastSentAt;
      if (elapsed < IMPORT_SLICE_INTERVAL_MS) {
        // biome-ignore lint/performance/noAwaitInLoops: the pace of the import is one slice at a time
        await wait(IMPORT_SLICE_INTERVAL_MS - elapsed, dependencies.signal);
      }
    }
    const size = run.nextIndex < run.oneByOneUntil ? 1 : sliceSize;
    const rows = run.rows.slice(run.nextIndex, run.nextIndex + size);
    lastSentAt = now();
    const outcome = await sendSlice(run, rows, dependencies, wait);
    if (outcome.kind === "interrupted" && rows.length > 1) {
      // the next run finds the row that stops the slice, if it is one, by sending them one at a time
      run.oneByOneUntil = run.nextIndex + rows.length;
    }
    if (outcome.kind !== "answered") {
      return outcome;
    }
    if (!recordAnswer(run, rows, outcome.results)) {
      // an answer without every row sent is not an answer: nothing moves, and the same slice goes again
      return {
        error: new Error("incomplete_import_answer"),
        kind: "interrupted",
      };
    }
    run.nextIndex += rows.length;
    dependencies.onProgress?.(run);
    if (outcome.results.some((result) => result.status === "limit_reached")) {
      markLimitReached(run);
      return { kind: "limit_reached" };
    }
  }
  return { kind: "done" };
}

export interface ImportSummary {
  /** Created now or by an earlier send of the same rows. */
  entered: number;
  /** Skipped: a product of the same name was already there. */
  existing: number;
  /** Refused by the server, with the field (`invalid`) or as a repeat with other data (`conflict`), or left out. */
  failed: number;
  limitReached: number;
  /** Not answered yet: what a stopped run still has to send. */
  pending: number;
}

export function summarizeImport(run: ImportRun): ImportSummary {
  const summary: ImportSummary = {
    entered: 0,
    existing: 0,
    failed: 0,
    limitReached: 0,
    pending: 0,
  };
  for (const row of run.rows) {
    if (run.skipped.has(row.rowNumber)) {
      summary.failed += 1;
      continue;
    }
    switch (run.results.get(row.rowNumber)?.status) {
      case "created":
      case "repeated":
        summary.entered += 1;
        break;
      case "exists_by_name":
        summary.existing += 1;
        break;
      case "limit_reached":
        summary.limitReached += 1;
        break;
      case "invalid":
      case "conflict":
        summary.failed += 1;
        break;
      default:
        summary.pending += 1;
    }
  }
  return summary;
}
