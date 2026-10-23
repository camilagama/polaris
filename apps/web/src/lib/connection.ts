/**
 * Whether this tab can reach OUR Worker, with proof (emenda do ADR 0043). `navigator.onLine` only says
 * there is a network: a wi-fi with no internet, a captive portal or a signal that carries no data all
 * leave it true. Here "online" means a response came from the Worker, recognised by its mark: the
 * `X-Request-Id` every Worker response carries (`requestIdMiddleware`), a UUID. The client never sends
 * its own, so the mark is never an echo.
 *
 * - Passive and free: every RPC response passes through `fetch` below and is classified before oRPC
 *   decodes it. A marked response proves the connection, whatever its status.
 * - Active, only in doubt: `GET /health`, when a call failed by network, when a call hangs for 4 s, and
 *   while offline with the page visible (2, 4, 8, 8… s; after 10 min offline, 60 s). Never while online
 *   with nothing in doubt, never with the page hidden.
 *
 * The state never touches the lease or the session: an answer that did not come from the Worker is no
 * answer (`NoWorkerAnswerError`), never a refusal. TypeScript only, with the network, the clock and the
 * page visibility injected, so it is tested without a browser.
 */

export type ConnectionState = "offline" | "online";

/**
 * - `worker`: the Worker answered (any status): the connection is proven.
 * - `server_failed`: a 5xx without the mark but with `cf-ray`: Cloudflare answered for a Worker that
 *   failed. Online; the call failed on the server and is tried again later.
 * - `intercepted`: a 401 or 403 without the mark (a WAF, a proxy, a portal). No answer, never a refusal.
 * - `unproven`: anything else without the mark (the HTML 200 of a portal, a redirect elsewhere).
 */
export type ResponseVerdict =
  | "intercepted"
  | "server_failed"
  | "unproven"
  | "worker";

const WORKER_MARK_HEADER = "x-request-id";
const workerMarkPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function classifyResponse(response: Response): ResponseVerdict {
  const mark = response.headers.get(WORKER_MARK_HEADER);
  if (mark !== null && workerMarkPattern.test(mark)) {
    return "worker";
  }
  if (response.status >= 500 && response.headers.has("cf-ray")) {
    return "server_failed";
  }
  if (response.status === 401 || response.status === 403) {
    return "intercepted";
  }
  return "unproven";
}

/** A response that did not come from the Worker: the same as no response at all. */
export class NoWorkerAnswerError extends Error {
  constructor(verdict: ResponseVerdict) {
    super(`no_worker_answer_${verdict}`);
    this.name = "NoWorkerAnswerError";
  }
}

/** A call that may not have left or whose answer never came: a fetch failure, an abort by timeout, no Worker. */
export function isNoAnswer(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (
    error.name === "NoWorkerAnswerError" ||
    error.name === "TimeoutError" ||
    error.name === "AbortError" ||
    // what `fetch` throws when the request never got an answer (it is never an oRPC error, which has a code)
    (error.name === "TypeError" && !("code" in error))
  ) {
    return true;
  }
  return error.cause !== undefined && isNoAnswer(error.cause);
}

/** `setTimeout` as a `schedule`: returns how to cancel. */
export function timerSchedule(
  callback: () => void,
  delayMs: number
): () => void {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
}

/** ±20% around the delay, so the tabs and devices that lost the network together do not come back together. */
export function jittered(delayMs: number, random: () => number): number {
  return Math.round(delayMs * (0.8 + 0.4 * random()));
}

const PROBE_TIMEOUT_MS = 4000;
/** A call with no answer after this is in doubt: the probe looks, the call goes on. */
const SLOW_CALL_MS = 4000;
const PROBE_STEPS_MS = [2000, 4000, 8000] as const;
const PROBE_SLOW_MS = 60_000;
const PROBE_FAST_FOR_MS = 10 * 60_000;
/** A probe that timed out counts only at the second one in a row: a slow network is not no network. */
const TIMEOUTS_FOR_OFFLINE = 2;
/** A remembered "offline" this recent makes a reloaded page open offline (and probe at once). */
const REMEMBERED_FOR_MS = 60_000;
const PROBE_LOCK = "polaris-connection-probe";
const RETRY_AFTER_MAX_S = 300;

export interface ConnectionMemory {
  read: () => string | null;
  remove: () => void;
  write: (value: string) => void;
}

export interface ConnectionDependencies {
  /** Says whether the browser thinks there is a network at all (`navigator.onLine`). */
  browserOnline: () => boolean;
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  isVisible: () => boolean;
  /**
   * Runs the task only if no other tab holds the lock (`navigator.locks`, `ifAvailable`); false when it
   * did not run. Without it the task always runs.
   */
  lock?: (name: string, task: () => Promise<void>) => Promise<boolean>;
  mark?: (name: string) => void;
  /**
   * "Offline since", in `sessionStorage`. It only picks the FIRST state a reloaded page shows (a menu
   * reloads the page): never kept past the tab, never read again after the start.
   */
  memory?: ConnectionMemory;
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => () => void;
}

