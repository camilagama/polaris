import { describe, expect, it, vi } from "vitest";
import type { RuntimeSnapshot } from "./offline-runtime";
import { startSyncScheduler } from "./sync-scheduler";

async function flush() {
  for (let i = 0; i < 30; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each turn lets the next microtask run
    await Promise.resolve();
  }
}

/** Starts a sync without waiting for it (it is settled by hand). */
function fire(run: Promise<void>) {
  run.catch(() => undefined);
}

interface Options {
  /** When true, every `syncNow` of the runtime waits until the test settles it. */
  manual?: boolean;
  random?: number;
  visible?: boolean;
}

function setup(options: Options = {}) {
  let now = 0;
  let nextId = 0;
  const timers = new Map<
    number,
    { at: number; callback: () => void; delay: number }
  >();
  const state = {
    online: true,
    /** The runtime keeps quiet about a transient failure (a Worker killed for CPU) for its first 60 s. */
    quiet: false,
    reason: null as string | null,
    retryAfterMs: null as number | null,
    visible: options.visible ?? true,
  };
  // runtime
  const runs = { max: 0, pending: 0, started: 0 };
  const settlers: (() => void)[] = [];
  const syncNow = vi.fn(() => {
    runs.started += 1;
    runs.pending += 1;
    runs.max = Math.max(runs.max, runs.pending);
    return new Promise<void>((resolve) => {
      const done = () => {
        runs.pending -= 1;
        resolve();
      };
      if (options.manual) {
        settlers.push(done);
      } else {
        done();
      }
    });
  });
  const connectionChanged = vi.fn();
  const runtime = {
    connectionChanged,
    getSnapshot: () => ({ reason: state.reason }) as RuntimeSnapshot,
    retriesQuietly: () => state.quiet,
    syncNow,
  };
  // connection
  const listeners = new Set<() => void>();
  const connection = {
    isOnline: () => state.online,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    takeRetryAfterMs: () => {
      const value = state.retryAfterMs;
      state.retryAfterMs = null;
      return value;
    },
  };
  // page
  const visibleListeners = new Set<() => void>();
  const scheduler = startSyncScheduler({
    connection,
    isVisible: () => state.visible,
    onVisible: (listener) => {
      visibleListeners.add(listener);
      return () => {
        visibleListeners.delete(listener);
      };
    },
    random: () => options.random ?? 0.5,
    runtime,
    schedule: (callback, delay) => {
      nextId += 1;
      const id = nextId;
      timers.set(id, { at: now + delay, callback, delay });
      return () => {
        timers.delete(id);
      };
    },
  });
  const advance = async (ms: number) => {
    const target = now + ms;
    for (;;) {
      const [due] = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
      if (!due) {
        break;
      }
      now = Math.max(now, due[1].at);
      timers.delete(due[0]);
      due[1].callback();
      // biome-ignore lint/performance/noAwaitInLoops: each timer runs in order, with its promises settled
      await flush();
    }
    now = target;
    await flush();
  };
  return {
    advance,
    connectionChanged,
    listeners,
    liveDelays: () => [...timers.values()].map((timer) => timer.delay),
    now: () => now,
    returnToFront: () => {
      for (const listener of visibleListeners) {
        listener();
      }
    },
    runs,
    scheduler,
    /** The connection says it changed (the scheduler reads `isOnline`). */
    setOnline: (online: boolean) => {
      state.online = online;
      for (const listener of [...listeners]) {
        listener();
      }
    },
    settleAll: async () => {
      for (const settle of settlers.splice(0)) {
        settle();
      }
      await flush();
    },
    state,
    syncNow,
    visibleListeners,
  };
}

describe("the 60 s tick and the return to the page", () => {
  it("syncs every 60 s while the page is visible", async () => {
    const t = setup();

    await t.advance(59_999);
    expect(t.syncNow).not.toHaveBeenCalled();
    await t.advance(1);
    expect(t.syncNow).toHaveBeenCalledTimes(1);
    await t.advance(60_000);
    expect(t.syncNow).toHaveBeenCalledTimes(2);
  });

  it("does not sync on the tick with the page hidden, and goes on ticking", async () => {
    const t = setup({ visible: false });

    await t.advance(5 * 60_000);
    expect(t.syncNow).not.toHaveBeenCalled();

    t.state.visible = true;
    await t.advance(60_000);
    expect(t.syncNow).toHaveBeenCalledTimes(1);
  });

  it("syncs when the page comes back to the front", async () => {
    const t = setup();

    t.returnToFront();
    await flush();

    expect(t.syncNow).toHaveBeenCalledTimes(1);
  });

  it("syncNow of the scheduler is one real try", async () => {
    const t = setup();
    await t.scheduler.syncNow();
    expect(t.syncNow).toHaveBeenCalledTimes(1);
  });
});

