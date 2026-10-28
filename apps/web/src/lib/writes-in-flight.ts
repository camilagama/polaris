import { READ_PROCEDURES } from "./read-procedures";

/**
 * How many calls to the server that change something (`write` or `bulk`) are on their way from this page. A swap of
 * the build reloads the page, and a reload in the middle of a write leaves the screen without knowing how it ended,
 * so the swap waits for it (`pwa/swap-guard.ts`). A read never holds it. A path that is not a known read counts as a
 * write: a new procedure holds the swap until it is listed.
 */
const reads = new Set(READ_PROCEDURES);
let inFlight = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function isWritePath(path: readonly string[]): boolean {
  return !reads.has(path.join("/"));
}

/** Runs a call, counting it while it is on its way when it is a write. */
export async function trackWrite<T>(
  path: readonly string[],
  call: () => Promise<T>
): Promise<T> {
  if (!isWritePath(path)) {
    return call();
  }
  inFlight += 1;
  emit();
  try {
    return await call();
  } finally {
    inFlight -= 1;
    emit();
  }
}

export function writesInFlight(): number {
  return inFlight;
}

export function subscribeWrites(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
