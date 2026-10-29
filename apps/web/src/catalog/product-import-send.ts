import {
  PRODUCT_IMPORT_BATCH_MAX_ROWS,
  type ProductImportRowInput,
  type ProductImportRowResult,
} from "@polaris/contracts";
import {
  isConnectionFailure,
  isPlatformCut,
  rpcErrorCode,
} from "../lib/rpc-error";
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
 * away. A failure with no answer sends the same row again, with the same IDs; a row that fails so
 * `MAX_ROW_RETRIES` times stops the run where it was, so `skipStuckRow` can leave it out without holding back the
 * rows after it. The plan's refusal stops it for good and says so, for the screen's notice of the limit (corte 1.6).
 *
 * The cut of the platform (`isPlatformCut`: the CPU limit of the Free plan killing the Worker, 1102) is not a fault
 * of the row: it is the sign of the regime, in which every call of the Worker dies for 4 to 26 minutes and that ends
 * only ~6 minutes after the traffic stops. The run pauses (`REGIME_PAUSE_STEPS_MS`, growing while the cuts go on),
 * sends the same row again with the same IDs (a call killed after its commit answers `repeated`), and never gives up by itself: it ends when the
 * rows end or the person stops it. After a pause it goes at half the pace until `PACE_BACK_AFTER_ANSWERS` answers.
 * The same pause holds the send while the tab's own sales or reads are failing (`busy`): the till comes first.
 */

/**
 * At most one call every 7 s (~8.5 per minute): under the ~9 per minute that went with no cut on the Free plan, and far
 * under the 30 of the bucket. Never below 5 s without a new measure of the regime. It holds for every call of the
 * run, the row sent again after a 429 or a failure too, and across the calls of `runImport` (continuing a stopped run).
 */
export const IMPORT_CALL_INTERVAL_MS = 7000;
/**
 * The pauses after a cut of the platform, one step per pause while the regime goes on, then the last one again. Each
 * is longer than the ~6 minutes the regime takes to end once the traffic stops: the import is part of that traffic.
 */
export const REGIME_PAUSE_STEPS_MS = [120_000, 300_000, 600_000] as const;
/** After a pause the run goes at twice the interval until this many answers in a row; then the pauses start over. */
export const PACE_BACK_AFTER_ANSWERS = 20;
/**
 * The cuts of one row, each on the send right after a pause at the ceiling, that leave it out by itself (`skipStuckRow`) when the row
 * before it went through: the row itself may be what the Worker cannot finish.
 */
export const CUTS_AT_CEILING_TO_SKIP = 3;
/** The wait after a 429 whose `Retry-After` did not come through. */
const RATE_LIMITED_FALLBACK_MS = 60_000;
/** The bounds of the wait after a 429: never right away, never longer than the window of the bucket twice. */
const RATE_LIMITED_MIN_MS = 1000;
const RATE_LIMITED_MAX_MS = 120_000;
/** The 429s in a row before the run stops (another tab is importing too). */
const MAX_RATE_LIMITED_IN_A_ROW = 3;
/** The tries again, at the pace, of a row whose answer did not come. */
const MAX_ROW_RETRIES = 2;

/** Where the run is in the regime of the platform: kept with the run, so a continued run does not start over. */
interface RegimeState {
  /** The cuts of the row on its way that came on the send right after a pause at the ceiling. */
  cutsAtCeiling: number;
  /** Whether the last pause was the longest one. */
  lastPauseAtCeiling: boolean;
  /** Whether the next send is the first after a pause at the ceiling: only its cut counts in `cutsAtCeiling`. */
  sendAfterCeiling: boolean;
  /** The pauses since the pace last came back: the step of the next one. */
  pauses: number;
  /** The answers still to come at twice the interval. */
  slowFor: number;
}