describe("the connection coming back and going", () => {
  it("tells the runtime and syncs about 1 s after it comes back", async () => {
    for (const [random, expected] of [
      [0, 800],
      [1, 1200],
      [0.5, 1000],
    ] as const) {
      const t = setup({ random, visible: false });
      t.setOnline(false);
      t.connectionChanged.mockClear();

      t.setOnline(true);
      expect(t.connectionChanged).toHaveBeenCalledTimes(1);
      // biome-ignore lint/performance/noAwaitInLoops: each draw has its own scheduler
      await t.advance(expected - 1);
      expect(t.syncNow).not.toHaveBeenCalled();
      await t.advance(1);
      expect(t.syncNow).toHaveBeenCalledTimes(1);
    }
  });

  it("tells the runtime when it goes offline and does not sync", async () => {
    const t = setup({ visible: false });

    t.setOnline(false);
    await t.advance(30_000);

    expect(t.connectionChanged).toHaveBeenCalledTimes(1);
    expect(t.syncNow).not.toHaveBeenCalled();
  });

  it("going offline again cancels the sync that was waiting for the return", async () => {
    const t = setup({ visible: false });
    t.setOnline(false);
    t.setOnline(true);
    await t.advance(500);
    t.setOnline(false);
    await t.advance(30_000);

    expect(t.syncNow).not.toHaveBeenCalled();
  });

  it("ignores a notification that did not change the state", async () => {
    const t = setup({ visible: false });

    t.setOnline(true);
    await t.advance(30_000);

    expect(t.connectionChanged).not.toHaveBeenCalled();
    expect(t.syncNow).not.toHaveBeenCalled();
  });
});

describe("after a failed sync", () => {
  it("tries again in 2, 4, 8, 20, 40 and then 60 s", async () => {
    const t = setup({ visible: false });
    t.state.reason = "sync_failed";

    await t.scheduler.syncNow();
    const gaps: number[] = [];
    let last = t.now();
    for (let i = 0; i < 6; i += 1) {
      const before = t.syncNow.mock.calls.length;
      // biome-ignore lint/performance/noAwaitInLoops: the retries come one after the other
      await t.advance(1000);
      while (t.syncNow.mock.calls.length === before) {
        // biome-ignore lint/performance/noAwaitInLoops: the retries come one after the other
        await t.advance(1000);
      }
      gaps.push(t.now() - last);
      last = t.now();
    }

    expect(gaps).toEqual([2000, 4000, 8000, 20_000, 40_000, 60_000]);
  });

  it("spreads each wait by 20% either way", async () => {
    for (const [random, first] of [
      [0, 1600],
      [1, 2400],
    ] as const) {
      const t = setup({ random, visible: false });
      t.state.reason = "sync_failed";
      // biome-ignore lint/performance/noAwaitInLoops: each draw has its own scheduler
      await t.scheduler.syncNow();
      expect(t.liveDelays()).toContain(first);
    }
  });

  it("waits for the Retry-After of a 429 when it is longer", async () => {
    const t = setup({ visible: false });
    t.state.reason = "sync_failed";
    t.state.retryAfterMs = 30_000;

    await t.scheduler.syncNow();
    expect(t.syncNow).toHaveBeenCalledTimes(1);
    await t.advance(29_999);
    expect(t.syncNow).toHaveBeenCalledTimes(1);
    await t.advance(1);
    expect(t.syncNow).toHaveBeenCalledTimes(2);
  });

  it("keeps its own wait when the Retry-After is shorter", async () => {
    const t = setup({ visible: false });
    t.state.reason = "sync_failed";
    t.state.retryAfterMs = 1000;

    await t.scheduler.syncNow();
    await t.advance(1999);
    expect(t.syncNow).toHaveBeenCalledTimes(1);
    await t.advance(1);
    expect(t.syncNow).toHaveBeenCalledTimes(2);
  });

  it("starts the steps again after a sync that went through", async () => {
    const t = setup({ visible: false });
    t.state.reason = "sync_failed";
    await t.scheduler.syncNow();
    await t.advance(2000); // the retry: fails again, next wait is 4 s
    expect(t.syncNow).toHaveBeenCalledTimes(2);

    t.state.reason = null;
    await t.advance(4000); // goes through
    expect(t.syncNow).toHaveBeenCalledTimes(3);
    expect(t.liveDelays()).not.toContain(8000);

    t.state.reason = "sync_failed";
    await t.scheduler.syncNow();
    expect(t.liveDelays()).toContain(2000);
  });

  it("a transient failure the runtime keeps quiet (1102) is tried again in 2, 4 and 8 s, with no sync_failed", async () => {
    const t = setup({ visible: false });
    t.state.quiet = true;

    await t.scheduler.syncNow();
    await t.advance(2000);
    expect(t.syncNow).toHaveBeenCalledTimes(2);
    await t.advance(4000);
    expect(t.syncNow).toHaveBeenCalledTimes(3);
    await t.advance(8000);
    expect(t.syncNow).toHaveBeenCalledTimes(4);
    expect(t.state.reason).toBeNull();
  });

  it("does not retry after a sync that ended with no answer (reason null)", async () => {
    const t = setup({ visible: false });

    await t.scheduler.syncNow();
    await t.advance(10 * 60_000);

    expect(t.syncNow).toHaveBeenCalledTimes(1);
  });

  it("goes on after a sync that threw", async () => {
    const t = setup({ visible: false });
    t.syncNow.mockImplementationOnce(() => Promise.reject(new Error("boom")));

    await expect(t.scheduler.syncNow()).resolves.toBeUndefined();
    await t.scheduler.syncNow();

    expect(t.syncNow).toHaveBeenCalledTimes(2);
  });
});

