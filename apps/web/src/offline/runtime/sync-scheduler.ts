import { jittered } from "../../lib/connection";
import type { RuntimeSnapshot } from "./offline-runtime";

/**
 * WHEN the offline runtime syncs (emenda do ADR 0043): the only scheduler, in the runtime provider. The
 * runtime only says how a sync ended (offline, `server_busy` or `sync_failed`); the connection only says whether the
 * Worker answers. Here:
 *
 * - every 60 s while the page is visible, in ONE tab of the browser per store (the one holding the lock
 *   of `isLeader`, Web Locks): the other tabs hear its pull through the data channel. One real try,
 *   even with the connection not proven (an answer of the Worker to it is what proves it again). A hidden page
 *   never pulls on the tick. After a tick that found nothing (an answered, empty pull and an empty queue) the interval
 *   doubles, 60, 120, 240 and 300 s at most; anything that is work (a pull with changes, a send, a queued
 *   command, a return to the page, "Tentar agora", the connection back) brings it back to 60 s. Sending a queued
 *   command never waits for the interval;
 * - at start and on the return to the page (`refresh`): the same try, unless some tab of this browser
 *   pulled the store less than 60 s ago and nothing is queued. Each screen is its own page load, so
 *   without this every change of screen was a pull (the ~2.5 s pulls seen in QA);
 * - when the connection comes back: a sync about 1 s later (±20%, so tabs and devices do not come back
 *   together);
 * - after `server_busy` or `sync_failed` (a 5xx, a 429), and after a transient failure the runtime still keeps quiet (a Worker
 *   killed for CPU, `retriesQuietly`): again in 2, 4, 8, 20, 40 and then 60 s (±20%), never before the
 *   `Retry-After` of a 429. The sync never goes through the retries of the screens' reads: these steps are its own.
 *
 * Never two runs pending: the runtime's sync is single-flight, and each of the timers here is replaced,
 * never added. Framework-free, with the clock and the page injected.
 */
function failedLoudly({ reason }: RuntimeSnapshot): boolean {
  return reason === "sync_failed" || reason === "server_busy";
}

interface SchedulerRuntime {
  connectionChanged: () => void;
  getSnapshot: () => RuntimeSnapshot;
  retriesQuietly: () => boolean;
  /**
   * Whether the local copy was pulled (by any tab) less than `maxAgeMs` ago and nothing waits to be
   * sent; without it every start and return syncs.
   */
  isFresh?: (maxAgeMs: number) => Promise<boolean>;
  /** Whether the last full sync was answered and found nothing to send or pull; without it the interval never grows. */
  lastPullWasIdle?: () => boolean;
  subscribe?: (listener: () => void) => () => void;
  syncNow: () => Promise<void>;
}

interface SchedulerConnection {
  isOnline: () => boolean;
  subscribe: (listener: () => void) => () => void;
  takeRetryAfterMs: () => number | null;
}

export interface SyncSchedulerDependencies {
  connection: SchedulerConnection;
  /**
   * Whether this tab is the one of the browser that pulls on the tick (it holds the Web Lock of the store);
   * always, without it (a browser without Web Locks keeps one tick per tab).
   */
  isLeader?: () => boolean;
  isVisible: () => boolean;
  /** Calls the listener when the page comes back to the front; returns how to stop. */
  onVisible: (listener: () => void) => () => void;
  random: () => number;
  runtime: SchedulerRuntime;
  schedule: (callback: () => void, delayMs: number) => () => void;
}

export interface SyncScheduler {
  /** The start and the return to the page: a sync, unless the copy is fresh and nothing is queued. */
  refresh: () => Promise<void>;
  stop: () => void;
  /** A sync now (the start, "Tentar agora"); the same run when one is on its way. */
  syncNow: () => Promise<void>;
}

export const TICK_MS = 60_000;
export const MAX_TICK_MS = 300_000;
const BACK_ONLINE_MS = 1000;
const RETRY_STEPS_MS = [2000, 4000, 8000, 20_000, 40_000, 60_000] as const;

