import { browserConnection } from "./browser-connection";
import { jittered } from "./connection";
import { isTransientReadFailure } from "./rpc-error";

/**
 * The waits before the second and the third try (paliativo dos 1102): ~1.5 s, when a Worker killed at a cold start
 * is warm again, then ~4 s. Three tries at most; the worst wait is about 6 s.
 */
const RETRY_WAITS_MS = [1500, 4000] as const;

/** How often a read in progress asks the screen whether it still wants the answer. */
const CURRENT_CHECK_MS = 250;

export interface ReadWithRetryOptions {
  /**
   * False once the screen no longer wants the answer (it left, or a newer read took its place): the read in progress
   * is cancelled (its signal aborts, which frees its slot) and never tried again.
   */
  isCurrent?: () => boolean;
  /** False while the tab is known offline: the return to the network reads again, a wait now only delays the screen. */
  isOnline?: () => boolean;
  /** The brakes of the tab (budget and breaker); true spends one retry. */
  mayRetry?: () => boolean;
  random?: () => number;
  /** The wait before another try; the clock in tests. */
  wait?: (ms: number) => Promise<void>;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Aborts the controller as soon as the screen no longer wants the answer; returns how to stop looking. */
function watchCurrent(
  isCurrent: () => boolean,
  controller: AbortController
): () => void {
  const timer = setInterval(() => {
    if (!isCurrent()) {
      controller.abort(new DOMException("read_left_behind", "AbortError"));
    }
  }, CURRENT_CHECK_MS);
  return () => clearInterval(timer);
}

/**
 * Runs a READ and, when it fails in a transient way, tries again after ~1.5 s and ~4 s (±20% each): three tries at
 * most, the same as the user reloading, within the brakes of the tab. The screen stays in its skeleton meanwhile
 * (with "Demorando mais que o normal…" after ~3 s); only the last failure reaches the caller. `read` gets the signal
 * of the try: passed on to the RPC call, leaving the screen cancels the call and frees its slot at once. NEVER for a
 * write: a write that got no answer may have been saved, and goes through the outbox with its idempotency key.
 */
export async function readWithRetry<T>(
  read: (signal: AbortSignal) => Promise<T>,
  {
    isCurrent,
    isOnline = () => browserConnection.isOnline(),
    mayRetry = () => browserConnection.mayRetryRead(),
    random = Math.random,
    wait: pause = wait,
  }: ReadWithRetryOptions = {}
): Promise<T> {
  const current = isCurrent ?? (() => true);
  const controller = new AbortController();
  const stopWatching = isCurrent
    ? watchCurrent(isCurrent, controller)
    : () => undefined;
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: each try waits for the one before it
        return await read(controller.signal);
      } catch (error) {
        if (
          attempt >= RETRY_WAITS_MS.length ||
          controller.signal.aborted ||
          !(isTransientReadFailure(error) && isOnline() && current()) ||
          !mayRetry()
        ) {
          throw error;
        }
        await pause(jittered(RETRY_WAITS_MS[attempt] as number, random));
        if (!current()) {
          throw error;
        }
      }
    }
  } finally {
    stopWatching();
  }
}