describe("never two runs and never two timers", () => {
  const retryDelays = [2000, 4000, 8000, 20_000, 40_000];
  const retryTimers = (t: ReturnType<typeof setup>) =>
    t.liveDelays().filter((delay) => retryDelays.includes(delay)).length;
  const returnTimers = (t: ReturnType<typeof setup>) =>
    t.liveDelays().filter((delay) => delay === 1000).length;

  it("a slow runtime sync never has two calls pending, and one retry timer at most", async () => {
    const t = setup({ manual: true });
    t.state.reason = "sync_failed";

    fire(t.scheduler.syncNow());
    t.returnToFront();
    await t.advance(60_000); // the tick
    fire(t.scheduler.syncNow());
    t.setOnline(false);
    t.setOnline(true);
    await t.advance(1000); // the return
    fire(t.scheduler.syncNow());
    t.returnToFront();
    await flush();

    expect(t.runs.started).toBe(1);
    expect(t.runs.pending).toBe(1);

    // it ends, failed: one retry timer; calls before it fires join the next run
    await t.settleAll();
    expect(retryTimers(t)).toBe(1);
    fire(t.scheduler.syncNow());
    expect(t.runs.pending).toBe(1);
    expect(retryTimers(t)).toBe(0); // the run in flight took the timer's place
    await t.settleAll();
    expect(retryTimers(t)).toBe(1);

    for (let i = 0; i < 4; i += 1) {
      t.setOnline(false);
      t.setOnline(true);
      // biome-ignore lint/performance/noAwaitInLoops: the changes come in a row
      await t.advance(10);
      expect(returnTimers(t)).toBeLessThanOrEqual(1);
      expect(retryTimers(t)).toBeLessThanOrEqual(1);
    }
    await t.advance(120_000);
    await t.settleAll();
    await t.advance(120_000);
    await t.settleAll();

    expect(t.runs.max).toBe(1);
    expect(retryTimers(t)).toBeLessThanOrEqual(1);
  });

  it("a timer that fires while a run is pending joins it instead of starting another", async () => {
    const t = setup({ manual: true });
    t.state.reason = "sync_failed";

    fire(t.scheduler.syncNow());
    await t.advance(60_000); // the tick fires with the run pending
    await t.advance(60_000);

    expect(t.syncNow).toHaveBeenCalledTimes(1);
    expect(t.runs.max).toBe(1);
  });
});

describe("stop", () => {
  it("cancels the tick, the retry, the return and the listeners", async () => {
    const t = setup({ manual: false });
    t.state.reason = "sync_failed";
    await t.scheduler.syncNow(); // a retry is waiting
    t.setOnline(false);
    t.setOnline(true); // a return is waiting
    const calls = t.syncNow.mock.calls.length;

    t.scheduler.stop();

    expect(t.liveDelays()).toEqual([]);
    expect(t.listeners.size).toBe(0);
    expect(t.visibleListeners.size).toBe(0);
    await t.advance(10 * 60_000);
    expect(t.syncNow.mock.calls.length).toBe(calls);
  });

  it("no longer syncs, and a run that ends after it schedules nothing", async () => {
    const t = setup({ manual: true });
    t.state.reason = "sync_failed";
    fire(t.scheduler.syncNow());

    t.scheduler.stop();
    await t.settleAll();

    expect(t.liveDelays()).toEqual([]);
    await expect(t.scheduler.syncNow()).resolves.toBeUndefined();
    expect(t.syncNow).toHaveBeenCalledTimes(1);
  });
});