export function startSyncScheduler(
  dependencies: SyncSchedulerDependencies
): SyncScheduler {
  const { connection, runtime, schedule } = dependencies;
  let stopped = false;
  let pending: Promise<void> | null = null;
  let retryStep = 0;
  let cancelRetry: (() => void) | null = null;
  let cancelReturn: (() => void) | null = null;
  let cancelTick: (() => void) | null = null;
  let tickMs = TICK_MS;
  let tickSyncing = false;
  let busyDuringTick = false;
  let online = connection.isOnline();

  const clearRetry = () => {
    cancelRetry?.();
    cancelRetry = null;
  };

  const scheduleRetry = () => {
    clearRetry();
    const step =
      RETRY_STEPS_MS[Math.min(retryStep, RETRY_STEPS_MS.length - 1)] ?? TICK_MS;
    retryStep += 1;
    const delay = Math.max(
      jittered(step, dependencies.random),
      connection.takeRetryAfterMs() ?? 0
    );
    cancelRetry = schedule(() => {
      cancelRetry = null;
      sync().catch(() => undefined);
    }, delay);
  };

  const sync = (): Promise<void> => {
    if (stopped) {
      return Promise.resolve();
    }
    if (pending) {
      return pending;
    }
    clearRetry();
    const run = runtime
      .syncNow()
      .catch(() => undefined)
      .then(() => {
        if (stopped) {
          return;
        }
        if (failedLoudly(runtime.getSnapshot()) || runtime.retriesQuietly()) {
          scheduleRetry();
        } else {
          retryStep = 0;
        }
      })
      .finally(() => {
        pending = null;
      });
    pending = run;
    return run;
  };

  const refresh = async (): Promise<void> => {
    if (pending) {
      return pending;
    }
    const fresh = await runtime.isFresh?.(TICK_MS).catch(() => false);
    if (!fresh) {
      await sync();
    }
  };

  const isLeader = dependencies.isLeader ?? (() => true);
  const queued = () => {
    const { counts } = runtime.getSnapshot();
    return counts.pending + counts.sending > 0;
  };
  const idleAfterSync = () =>
    !(
      failedLoudly(runtime.getSnapshot()) ||
      runtime.retriesQuietly() ||
      queued()
    ) && runtime.lastPullWasIdle?.() === true;
  const tick = () => {
    cancelTick?.();
    cancelTick = schedule(() => {
      cancelTick = null;
      if (stopped) {
        return;
      }
      if (!(dependencies.isVisible() && isLeader())) {
        tick();
        return;
      }
      tickSyncing = true;
      busyDuringTick = false;
      sync()
        .catch(() => undefined)
        .then(() => {
          tickSyncing = false;
          if (stopped) {
            return;
          }
          tickMs =
            idleAfterSync() && !busyDuringTick
              ? Math.min(tickMs * 2, MAX_TICK_MS)
              : TICK_MS;
          tick();
        });
    }, tickMs);
  };
  const backToBusyInterval = () => {
    busyDuringTick = true;
    if (tickMs === TICK_MS) {
      return;
    }
    tickMs = TICK_MS;
    if (!(tickSyncing || stopped)) {
      tick();
    }
  };
  tick();

  const stopQueue = runtime.subscribe?.(() => {
    if (queued()) {
      backToBusyInterval();
    }
  });

  const stopVisible = dependencies.onVisible(() => {
    backToBusyInterval();
    refresh().catch(() => undefined);
  });

  const stopConnection = connection.subscribe(() => {
    const now = connection.isOnline();
    if (now === online) {
      return;
    }
    online = now;
    runtime.connectionChanged();
    cancelReturn?.();
    cancelReturn = null;
    if (now) {
      backToBusyInterval();
      cancelReturn = schedule(
        () => {
          cancelReturn = null;
          sync().catch(() => undefined);
        },
        jittered(BACK_ONLINE_MS, dependencies.random)
      );
    }
  });

  return {
    refresh,
    stop: () => {
      stopped = true;
      clearRetry();
      cancelReturn?.();
      cancelTick?.();
      stopQueue?.();
      stopVisible();
      stopConnection();
    },
    syncNow: () => {
      backToBusyInterval();
      return sync();
    },
  };
}