export interface ConnectionSnapshot {
  /** When the state last changed (ms since the epoch). */
  since: number;
  state: ConnectionState;
}

type ProbeResult = "offline" | "online" | "timeout";

interface Remembered {
  /** The last moment it was seen offline (a failed probe). */
  seen: number;
  /** When the tab went offline. */
  since: number;
}

function readRemembered(
  memory: ConnectionMemory | undefined
): Remembered | null {
  try {
    const parsed = JSON.parse(
      memory?.read() ?? "null"
    ) as Partial<Remembered> | null;
    return typeof parsed?.since === "number" && typeof parsed.seen === "number"
      ? { seen: parsed.seen, since: parsed.since }
      : null;
  } catch {
    return null;
  }
}

async function isHealthy(response: Response): Promise<boolean> {
  if (
    response.status !== 200 ||
    classifyResponse(response) !== "worker" ||
    !(response.headers.get("content-type") ?? "").includes("application/json")
  ) {
    return false;
  }
  try {
    const body = (await response.json()) as { status?: unknown } | null;
    return body?.status === "ok";
  } catch {
    return false;
  }
}

export class Connection {
  private readonly dependencies: ConnectionDependencies;
  private readonly listeners = new Set<() => void>();
  private snapshot: ConnectionSnapshot;
  private probing: Promise<void> | null = null;
  private cancelProbe: (() => void) | null = null;
  private step = 0;
  private timeouts = 0;
  private retryAfterMs: number | null = null;

  constructor(dependencies: ConnectionDependencies) {
    this.dependencies = dependencies;
    const now = dependencies.now();
    const stored = readRemembered(dependencies.memory);
    // an old "offline since" (a tab that slept) says nothing about this cut: it would start at the 60 s probe
    const remembered =
      stored && now - stored.seen < REMEMBERED_FOR_MS ? stored : null;
    if (!dependencies.browserOnline()) {
      this.snapshot = { since: remembered?.since ?? now, state: "offline" };
      this.remember();
      this.scheduleProbe();
    } else if (remembered) {
      // reloaded while offline: open offline (no online screen first) and look at once
      this.snapshot = { since: remembered.since, state: "offline" };
      this.scheduleProbe(0);
    } else {
      dependencies.memory?.remove();
      this.snapshot = { since: now, state: "online" };
    }
  }

  getSnapshot = (): ConnectionSnapshot => this.snapshot;

  isOnline = (): boolean => this.snapshot.state === "online";

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The `Retry-After` of the Worker's last 429, once: the next try waits at least this long. */
  takeRetryAfterMs(): number | null {
    const value = this.retryAfterMs;
    this.retryAfterMs = null;
    return value;
  }

