import { isNoAnswer, jittered } from "./connection";
import { rpcErrorCode, rpcErrorReason } from "./rpc-error";

/** Where the second try waits: the Worker that was killed at a cold start is warm by then, as on a reload. */
const RETRY_AFTER_MS = 1500;

/**
 * A READ that failed in a way a second try may fix: no answer (`isNoAnswer`, which includes a response
 * without the Worker's mark), `SERVICE_UNAVAILABLE` (with or without `data.reason: "server_busy"`), a 500
 * with no reason of its own, or the runtime's page that oRPC could not even decode (the CPU limit, "code
 * had hung"). A 4xx is the server's answer: trying again says the same.
 */
export function isTransientReadFailure(error: unknown): boolean {
  if (isNoAnswer(error)) {
    return true;
  }
  const code = rpcErrorCode(error);
  if (code === "SERVICE_UNAVAILABLE") {
    return true;
  }
  if (code === "INTERNAL_SERVER_ERROR") {
    return rpcErrorReason(error) === undefined;
  }
  return (
    code === undefined &&
    error instanceof Error &&
    error.message.startsWith("Cannot parse response body")
  );
}

export interface ReadWithRetryOptions {
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
  { random = Math.random, wait: pause = wait }: ReadWithRetryOptions = {}
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!isTransientReadFailure(error)) {
      throw error;
    }
    await pause(jittered(RETRY_AFTER_MS, random));
    return await read();
  }
}
