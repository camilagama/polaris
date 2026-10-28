import { afterEach, describe, expect, it, vi } from "vitest";
import type { BuildInfo } from "./sw";
import type { SwapState } from "./swap-guard";
import {
  askBuildInfo,
  type ContainerLike,
  type RegistrationLike,
  TAKE_OVER_TIMEOUT_MS,
  takeOver,
  type WorkerLike,
  watchForUpdate,
} from "./update-controller";
import {
  IDLE_WAITING_MS,
  momentAllows,
  NO_PENDING_WORK,
  type PendingWork,
  type PendingWorkSource,
  SETTLE_MS,
  workSourceBeforeRuntime,
} from "./update-model";
import { createUpdateStore } from "./update-store";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-28T15:00:00.000Z");

class FakeWorker implements WorkerLike {
  state = "installing";
  readonly messages: unknown[] = [];
  private readonly listeners: (() => void)[] = [];
  addEventListener(_type: "statechange", listener: () => void) {
    this.listeners.push(listener);
  }
  postMessage(message: unknown) {
    this.messages.push(message);
  }
  become(state: string) {
    this.state = state;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

class FakeRegistration implements RegistrationLike {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  private updateFound: (() => void)[] = [];
  addEventListener(_type: "updatefound", listener: () => void) {
    this.updateFound.push(listener);
  }
  removeEventListener(_type: "updatefound", listener: () => void) {
    this.updateFound = this.updateFound.filter((item) => item !== listener);
  }
  /** A new build starts installing, then waits. */
  deliver(worker = new FakeWorker()): FakeWorker {
    this.installing = worker;
    for (const listener of this.updateFound) {
      listener();
    }
    this.waiting = worker;
    worker.become("installed");
    return worker;
  }
}

class FakeContainer implements ContainerLike {
  controller: FakeWorker | null = new FakeWorker();
  private listeners: (() => void)[] = [];
  addEventListener(_type: "controllerchange", listener: () => void) {
    this.listeners.push(listener);
  }
  removeEventListener(_type: "controllerchange", listener: () => void) {
    this.listeners = this.listeners.filter((item) => item !== listener);
  }
  changeController(next: FakeWorker | null = this.controller) {
    this.controller = next;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

describe("noticing a new build", () => {
  it("reports a build that finishes installing while the page is controlled", () => {
    const registration = new FakeRegistration();
    const onChange = vi.fn();
    watchForUpdate(registration, new FakeContainer(), onChange);
    expect(onChange).not.toHaveBeenCalled();
    registration.deliver();
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("reports one that was already waiting when the page opened", () => {
    const registration = new FakeRegistration();
    registration.waiting = new FakeWorker();
    const onChange = vi.fn();
    watchForUpdate(registration, new FakeContainer(), onChange);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("does not call the very first installation an update", () => {
    const registration = new FakeRegistration();
    const container = new FakeContainer();
    container.controller = null;
    const onChange = vi.fn();
    watchForUpdate(registration, container, onChange);
    registration.deliver();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("asking a worker which build it serves", () => {
  it("reads the answer the worker sends to the port", async () => {
    const worker = {
      postMessage: (message: unknown, transfer?: MessagePort[]) => {
        expect(message).toEqual({ type: "BUILD_INFO" });
        transfer?.[0]?.postMessage({
          activatedAt: 5,
          id: "abc",
          publishedAt: 4,
          seenAt: 3,
          urgent: true,
          workerId: "def",
        });
      },
    };
    expect(await askBuildInfo(worker)).toEqual({
      activatedAt: 5,
      id: "abc",
      publishedAt: 4,
      seenAt: 3,
      urgent: true,
      workerId: "def",
    });
  });

  it("is null when the worker never answers (one older than the question) or there is none", async () => {
    expect(await askBuildInfo({ postMessage: () => undefined }, 20)).toBeNull();
    expect(await askBuildInfo(null)).toBeNull();
  });
});

describe("taking over", () => {
  it("asks the waiting worker and reloads once, however many times the controller changes", () => {
    const registration = new FakeRegistration();
    const worker = registration.deliver();
    const container = new FakeContainer();
    const reload = vi.fn();
    expect(takeOver(registration, container, reload)).toBe(true);
    expect(worker.messages).toEqual([{ type: "SKIP_WAITING" }]);
    expect(reload).not.toHaveBeenCalled();
    container.changeController();
    container.changeController();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does nothing when no build is waiting", () => {
    const reload = vi.fn();
    expect(takeOver(new FakeRegistration(), new FakeContainer(), reload)).toBe(
      false
    );
    expect(reload).not.toHaveBeenCalled();
  });

  describe("when the new worker never takes over (several tabs)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("reloads the page itself after the wait, once", () => {
      vi.useFakeTimers();
      const registration = new FakeRegistration();
      registration.deliver();
      const container = new FakeContainer();
      const reload = vi.fn();
      const onTimeout = vi.fn();
      takeOver(registration, container, reload, onTimeout);
      vi.advanceTimersByTime(TAKE_OVER_TIMEOUT_MS - 1);
      expect(reload).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(onTimeout).toHaveBeenCalledTimes(1);
      // a late controllerchange does not reload a second time
      container.changeController();
      expect(reload).toHaveBeenCalledTimes(1);
    });
  });
});

describe("how long a build has waited, and the moment it may go in", () => {
  it("never lets in a build out for less than 2 h, at any moment", () => {
    for (const moment of ["hidden", "return", "idle"] as const) {
      expect(momentAllows(moment, SETTLE_MS - 1)).toBe(false);
    }
    expect(momentAllows("hidden", SETTLE_MS)).toBe(true);
    expect(momentAllows("return", SETTLE_MS)).toBe(true);
  });

  it("lets the idle tab in front swap only a build waiting for more than 24 h", () => {
    expect(momentAllows("idle", IDLE_WAITING_MS)).toBe(false);
    expect(momentAllows("idle", IDLE_WAITING_MS + 1)).toBe(true);
  });

  it("lets an urgent build in at any moment, with no settling and no 24 h", () => {
    for (const moment of ["hidden", "return", "idle"] as const) {
      expect(momentAllows(moment, 0, true)).toBe(true);
      expect(momentAllows(moment, 0, false)).toBe(false);
    }
  });
});

/** A build this device saw at `seenAt` (by default 3 h ago, past the settling), of a commit of a day before. */
const build = (
  id: string,
  seenAt: number | null = NOW - 3 * HOUR,
  more: Partial<BuildInfo> = {}
): BuildInfo => ({
  activatedAt: null,
  id,
  publishedAt: NOW - 24 * HOUR,
  seenAt,
  urgent: false,
  workerId: "w1",
  ...more,
});

const QUIET: SwapState = {
  keptDrafts: 0,
  openDialogs: 0,
  screensHolding: 0,
  typedFields: 0,
  work: NO_PENDING_WORK,
  writesInFlight: 0,
};

describe("the update store", () => {
  function setup(
    options: {
      current?: BuildInfo | null;
      guard?: Partial<SwapState>;
      work?: PendingWork;
      /** The source the store starts with, left in place (no runtime handed its queue). */
      workSource?: PendingWorkSource;
    } = {}
  ) {
    const registration = new FakeRegistration();
    const container = new FakeContainer();
    const infos = new Map<unknown, BuildInfo | null>();
    const current = container.controller;
    infos.set(
      current,
      options.current === undefined ? build("A") : options.current
    );
    const reload = vi.fn();
    const keepScreen = vi.fn();
    const page = { guard: { ...options.guard } };
    let now = NOW;
    const store = createUpdateStore({
      buildInfoOf: (worker) => Promise.resolve(infos.get(worker) ?? null),
      container,
      keepScreen,
      now: () => now,
      readGuard: (work) => ({ ...QUIET, ...page.guard, work }),
      reload,
      ...(options.workSource ? { workSource: options.workSource } : {}),
    });
    const queue = { work: options.work ?? NO_PENDING_WORK };
    if (!options.workSource) {
      store.setWorkSource({
        read: () => Promise.resolve(queue.work),
        sync: () => Promise.resolve(),
      });
    }
    /** A new build `id`, installed and waiting. */
    const deliver = async (info: BuildInfo | null) => {
      const worker = new FakeWorker();
      infos.set(worker, info);
      registration.deliver(worker);
      await flush();
      return worker;
    };
    /** Another tab made `info` the active build. */
    const otherTabSwapped = async (info: BuildInfo | null) => {
      const worker = new FakeWorker();
      infos.set(worker, info);
      container.changeController(worker);
      await flush();
    };
    return {
      advance: (ms: number) => {
        now += ms;
      },
      attach: async () => {
        await store.attach(registration);
        await flush();
      },
      container,
      deliver,
      keepScreen,
      otherTabSwapped,
      page,
      queue,
      registration,
      reload,
      store,
    };
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("knows the build it runs and has nothing waiting until a new one installs", async () => {
    const test = setup();
    await test.attach();
    expect(test.store.getSnapshot()).toMatchObject({
      current: build("A"),
      pending: null,
    });
    await test.deliver(build("B"));
    expect(test.store.getSnapshot().pending).toMatchObject({
      build: build("B"),
      firstSeenAt: NOW - 3 * HOUR,
      kind: "waiting",
    });
  });

  it("swaps when the moment comes and the page holds nothing: the worker takes over and the page reloads once", async () => {
    const test = setup();
    await test.attach();
    const worker = await test.deliver(build("B"));
    expect(await test.store.trySwap("hidden")).toBe(true);
    expect(worker.messages).toEqual([{ type: "SKIP_WAITING" }]);
    expect(test.reload).not.toHaveBeenCalled();
    test.container.changeController(worker);
    await flush();
    expect(test.reload).toHaveBeenCalledTimes(1);
    expect(test.keepScreen).toHaveBeenCalledWith("hidden");
  });

  it("never swaps a build this device saw less than 2 h ago, however old its commit", async () => {
    const test = setup();
    await test.attach();
    // published (promoted) hours after its commit: the time it carries says nothing of when it got here
    const worker = await test.deliver(
      build("B", NOW - HOUR, { publishedAt: NOW - 30 * HOUR })
    );
    expect(await test.store.trySwap("hidden")).toBe(false);
    expect(worker.messages).toEqual([]);
    // two hours after the device saw it, the same moment swaps
    test.advance(HOUR);
    expect(await test.store.trySwap("hidden")).toBe(true);
  });

  it("the idle tab in front swaps only a build this device has waited on for more than 24 h", async () => {
    const test = setup();
    await test.attach();
    await test.deliver(
      build("B", NOW - 23 * HOUR, { publishedAt: NOW - 48 * HOUR })
    );
    expect(await test.store.trySwap("idle")).toBe(false);
    test.advance(2 * HOUR);
    expect(await test.store.trySwap("idle")).toBe(true);
  });

  it("an urgent build (a revert) goes in at the first moment the page holds nothing, with no settling", async () => {
    const test = setup({ guard: { openDialogs: 1 } });
    await test.attach();
    const worker = await test.deliver(build("A2", NOW, { urgent: true }));
    // never over what the page holds
    expect(await test.store.trySwap("hidden")).toBe(false);
    expect(worker.messages).toEqual([]);
    test.page.guard = {};
    expect(await test.store.trySwap("hidden")).toBe(true);
    expect(worker.messages).toEqual([{ type: "SKIP_WAITING" }]);
  });

  it("the same revert without the flag waits the 2 h from when the device saw it", async () => {
    const test = setup();
    await test.attach();
    await test.deliver(build("A2", NOW));
    expect(await test.store.trySwap("hidden")).toBe(false);
    test.advance(SETTLE_MS - 1);
    expect(await test.store.trySwap("hidden")).toBe(false);
    test.advance(1);
    expect(await test.store.trySwap("hidden")).toBe(true);
  });

  describe("a normal build published on top of an urgent one still waiting", () => {
    it("takes its urgency: it goes in at the first safe moment, with no settling", async () => {
      const test = setup();
      await test.attach();
      await test.deliver(build("A2", NOW, { urgent: true }));
      const worker = await test.deliver(build("C", NOW));
      expect(test.store.getSnapshot().pending).toMatchObject({
        build: build("C", NOW),
        kind: "waiting",
        urgent: true,
      });
      expect(await test.store.trySwap("hidden")).toBe(true);
      expect(worker.messages).toEqual([{ type: "SKIP_WAITING" }]);
    });

    it("passes it on to the next one, while none went in", async () => {
      const test = setup();
      await test.attach();
      await test.deliver(build("A2", NOW, { urgent: true }));
      await test.deliver(build("C", NOW));
      const worker = await test.deliver(build("D", NOW));
      expect(await test.store.trySwap("hidden")).toBe(true);
      expect(worker.messages).toEqual([{ type: "SKIP_WAITING" }]);
    });

    it("still never goes in over an open dialog", async () => {
      const test = setup({ guard: { openDialogs: 1 } });
      await test.attach();
      await test.deliver(build("A2", NOW, { urgent: true }));
      const worker = await test.deliver(build("C", NOW));
      expect(await test.store.trySwap("hidden")).toBe(false);
      expect(worker.messages).toEqual([]);
      test.page.guard = {};
      expect(await test.store.trySwap("hidden")).toBe(true);
      expect(worker.messages).toEqual([{ type: "SKIP_WAITING" }]);
    });

    it("keeps it when its own reload was held after the worker took over: the page still runs the old build", async () => {
      const test = setup();
      await test.attach();
      await test.deliver(build("A2", NOW, { urgent: true }));
      const worker = await test.deliver(build("C", NOW));
      expect(await test.store.trySwap("hidden")).toBe(true);
      test.page.guard = { openDialogs: 1 };
      test.container.changeController(worker);
      await flush();
      expect(test.reload).not.toHaveBeenCalled();
      expect(test.store.getSnapshot().pending).toMatchObject({
        kind: "stale",
        urgent: true,
      });
      test.page.guard = {};
      expect(await test.store.trySwap("hidden")).toBe(true);
      await flush();
      expect(test.reload).toHaveBeenCalledTimes(1);
    });

    it("keeps it in a tab where another tab made it active", async () => {
      const test = setup();
      await test.attach();
      await test.deliver(build("A2", NOW, { urgent: true }));
      await test.deliver(build("C", NOW));
      test.registration.waiting = null;
      await test.otherTabSwapped(build("C", NOW));
      expect(test.store.getSnapshot().pending).toMatchObject({
        kind: "stale",
        urgent: true,
      });
    });

    it("keeps it when the worker that took over does not say its build, or is one this page never saw waiting", async () => {
      const test = setup();
      await test.attach();
      await test.deliver(build("A2", NOW, { urgent: true }));
      await test.deliver(build("C", NOW));
      test.registration.waiting = null;
      await test.otherTabSwapped(null);
      expect(test.store.getSnapshot().pending).toMatchObject({
        build: null,
        kind: "stale",
        urgent: true,
      });
      await test.otherTabSwapped(build("D", NOW));
      expect(test.store.getSnapshot().pending).toMatchObject({
        kind: "stale",
        urgent: true,
      });
      expect(await test.store.trySwap("hidden")).toBe(true);
      await flush();
      expect(test.reload).toHaveBeenCalledTimes(1);
    });

    it("an urgent build that comes after the urgent one went in is taken over at once (a revert of the revert)", async () => {
      const test = setup();
      await test.attach();
      await test.deliver(build("A2", NOW, { urgent: true }));
      test.registration.waiting = null;
      await test.otherTabSwapped(build("A2", NOW, { urgent: true }));
      const worker = await test.deliver(build("E", NOW, { urgent: true }));
      expect(test.store.getSnapshot().pending).toMatchObject({
        build: build("E", NOW, { urgent: true }),
        kind: "waiting",
      });
      expect(await test.store.trySwap("hidden")).toBe(true);
      expect(worker.messages).toEqual([{ type: "SKIP_WAITING" }]);
    });

    it("ends at the first swap on the device: this page loads the urgent build already active, and the next one waits the 2 h", async () => {
      const test = setup();
      await test.attach();
      await test.deliver(build("A2", NOW, { urgent: true }));
      test.registration.waiting = null;
      await test.otherTabSwapped(build("A2", NOW, { urgent: true }));
      const worker = await test.deliver(build("C", NOW));
      // this page, still on the old build, loads A2 (already active) at its first safe moment; C is not taken over
      expect(test.store.getSnapshot().pending).toMatchObject({
        build: build("A2", NOW, { urgent: true }),
        kind: "stale",
      });
      expect(await test.store.trySwap("hidden")).toBe(true);
      await flush();
      expect(worker.messages).toEqual([]);
      expect(test.reload).toHaveBeenCalledTimes(1);

      // the page loaded on A2 sees C as any build: 2 h from when the device saw it
      const next = setup({ current: build("A2", NOW, { urgent: true }) });
      await next.attach();
      const waiting = await next.deliver(build("C", NOW));
      expect(next.store.getSnapshot().pending).toMatchObject({
        firstSeenAt: NOW,
        urgent: false,
      });
      expect(await next.store.trySwap("hidden")).toBe(false);
      next.advance(SETTLE_MS - 1);
      expect(await next.store.trySwap("hidden")).toBe(false);
      next.advance(1);
      expect(await next.store.trySwap("hidden")).toBe(true);
      expect(waiting.messages).toEqual([{ type: "SKIP_WAITING" }]);
    });
  });

  describe("before the offline runtime hands its queue", () => {
    it("with the runtime off there is no queue: it swaps", async () => {
      const test = setup({ workSource: workSourceBeforeRuntime(false) });
      await test.attach();
      await test.deliver(build("B"));
      expect(await test.store.trySwap("hidden")).toBe(true);
    });

    it("with the runtime on the queue cannot be read yet (the login screen): it never swaps, not even an urgent build", async () => {
      const test = setup({ workSource: workSourceBeforeRuntime(true) });
      await test.attach();
      const worker = await test.deliver(build("B", NOW, { urgent: true }));
      expect(await test.store.trySwap("hidden")).toBe(false);
      expect(worker.messages).toEqual([]);
      // once the runtime hands its queue, an empty one lets it in
      test.store.setWorkSource({
        read: () => Promise.resolve(NO_PENDING_WORK),
        sync: () => Promise.resolve(),
      });
      expect(await test.store.trySwap("hidden")).toBe(true);
    });
  });

  it("counts from when the page saw the build when the worker wrote no time, or one in the device's future", async () => {
    const test = setup();
    await test.attach();
    await test.deliver(build("B", null));
    expect(test.store.getSnapshot().pending?.firstSeenAt).toBe(NOW);
    // a clock set back since the worker wrote its time: the page's own time, never a wait without end
    await test.deliver(build("C", NOW + 24 * HOUR));
    expect(test.store.getSnapshot().pending?.firstSeenAt).toBe(NOW);
  });

  it.each<[string, Partial<SwapState>]>([
    ["a dialog open", { openDialogs: 1 }],
    ["a screen with a change (a sale with an item)", { screensHolding: 1 }],
    ["a draft kept for the way back", { keptDrafts: 1 }],
    ["a write on its way", { writesInFlight: 1 }],
    ["a field with text typed", { typedFields: 1 }],
  ])("never swaps over %s", async (_name, guard) => {
    const test = setup({ guard });
    await test.attach();
    const worker = await test.deliver(build("B"));
    expect(await test.store.trySwap("hidden")).toBe(false);
    expect(worker.messages).toEqual([]);
    expect(test.reload).not.toHaveBeenCalled();
    // it goes away: the next moment swaps
    test.page.guard = {};
    expect(await test.store.trySwap("hidden")).toBe(true);
  });

  it.each<[string, PendingWork]>([
    ["pending", { pending: 2, rejected: 0, sending: 0 }],
    ["being sent", { pending: 0, rejected: 0, sending: 1 }],
    ["refused", { pending: 0, rejected: 1, sending: 0 }],
  ])("never swaps with work in the sync queue (%s)", async (_name, work) => {
    const test = setup({ work });
    await test.attach();
    const worker = await test.deliver(build("B"));
    expect(await test.store.trySwap("hidden")).toBe(false);
    expect(worker.messages).toEqual([]);
    expect(test.store.getSnapshot().work).toEqual(work);
  });

  it("never swaps when the queue cannot be read", async () => {
    const test = setup();
    await test.attach();
    test.store.setWorkSource({
      read: () => Promise.reject(new Error("idb")),
      sync: () => Promise.resolve(),
    });
    await test.deliver(build("B"));
    expect(await test.store.trySwap("hidden")).toBe(false);
  });

  it("does not reload when something came up while the worker took over: it waits for the next moment", async () => {
    const test = setup();
    await test.attach();
    const worker = await test.deliver(build("B"));
    expect(await test.store.trySwap("hidden")).toBe(true);
    test.page.guard = { openDialogs: 1 };
    test.container.changeController(worker);
    await flush();
    expect(test.reload).not.toHaveBeenCalled();
    expect(test.store.getSnapshot()).toMatchObject({
      pending: { kind: "stale" },
      swapping: false,
    });
    test.page.guard = {};
    expect(await test.store.trySwap("hidden")).toBe(true);
    await flush();
    expect(test.reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload when the moment ended while the worker took over (the tab came back): it waits for the next one", async () => {
    const test = setup();
    await test.attach();
    const worker = await test.deliver(build("B"));
    let hidden = true;
    expect(await test.store.trySwap("hidden", () => hidden)).toBe(true);
    hidden = false;
    test.container.changeController(worker);
    await flush();
    expect(test.reload).not.toHaveBeenCalled();
    expect(test.store.getSnapshot().pending).toMatchObject({ kind: "stale" });
  });

  it("does not swap when the moment is already over after the queue was read", async () => {
    const test = setup();
    await test.attach();
    const worker = await test.deliver(build("B"));
    expect(await test.store.trySwap("hidden", () => false)).toBe(false);
    expect(worker.messages).toEqual([]);
  });

  it("reads the queue again right before the reload: work that came in meanwhile holds it", async () => {
    const test = setup();
    await test.attach();
    const worker = await test.deliver(build("B"));
    expect(await test.store.trySwap("hidden")).toBe(true);
    test.queue.work = { pending: 0, rejected: 0, sending: 1 };
    test.container.changeController(worker);
    await flush();
    expect(test.reload).not.toHaveBeenCalled();
  });

  it("a build that says nothing of itself never takes the age of another one that said nothing", async () => {
    const test = setup({ current: null });
    await test.attach();
    await test.deliver(null);
    test.advance(SETTLE_MS);
    await test.deliver(null);
    expect(test.store.getSnapshot().pending?.firstSeenAt).toBe(NOW + SETTLE_MS);
  });

  it("a waiting build with the same files and another worker code is a build like any other: it waits its moment", async () => {
    const test = setup();
    await test.attach();
    const worker = await test.deliver(build("A", NOW, { workerId: "w2" }));
    expect(worker.messages).toEqual([]);
    expect(test.store.getSnapshot().pending).toMatchObject({
      firstSeenAt: NOW,
      kind: "waiting",
    });
    expect(await test.store.trySwap("hidden")).toBe(false);
  });

  it("takes a waiting build with this page's own content at once, with no reload and nothing to wait for", async () => {
    const test = setup({ guard: { openDialogs: 1 } });
    await test.attach();
    const worker = await test.deliver(build("A", NOW));
    expect(worker.messages).toEqual([{ type: "SKIP_WAITING" }]);
    expect(test.store.getSnapshot().pending).toBeNull();
    test.container.changeController(worker);
    await flush();
    expect(test.store.getSnapshot().pending).toBeNull();
    expect(test.reload).not.toHaveBeenCalled();
  });

  describe("with two tabs", () => {
    it("the other tab's swap never reloads this one: it waits for its own moment", async () => {
      const test = setup({ guard: { typedFields: 1 } });
      await test.attach();
      await test.deliver(build("B"));
      test.registration.waiting = null;
      await test.otherTabSwapped(build("B"));
      expect(test.reload).not.toHaveBeenCalled();
      expect(test.store.getSnapshot().pending).toMatchObject({
        build: build("B"),
        firstSeenAt: NOW - 3 * HOUR,
        kind: "stale",
      });
      // its draft holds it; once it is gone, its own moment loads the build already active
      expect(await test.store.trySwap("hidden")).toBe(false);
      test.page.guard = {};
      expect(await test.store.trySwap("hidden")).toBe(true);
      await flush();
      expect(test.reload).toHaveBeenCalledTimes(1);
    });

    it("a tab that took a worker of the same content is no swap for this one", async () => {
      const test = setup();
      await test.attach();
      await test.otherTabSwapped(build("A", NOW));
      expect(test.store.getSnapshot().pending).toBeNull();
    });

    it("a worker that does not say its build counts as a new one", async () => {
      const test = setup({ current: null });
      await test.attach();
      await test.otherTabSwapped(null);
      expect(test.store.getSnapshot().pending).toMatchObject({
        build: null,
        kind: "stale",
      });
      // the age is this page's own: it saw it now, so it waits the 2 h
      expect(await test.store.trySwap("hidden")).toBe(false);
      test.advance(SETTLE_MS);
      expect(await test.store.trySwap("hidden")).toBe(true);
    });
  });

  it("tells its subscribers when something changes, and only then", async () => {
    const test = setup();
    await test.attach();
    const listener = vi.fn();
    const stop = test.store.subscribe(listener);
    await test.store.refreshWork();
    expect(listener).not.toHaveBeenCalled();
    await test.deliver(build("B"));
    expect(listener).toHaveBeenCalled();
    stop();
  });
});
