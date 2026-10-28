/**
 * The READ traffic of this tab to the Worker (paliativo dos 1102): until the plan decides on more
 * CPU, the client spreads the bursts and hides the Workers killed for CPU on the reads. It does NOT lower the CPU
 * of a call (the limit is per invocation): it only spreads the burst and keeps the retries from making it worse.
 *
 * - **Slots:** at most 4 reads in flight; the rest wait in arrival order. A read that is given up while it waits
 *   (its signal aborts: the screen left) leaves the line, and one in flight frees its slot at once.
 * - **The session first:** while the first `get-session` of the tab is on its way, no read leaves (without a session
 *   they would all be 401, and would still cost CPU); at most 5 s, so a hung lookup never holds the screen.
 * - **429:** the Worker's `Retry-After` pauses every read of the tab (the sync's pull included) until it ends, 60 s
 *   at most: trying again spends the same bucket of the server.
 * - **A hung read** (a mobile network that never answers) holds its slot 15 s at most; the call itself goes on.
 * - **Brakes on the retries** (`mayRetry`): at most 8 retries in any 10 s, and none for 15 s once more than half of
 *   the last 20 calls died on the platform (`server_failed`).
 *
 * Writes never come here: they go out at once (the outbox has its own idempotency key and its own retries).
 * Per tab, with no coordination between tabs. TypeScript only, with the clock injected.
 */

const SLOTS = 4;
/** A read still in flight after this stops holding its slot (the call goes on): a hung network never holds the line. */
const SLOT_HOLD_MAX_MS = 15_000;
const SESSION_FIRST_MAX_MS = 5000;
/** The longest a 429 pauses the reads: the sync (and "Sair", which waits for it) never stands still for minutes. */
const PAUSE_MAX_MS = 60_000;
const RETRY_BUDGET = 8;
const RETRY_BUDGET_WINDOW_MS = 10_000;
const BREAKER_WINDOW = 20;
const BREAKER_OPEN_MS = 15_000;

/**
 * The procedures that only read. A read missing here only goes out of the line (as before); a write here would only
 * wait its turn, so the list errs on the side of leaving out. `goal.list` settles the goals whose period ended, the
 * same answer whenever it is called (ADR 0055).
 */
const READ_PROCEDURES: ReadonlySet<string> = new Set([
  "account/legalStatus",
  "billing/readPlan",
  "category/list",
  "customer/findPossibleDuplicates",
  "customer/list",
  "dataExport/list",
  "dataExport/listClosed",
  "device/list",
  "expense/list",
  "expense/listCategories",
  "expense/listRules",
  "goal/list",
  "goal/targetChanges",
  "inventory/getBalance",
  "inventory/listBalances",
  "organization/closedStatus",
  "organization/listClosed",
  "organization/listClosing",
  "organization/listMine",
  "paymentProfile/list",
  "plan/operationalSelection",
  "product/getVariants",
  "product/list",
  "publicCatalog/setup",
  "report/dailySales",
  "report/periodSummary",
  "sale/get",
  "sale/getCustomerLink",
  "sale/list",
  "sync/bootstrapPage",
  "sync/getCursor",
  "sync/pull",
]);

export { READ_PROCEDURES };

const SESSION_PATH = "/api/auth/get-session";
const RPC_PREFIX = "/rpc/";

/** What a call is for the gate: a read of the line, the session lookup, or anything else (writes, assets). */
export type CallKind = "other" | "read" | "session";

function pathOf(input: RequestInfo | URL): string {
  const href =
    typeof input === "string" || input instanceof URL
      ? String(input)
      : input.url;
  try {
    return new URL(href, "http://x").pathname;
  } catch {
    return "";
  }
}

export function callKind(input: RequestInfo | URL): CallKind {
  const path = pathOf(input);
  if (path === SESSION_PATH) {
    return "session";
  }
  return path.startsWith(RPC_PREFIX) &&
    READ_PROCEDURES.has(path.slice(RPC_PREFIX.length))
    ? "read"
    : "other";
}

export function isRpcCall(input: RequestInfo | URL): boolean {
  return pathOf(input).startsWith(RPC_PREFIX);
}