  /**
   * The `fetch` of the RPC client (and of the session lookup): the call itself, unchanged, classified
   * before anyone reads it. A response that is not the Worker's is thrown as `NoWorkerAnswerError`, so no
   * caller can take a portal's 401 or 403 for a refused session.
   */
  fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const cancelSlow = this.dependencies.schedule(
      () => this.doubt(),
      SLOW_CALL_MS
    );
    let response: Response;
    try {
      response = await this.dependencies.fetch(input, init);
    } catch (error) {
      const signal =
        init?.signal ?? (input instanceof Request ? input.signal : undefined);
      // the caller gave up (it left the screen): that says nothing about the network; an abort for time
      // (`AbortSignal.timeout`) is an answer that did not come
      if (!signal?.aborted || signal.reason?.name === "TimeoutError") {
        this.doubt();
      }
      throw error;
    } finally {
      cancelSlow();
    }
    const verdict = classifyResponse(response);
    if (verdict === "worker" || verdict === "server_failed") {
      if (verdict === "worker" && response.status === 429) {
        const seconds = Number(response.headers.get("retry-after"));
        // at most 5 min: a huge value never holds the queue back for hours
        this.retryAfterMs =
          seconds > 0 ? Math.min(seconds, RETRY_AFTER_MAX_S) * 1000 : null;
      }
      this.goOnline();
      return response;
    }
    this.doubt();
    throw new NoWorkerAnswerError(verdict);
  };

  /** "Tentar agora": one probe right now, whatever the interval; the state it ends in. */
  async probeNow(): Promise<ConnectionState> {
    await this.probe();
    return this.snapshot.state;
  }

  /** The browser's own signals. Returns how to stop listening. */
  attach(
    target: {
      addEventListener: Window["addEventListener"];
      removeEventListener: Window["removeEventListener"];
    },
    page: {
      addEventListener: Document["addEventListener"];
      removeEventListener: Document["removeEventListener"];
    }
  ): () => void {
    const onOffline = () => this.goOffline();
    const onMaybeBack = () => {
      if (this.snapshot.state === "offline") {
        this.scheduleProbe(0);
      }
    };
    const onVisibility = () => {
      if (this.dependencies.isVisible()) {
        onMaybeBack();
      } else {
        this.clearProbe(); // nothing with the page hidden; the return looks again
      }
    };
    const listeners = [
      [target, "offline", onOffline],
      [target, "online", onMaybeBack],
      [target, "pageshow", onMaybeBack],
      [page, "visibilitychange", onVisibility],
    ] as const;
    for (const [on, type, listener] of listeners) {
      on.addEventListener(type, listener);
    }
    return () => {
      for (const [on, type, listener] of listeners) {
        on.removeEventListener(type, listener);
      }
      this.clearProbe();
    };
  }

  // ------------------------------------------------------------- internals
  private mark(name: string) {
    this.dependencies.mark?.(name);
  }

  private set(state: ConnectionState) {
    if (this.snapshot.state === state) {
      return;
    }
    this.snapshot = { since: this.dependencies.now(), state };
    this.mark(`connection:state:${state}`);
    for (const listener of this.listeners) {
      listener();
    }
  }

  private remember() {
    try {
      this.dependencies.memory?.write(
        JSON.stringify({
          seen: this.dependencies.now(),
          since: this.snapshot.since,
        } satisfies Remembered)
      );
    } catch {
      // storage unavailable: the reload just starts online and finds out
    }
  }

  private goOnline() {
    if (!this.dependencies.browserOnline()) {
      // the browser says there is no network at all: whatever answered (a cache, a test's fake) proves nothing
      return;
    }
    this.step = 0;
    this.timeouts = 0;
    this.clearProbe();
    try {
      this.dependencies.memory?.remove();
    } catch {
      // nothing to forget
    }
    this.set("online");
  }

  private goOffline() {
    this.timeouts = 0;
    if (this.snapshot.state === "online") {
      this.step = 0;
    }
    this.set("offline");
    this.remember();
    this.scheduleProbe();
  }

  /** A call failed by network or hangs: online, one probe decides; offline, the schedule already looks. */
  private doubt() {
    if (this.snapshot.state === "online" && !this.probing) {
      this.probe().catch(() => undefined);
    }
  }

  private clearProbe() {
    this.cancelProbe?.();
    this.cancelProbe = null;
  }

  /** The next probe while offline: 2, 4, 8, 8… s, and 60 s after 10 min offline. */
  private nextDelay(): number {
    if (this.dependencies.now() - this.snapshot.since >= PROBE_FAST_FOR_MS) {
      return PROBE_SLOW_MS;
    }
    const delay =
      PROBE_STEPS_MS[Math.min(this.step, PROBE_STEPS_MS.length - 1)];
    this.step += 1;
    return delay ?? PROBE_SLOW_MS;
  }

  private scheduleProbe(delayMs?: number) {
    this.clearProbe();
    if (!this.dependencies.isVisible()) {
      return; // the return to the page probes
    }
    const delay = delayMs ?? this.nextDelay();
    this.cancelProbe = this.dependencies.schedule(() => {
      this.cancelProbe = null;
      this.probe().catch(() => undefined);
    }, delay);
  }

  private probe(): Promise<void> {
    if (this.probing) {
      return this.probing;
    }
    if (!this.dependencies.isVisible()) {
      return Promise.resolve();
    }
    this.clearProbe();
    const run = this.runProbe().finally(() => {
      this.probing = null;
    });
    this.probing = run;
    return run;
  }

  private async runProbe(): Promise<void> {
    const outcome: { result: ProbeResult | null } = { result: null };
    const task = async () => {
      outcome.result = await this.askHealth();
    };
    const { lock } = this.dependencies;
    if (lock) {
      await lock(PROBE_LOCK, task);
    } else {
      await task();
    }
    if (outcome.result === null) {
      // another tab is probing right now: look again at the next step
      if (this.snapshot.state === "offline") {
        this.scheduleProbe();
      }
      return;
    }
    this.settle(outcome.result);
  }

  private settle(result: ProbeResult) {
    if (result === "online") {
      this.goOnline();
      return;
    }
    if (result === "timeout" && this.snapshot.state === "online") {
      this.timeouts += 1;
      if (this.timeouts < TIMEOUTS_FOR_OFFLINE) {
        this.scheduleProbe(PROBE_STEPS_MS[0]); // look once more before calling it offline
        return;
      }
    }
    this.goOffline();
  }

  private async askHealth(): Promise<ProbeResult> {
    this.mark("connection:probe:start");
    const controller = new AbortController();
    const cancelTimeout = this.dependencies.schedule(
      () => controller.abort(new DOMException("probe_timeout", "TimeoutError")),
      PROBE_TIMEOUT_MS
    );
    try {
      const response = await this.dependencies.fetch("/health", {
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
      });
      const healthy = await isHealthy(response);
      this.mark(healthy ? "connection:probe:ok" : "connection:probe:fail");
      return healthy ? "online" : "offline";
    } catch {
      this.mark("connection:probe:fail");
      return controller.signal.aborted ? "timeout" : "offline";
    } finally {
      cancelTimeout();
    }
  }
}