export interface ImportRun {
  readonly importId: string;
  /** When the last call of the run went, for the pace; null before the first. */
  lastSentAt: number | null;
  /** The index of the first row not answered yet: where a stopped run continues. */
  nextIndex: number;
  readonly regime: RegimeState;
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
    regime: {
      cutsAtCeiling: 0,
      lastPauseAtCeiling: false,
      pauses: 0,
      sendAfterCeiling: false,
      slowFor: 0,
    },
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
    run.regime.cutsAtCeiling = 0;
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
  /**
   * Whether the tab's own work is failing now (the breaker of the reads open, a sale of the queue failing to go): the
   * run holds its next call in a pause, as after a cut.
   */
  busy?: () => boolean;
  now?: () => number;
  /** A pause of the regime began (when the run goes on by itself) or ended (`null`). */
  onPause?: (resumeAt: number | null) => void;
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

/** A failure with no answer, or one the server may not have finished: the same row is tried again. */
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
  /** The platform killed the call: the regime is on, and the slice may have entered (sent again, it answers `repeated`). */
  | { kind: "cut" }
  /** Not sent: the tab's own work is failing (`busy`). */
  | { kind: "held" }
  /** No answer, or a fault of the server: the slice may have entered. */
  | { error: unknown; kind: "failed" }
  | Exclude<ImportStop, { kind: "done" | "limit_reached" | "interrupted" }>;

type Wait = NonNullable<ImportSendDependencies["wait"]>;

/** The interval between two calls now: twice `IMPORT_CALL_INTERVAL_MS` while the run comes back from a pause. */
function intervalOf(run: ImportRun): number {
  return run.regime.slowFor > 0
    ? 2 * IMPORT_CALL_INTERVAL_MS
    : IMPORT_CALL_INTERVAL_MS;
}

async function keepPace(
  run: ImportRun,
  now: () => number,
  wait: Wait,
  signal?: AbortSignal
): Promise<void> {
  if (run.lastSentAt === null) {
    return;
  }
  const interval = intervalOf(run);
  const elapsed = Math.max(now() - run.lastSentAt, 0);
  if (elapsed < interval) {
    await wait(interval - elapsed, signal);
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
    if (dependencies.busy?.()) {
      return { kind: "held" };
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
      return failureOutcome(error);
    }
  }
}

function failureOutcome(error: unknown): SliceOutcome {
  if (isPlatformCut(error)) {
    return { kind: "cut" };
  }
  return isTransient(error)
    ? { error, kind: "failed" }
    : { error, kind: "refused" };
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

/** Whether the row before the one on its way had its answer: a cut that repeats is then the row's own, not the regime's. */
function previousWentThrough(run: ImportRun): boolean {
  const previous = run.rows[run.nextIndex - 1];
  return previous !== undefined && run.results.has(previous.rowNumber);
}

/**
 * A cut of the row on its way. The same row cut `CUTS_AT_CEILING_TO_SKIP` times, each on the send right after a pause
 * at the ceiling, while the row before it went through, is left out; true when it was.
 */
function noteCut(run: ImportRun): boolean {
  const { regime } = run;
  if (!regime.sendAfterCeiling) {
    return false;
  }
  regime.cutsAtCeiling += 1;
  if (
    regime.cutsAtCeiling < CUTS_AT_CEILING_TO_SKIP ||
    !previousWentThrough(run)
  ) {
    return false;
  }
  skipStuckRow(run);
  return true;
}

/** An answer: one step of the way back to the pace; once there, the next pause starts at the first step again. */
function noteAnswer(run: ImportRun): void {
  const { regime } = run;
  regime.cutsAtCeiling = 0;
  regime.sendAfterCeiling = false;
  if (regime.slowFor > 0) {
    regime.slowFor -= 1;
    if (regime.slowFor === 0) {
      regime.pauses = 0;
      regime.lastPauseAtCeiling = false;
    }
  }
}

/** The pause of the regime: no call until it ends (or the screen gives up), then the run comes back at half pace. */
async function regimePause(
  run: ImportRun,
  dependencies: ImportSendDependencies,
  clock: { now: () => number; wait: Wait }
): Promise<void> {
  const { regime } = run;
  const ceiling = REGIME_PAUSE_STEPS_MS.at(-1) ?? 0;
  const ms = REGIME_PAUSE_STEPS_MS[regime.pauses] ?? ceiling;
  regime.pauses += 1;
  regime.lastPauseAtCeiling = ms === ceiling;
  regime.sendAfterCeiling = regime.lastPauseAtCeiling;
  regime.slowFor = PACE_BACK_AFTER_ANSWERS;
  dependencies.onPause?.(clock.now() + ms);
  await clock.wait(ms, dependencies.signal);
  if (!dependencies.signal?.aborted) {
    dependencies.onPause?.(null);
  }
}

/** After a cut or a held send: the stuck row left out when it is one, then the pause; false when the screen gave up. */
async function pauseForRegime(
  run: ImportRun,
  kind: "cut" | "held",
  dependencies: ImportSendDependencies,
  clock: { now: () => number; wait: Wait }
): Promise<boolean> {
  if (dependencies.signal?.aborted) {
    return false;
  }
  if (kind === "cut" && noteCut(run)) {
    dependencies.onProgress?.(run);
  }
  await regimePause(run, dependencies, clock);
  return !dependencies.signal?.aborted;
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
    if (outcome.kind === "cut" || outcome.kind === "held") {
      // the same rows go again after the pause, with the same IDs; a cut is no try of `MAX_ROW_RETRIES`
      if (await pauseForRegime(run, outcome.kind, dependencies, clock)) {
        continue;
      }
      return { kind: "aborted" };
    }
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
      run.regime.sendAfterCeiling = false;
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
    noteAnswer(run);
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
