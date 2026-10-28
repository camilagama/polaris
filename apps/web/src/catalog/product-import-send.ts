import {
  PRODUCT_IMPORT_BATCH_MAX_ROWS,
  type ProductImportRowInput,
  type ProductImportRowResult,
} from "@polaris/contracts";
import { isConnectionFailure, rpcErrorCode } from "../lib/rpc-error";
import { uuidv7 } from "../lib/uuidv7";
import type { ImportReadyRow } from "./product-import-rows";

/**
 * Sending the rows of an import (corte 2.5): one row per call (`PRODUCT_IMPORT_BATCH_MAX_ROWS`, the server's cap), the
 * next only after the answer to the previous one, and at a pace below the bucket of the import
 * (`RPC_BULK_RATE_LIMIT`, 30 calls per minute), so the sales of the same session keep their quota. The IDs of each
 * row (product, variant, stock command) are born once per import and live only in memory, in the `ImportRun`:
 * sending a row again after a lost answer, or continuing after a stop, sends the same IDs, and the server answers
 * `repeated` instead of creating twice (AC-5). Nothing is kept on the device (AC-7), and nothing goes to the offline
 * queue.
 *
 * A 429 pauses for the time the server asked (`Retry-After`) and sends the same row once after it, never right
 * away. A failure that may have taken effect (no answer, a fault of the server, as the CPU limit of the Free plan
 * killing the call: ~10% of the calls of 1 row) sends the same row again, with the same IDs. A row that fails
 * `MAX_ROW_RETRIES` times stops the run where it was, so `skipStuckRow` can leave it out without holding back the
 * rows after it. The plan's refusal stops it for good and says so, for the screen's notice of the limit (corte 1.6).
 */

/**
 * At most one call every 2.5 s: 24 per minute, 20% below the 30 of the bucket (the limiter counts by location and
 * approximately, so calling at the limit gives bursts of 429). It holds for every call of the run, the row sent
 * again after a 429 or a failure too, and across the calls of `runImport` (continuing a stopped run).
 */
export const IMPORT_CALL_INTERVAL_MS = 2500;
/** The wait after a 429 whose `Retry-After` did not come through. */
const RATE_LIMITED_FALLBACK_MS = 60_000;
/** The bounds of the wait after a 429: never right away, never longer than the window of the bucket twice. */
const RATE_LIMITED_MIN_MS = 1000;
const RATE_LIMITED_MAX_MS = 120_000;
/** The 429s in a row before the run stops (another tab is importing too). */
const MAX_RATE_LIMITED_IN_A_ROW = 3;
/** The tries again, at the pace, of a row whose answer did not come. */
const MAX_ROW_RETRIES = 2;

export interface ImportRun {
  readonly importId: string;
  /** When the last call of the run went, for the pace; null before the first. */
  lastSentAt: number | null;
  /** The index of the first row not answered yet: where a stopped run continues. */
  nextIndex: number;
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
    lastSentAt: null,
    nextIndex: 0,
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
  /** No answer, or a fault of the server: the slice may have entered. */
  | { error: unknown; kind: "failed" }
  | Exclude<ImportStop, { kind: "done" | "limit_reached" | "interrupted" }>;

type Wait = NonNullable<ImportSendDependencies["wait"]>;

/** Waits until `IMPORT_CALL_INTERVAL_MS` has gone since the last call of the run. */
async function keepPace(
  run: ImportRun,
  now: () => number,
  wait: Wait,
  signal?: AbortSignal
): Promise<void> {
  if (run.lastSentAt === null) {
    return;
  }
  const elapsed = Math.max(now() - run.lastSentAt, 0);
  if (elapsed < IMPORT_CALL_INTERVAL_MS) {
    await wait(IMPORT_CALL_INTERVAL_MS - elapsed, signal);
  }
}

/** One slice, sent at the pace until it has an answer or fails, the 429 pauses included. */
async function sendSlice(
  run: ImportRun,
  rows: ProductImportRowInput[],
  dependencies: ImportSendDependencies,
  clock: { now: () => number; wait: Wait }
): Promise<SliceOutcome> {
  const { now, wait } = clock;
  let rateLimited = 0;
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: the pace of the import is one call at a time
    await keepPace(run, now, wait, dependencies.signal);
    if (dependencies.signal?.aborted) {
      return { kind: "aborted" };
    }
    run.lastSentAt = now();
    try {
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
      return isTransient(error)
        ? { error, kind: "failed" }
        : { error, kind: "refused" };
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

/**
 * After a failure of the server: the same row goes again up to `MAX_ROW_RETRIES` times and then stops the run.
 * The tries so far, or the stop.
 */
function afterFailure(failure: {
  error: unknown;
  retries: number;
  signal: AbortSignal | undefined;
}): number | ImportStop {
  if (failure.signal?.aborted) {
    // the screen gave up during the call: not a failure of the server
    return { kind: "aborted" };
  }
  return failure.retries >= MAX_ROW_RETRIES
    ? { error: failure.error, kind: "interrupted" }
    : failure.retries + 1;
}

/** Keeps the answer of a slice and moves past it; a stop when it is not an answer. */
function takeAnswer(
  run: ImportRun,
  rows: readonly ProductImportRowInput[],
  results: readonly ProductImportRowResult[]
): ImportStop | null {
  if (!recordAnswer(run, rows, results)) {
    // an answer without every row sent is not an answer: nothing moves, and the same slice goes again
    return {
      error: new Error("incomplete_import_answer"),
      kind: "interrupted",
    };
  }
  run.nextIndex += rows.length;
  return null;
}

/** Sends the rows of the run from where it stopped, a slice at a time, until every row has its answer or it stops. */
export async function runImport(
  run: ImportRun,
  dependencies: ImportSendDependencies
): Promise<ImportStop> {
  const clock = {
    now: dependencies.now ?? Date.now,
    wait: dependencies.wait ?? waitFor,
  };
  let retries = 0;
  while (run.nextIndex < run.rows.length) {
    const rows = run.rows.slice(
      run.nextIndex,
      run.nextIndex + PRODUCT_IMPORT_BATCH_MAX_ROWS
    );
    // biome-ignore lint/performance/noAwaitInLoops: one slice at a time, the next only after the answer
    const outcome = await sendSlice(run, rows, dependencies, clock);
    if (outcome.kind === "failed") {
      const next = afterFailure({
        error: outcome.error,
        retries,
        signal: dependencies.signal,
      });
      if (typeof next !== "number") {
        return next;
      }
      // the same rows go again, at the pace, with the same IDs
      retries = next;
      continue;
    }
    if (outcome.kind !== "answered") {
      return outcome;
    }
    const stop = takeAnswer(run, rows, outcome.results);
    if (stop) {
      return stop;
    }
    retries = 0;
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
