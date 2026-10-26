import { jittered } from "../../lib/connection";
import type { RuntimeSnapshot } from "./offline-runtime";

/**
 * WHEN the offline runtime syncs (emenda do ADR 0043): the only scheduler, in the runtime provider. The
 * runtime only says how a sync ended (offline, or `sync_failed`); the connection only says whether the
 * Worker answers. Here:
 *
 * - at start, on the return to the page and every 60 s while it is visible: one real try, even with the
 *   connection not proven (an answer of the Worker to it is what proves it again);
 * - when the connection comes back: a sync about 1 s later (±20%, so tabs and devices do not come back
 *   together);
 * - after `sync_failed` (a 5xx, a 429), and after a transient failure the runtime still keeps quiet (a Worker
 *   killed for CPU, `retriesQuietly`): again in 2, 4, 8, 20, 40 and then 60 s (±20%), never before the
 *   `Retry-After` of a 429. The sync never goes through the retries of the screens' reads: these steps are its own.
 *
 * Never two runs pending: the runtime's sync is single-flight, and each of the timers here is replaced,
 * never added. Framework-free, with the clock and the page injected.
 */
interface SchedulerRuntime {
  connectionChanged: () => void;
  getSnapshot: () => RuntimeSnapshot;
  retriesQuietly: () => boolean;
  syncNow: () => Promise<void>;
}

interface SchedulerConnection {
  isOnline: () => boolean;
  subscribe: (listener: () => void) => () => void;
  takeRetryAfterMs: () => number | null;
}

export interface SyncSchedulerDependencies {
  connection: SchedulerConnection;
  isVisible: () => boolean;
  /** Calls the listener when the page comes back to the front; returns how to stop. */
  onVisible: (listener: () => void) => () => void;
  random: () => number;
  runtime: SchedulerRuntime;
  schedule: (callback: () => void, delayMs: number) => () => void;
}

export interface SyncScheduler {
  stop: () => void;
  /** A sync now (the start, "Tentar agora"); the same run when one is on its way. */
  syncNow: () => Promise<void>;
}

const TICK_MS = 60_000;
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
        if (
          runtime.getSnapshot().reason === "sync_failed" ||
          runtime.retriesQuietly()
        ) {
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

  const tick = () => {
    cancelTick = schedule(() => {
      if (dependencies.isVisible()) {
        sync().catch(() => undefined);
      }
      tick();
    }, TICK_MS);
  };
  tick();

  const stopVisible = dependencies.onVisible(() => {
    sync().catch(() => undefined);
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
    stop: () => {
      stopped = true;
      clearRetry();
      cancelReturn?.();
      cancelTick?.();
      stopVisible();
      stopConnection();
    },
    syncNow: sync,
  };
}