export interface ReadGateDependencies {
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => () => void;
}

export interface ReadGate {
  /** Waits for a slot; resolves with how to give it back (once, whatever happens). */
  acquire: (signal?: AbortSignal | null) => Promise<() => void>;
  /** The reads in flight now (tests, the e2e's marks). */
  inFlight: () => number;
  /** Whether a read may be tried again now; true spends one retry of the budget. */
  mayRetry: () => boolean;
  /** Pauses every read until `ms` from now (the `Retry-After` of a 429). */
  pause: (ms: number) => void;
  /** A call to the RPC ended: whether the platform killed it (`server_failed`), for the breaker. */
  record: (died: boolean) => void;
  /** Runs the session lookup; the first one of the tab holds the reads until it ends. */
  session: <T>(task: () => Promise<T>) => Promise<T>;
}

interface Waiter {
  grant: () => void;
  signal: AbortSignal | null | undefined;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("read_cancelled", "AbortError");
}

export function createReadGate({
  now,
  schedule,
}: ReadGateDependencies): ReadGate {
  const line: Waiter[] = [];
  let running = 0;
  let pausedUntil = 0;
  // the first lookup of the tab: until it ends (or 5 s pass) no read leaves
  let sessionFirst: { until: number } | null = null;
  let sessionSeen = false;
  let cancelWake: (() => void) | null = null;
  const retries: number[] = [];
  const deaths: boolean[] = [];
  let breakerUntil = 0;

  const heldUntil = (): number => {
    const session =
      sessionFirst && sessionFirst.until > now() ? sessionFirst.until : 0;
    return Math.max(session, pausedUntil);
  };

  const pump = () => {
    cancelWake?.();
    cancelWake = null;
    const held = heldUntil();
    if (held > now()) {
      if (line.length > 0) {
        cancelWake = schedule(pump, held - now());
      }
      return;
    }
    while (running < SLOTS && line.length > 0) {
      line.shift()?.grant();
    }
  };

  return {
    acquire(signal) {
      if (signal?.aborted) {
        return Promise.reject(abortReason(signal));
      }
      return new Promise((resolve, reject) => {
        let state: "done" | "running" | "waiting" = "waiting";
        let cancelHold: (() => void) | null = null;
        const release = () => {
          if (state !== "running") {
            return;
          }
          state = "done";
          running -= 1;
          cancelHold?.();
          signal?.removeEventListener("abort", onAbort);
          pump();
        };
        const waiter: Waiter = {
          grant: () => {
            state = "running";
            running += 1;
            cancelHold = schedule(release, SLOT_HOLD_MAX_MS);
            resolve(release);
          },
          signal,
        };
        // the screen gave up: out of the line, or its slot back at once (the fetch itself aborts on the same signal)
        function onAbort() {
          if (state === "waiting") {
            state = "done";
            line.splice(line.indexOf(waiter), 1);
            reject(abortReason(signal as AbortSignal));
            return;
          }
          release();
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        line.push(waiter);
        pump();
      });
    },
    inFlight: () => running,
    mayRetry() {
      const at = now();
      if (at < breakerUntil) {
        return false;
      }
      while (
        retries.length > 0 &&
        (retries[0] ?? 0) <= at - RETRY_BUDGET_WINDOW_MS
      ) {
        retries.shift();
      }
      if (retries.length >= RETRY_BUDGET) {
        return false;
      }
      retries.push(at);
      return true;
    },
    pause(ms) {
      pausedUntil = Math.max(pausedUntil, now() + Math.min(ms, PAUSE_MAX_MS));
      pump();
    },
    record(died) {
      deaths.push(died);
      if (deaths.length > BREAKER_WINDOW) {
        deaths.shift();
      }
      if (died && deaths.filter(Boolean).length * 2 > BREAKER_WINDOW) {
        breakerUntil = now() + BREAKER_OPEN_MS;
      }
    },
    async session(task) {
      const first = !sessionSeen;
      sessionSeen = true;
      if (first) {
        sessionFirst = { until: now() + SESSION_FIRST_MAX_MS };
      }
      try {
        return await task();
      } finally {
        if (first) {
          sessionFirst = null;
          pump();
        }
      }
    },
  };
}
