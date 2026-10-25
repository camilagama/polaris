import { browserConnection } from "./browser-connection";
import { isNoAnswer, jittered } from "./connection";
import { rpcErrorCode, rpcErrorReason } from "./rpc-error";

/** Where the second try waits: the Worker that was killed at a cold start is warm by then, as on a reload. */
const RETRY_AFTER_MS = 1500;

/**
 * A READ that failed in a way a second try may fix: no answer (`isNoAnswer`, which includes a response
 * without the Worker's mark), `SERVICE_UNAVAILABLE` (with or without `data.reason: "server_busy"`), or a 5xx
 * with no reason of its own: the 500 of an error nobody named, and the page the runtime or Cloudflare
 * answers for a Worker it killed (the CPU limit, "code had hung"), which oRPC reads as an error of the
 * status it carries (502, 504, 52x...). A 4xx is the server's answer: trying again says the same.
 */
export function isTransientReadFailure(error: unknown): boolean {
  if (isNoAnswer(error)) {
    return true;
  }
  if (rpcErrorCode(error) === "SERVICE_UNAVAILABLE") {
    return true;
  }
  const { status } = (error ?? {}) as { status?: unknown };
  return (
    typeof status === "number" &&
    status >= 500 &&
    rpcErrorReason(error) === undefined
  );
}

export interface ReadWithRetryOptions {
  /** False once the screen no longer wants the answer (it left, or a newer read took its place): no second try. */
  isCurrent?: () => boolean;
  /** False while the tab is known offline: the return to the network reads again, a wait now only delays the screen. */
  isOnline?: () => boolean;
  random?: () => number;
  /** The wait before the second try; the clock in tests. */
  wait?: (ms: number) => Promise<void>;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Runs a READ and, when it fails in a transient way, runs it once more after ~1.5 s (±20%): the same as
 * the user reloading. The screen stays in "Carregando…" meanwhile; only the second failure reaches the
 * caller. NEVER for a write: a write that got no answer may have been saved, and goes through the outbox
 * with its idempotency key.
 */
export async function readWithRetry<T>(
  read: () => Promise<T>,
  {
    isCurrent = () => true,
    isOnline = () => browserConnection.isOnline(),
    random = Math.random,
    wait: pause = wait,
  }: ReadWithRetryOptions = {}
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!(isTransientReadFailure(error) && isOnline() && isCurrent())) {
      throw error;
    }
    await pause(jittered(RETRY_AFTER_MS, random));
    if (!isCurrent()) {
      throw error;
    }
    return await read();
  }
}
