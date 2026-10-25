import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UpdateBannerView } from "./update-banner";
import {
  type ContainerLike,
  type RegistrationLike,
  takeOver,
  TAKE_OVER_TIMEOUT_MS,
  type WorkerLike,
  watchForUpdate,
} from "./update-controller";
import {
  applyWhenSafe,
  NO_PENDING_WORK,
  offerFor,
  type PendingWork,
  type PendingWorkSource,
} from "./update-model";
import { createUpdateStore } from "./update-store";

const noop = () => undefined;
const work = (overrides: Partial<PendingWork> = {}): PendingWork => ({
  ...NO_PENDING_WORK,
  ...overrides,
});

describe("what an update offers", () => {
  it("nothing without a waiting build, whatever is queued", () => {
    expect(offerFor(false, work())).toEqual({ kind: "none" });
    expect(offerFor(false, work({ pending: 5, rejected: 1 }))).toEqual({
      kind: "none",
    });
  });

  it("can be applied at once only when the queue is empty", () => {
    expect(offerFor(true, work())).toEqual({ kind: "ready" });
  });

  it("with queued work, sends first and updates only afterwards", () => {
    expect(offerFor(true, work({ pending: 2, sending: 1 }))).toEqual({
      kind: "after_sync",
      pending: 2,
      sending: 1,
    });
  });

  it("waits for the person when the server refused something", () => {
    expect(offerFor(true, work({ pending: 3, rejected: 1 }))).toEqual({
      kind: "deferred",
      rejected: 1,
      total: 4,
    });
  });
});

function source(
  reads: PendingWork[],
  sync: () => Promise<void> = () => Promise.resolve()
): PendingWorkSource & { reads: number } {
  const value = {
    read: () => {
      const next = reads[Math.min(value.reads, reads.length - 1)] ?? work();
      value.reads += 1;
      return Promise.resolve(next);
    },
    reads: 0,
    sync: vi.fn(sync),
  };
  return value;
}

describe("applying an update safely", () => {
  it("applies straight away on an empty queue", async () => {
    const apply = vi.fn();
    const outcome = await applyWhenSafe(source([work()]), apply);
    expect(outcome).toEqual({ status: "applying" });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("sends first and applies only if the queue ended up empty", async () => {
    const apply = vi.fn();
    const queue = source([work({ pending: 2 }), work()]);
    expect(await applyWhenSafe(queue, apply)).toEqual({ status: "applying" });
    expect(queue.sync).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("never applies over work the sync could not clear", async () => {
    const apply = vi.fn();
    const stuck = source([work({ pending: 2 }), work({ pending: 1 })]);
    expect(await applyWhenSafe(stuck, apply)).toEqual({
      reason: "queue_not_empty",
      status: "deferred",
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it("never applies when the network is down, and says so", async () => {
    const apply = vi.fn();
    const offline = source([work({ pending: 2 })], () =>
      Promise.reject(new Error("offline"))
    );
    expect(await applyWhenSafe(offline, apply)).toEqual({
      reason: "sync_failed",
      status: "deferred",
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it("never tries to send over a refusal: it waits for the person", async () => {
    const apply = vi.fn();
    const refused = source([work({ pending: 1, rejected: 1 })]);
    expect(await applyWhenSafe(refused, apply)).toEqual({
      reason: "queue_not_empty",
      status: "deferred",
    });
    expect(refused.sync).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });
});

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
  deliver(): FakeWorker {
    const worker = new FakeWorker();
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
  controller: unknown = {};
  private listeners: (() => void)[] = [];
  addEventListener(_type: "controllerchange", listener: () => void) {
    this.listeners.push(listener);
  }
  removeEventListener(_type: "controllerchange", listener: () => void) {
    this.listeners = this.listeners.filter((item) => item !== listener);
  }
  changeController() {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

describe("noticing a new build", () => {
  it("reports a build that finishes installing while the page is controlled", () => {
    const registration = new FakeRegistration();
    const container = new FakeContainer();
    const onChange = vi.fn();
    watchForUpdate(registration, container, onChange);
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

    it("reloads the page itself after the wait, once, and lets the caller enable the button again", () => {
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

    it("does not time out once the controller changed: the reload is the one of the change", () => {
      vi.useFakeTimers();
      const registration = new FakeRegistration();
      registration.deliver();
      const container = new FakeContainer();
      const reload = vi.fn();
      const onTimeout = vi.fn();
      takeOver(registration, container, reload, onTimeout);
      container.changeController();
      vi.advanceTimersByTime(TAKE_OVER_TIMEOUT_MS * 2);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(onTimeout).not.toHaveBeenCalled();
    });
  });
});

describe("the update store", () => {
  function setup(reads: PendingWork[], sync?: () => Promise<void>) {
    const registration = new FakeRegistration();
    const container = new FakeContainer();
    const reload = vi.fn();
    const store = createUpdateStore({ container, reload });
    const queue = source(reads, sync);
    store.setWorkSource(queue);
    store.attach(registration);
    return { container, queue, registration, reload, store };
  }

  it("shows nothing until a build is waiting, then offers it with the queue's state", async () => {
    const { registration, store } = setup([work({ pending: 2 })]);
    expect(store.getSnapshot().offer).toEqual({ kind: "none" });
    registration.deliver();
    await store.refreshWork();
    expect(store.getSnapshot().offer).toEqual({
      kind: "after_sync",
      pending: 2,
      sending: 0,
    });
  });

  it("applies on request over an empty queue: the worker takes over and the page reloads once", async () => {
    const { container, registration, reload, store } = setup([work()]);
    const worker = registration.deliver();
    await store.refreshWork();
    expect(await store.requestUpdate()).toEqual({ status: "applying" });
    expect(worker.messages).toEqual([{ type: "SKIP_WAITING" }]);
    container.changeController();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["empty", work()],
    ["not empty", work({ pending: 1 })],
  ])(
    "with two tabs: the one that did not ask never reloads when the other applies, with the queue %s",
    async (_name, queued) => {
      const { container, reload, registration, store } = setup([queued]);
      registration.deliver();
      await store.refreshWork();
      container.changeController();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(reload).not.toHaveBeenCalled();
      expect(store.getSnapshot().applying).toBe(false);
    }
  );

  it("a click while another tab already took the worker over reloads and leaves the button usable", async () => {
    const { reload, registration, store } = setup([work()]);
    registration.deliver();
    await store.refreshWork();
    registration.waiting = null; // the other tab activated it between the banner and the click
    expect(await store.requestUpdate()).toEqual({ status: "applying" });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().applying).toBe(false);
  });

  it("when nothing happens after the click the page reloads itself and the button is enabled again", async () => {
    vi.useFakeTimers();
    try {
      const { reload, registration, store } = setup([work()]);
      registration.deliver();
      await store.refreshWork();
      await store.requestUpdate();
      expect(store.getSnapshot().applying).toBe(true);
      vi.advanceTimersByTime(TAKE_OVER_TIMEOUT_MS);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(store.getSnapshot().applying).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("with the network down it neither updates nor loses anything, and says why", async () => {
    const { reload, registration, store } = setup([work({ pending: 2 })], () =>
      Promise.reject(new Error("offline"))
    );
    const worker = registration.deliver();
    await store.refreshWork();
    const outcome = await store.requestUpdate();
    expect(outcome).toEqual({ reason: "sync_failed", status: "deferred" });
    expect(worker.messages).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
    expect(store.getSnapshot().message).toContain("Não foi possível enviar");
    expect(store.getSnapshot().applying).toBe(false);
  });

  it("ignores a request with nothing waiting, and notifies subscribers of changes", async () => {
    const { registration, store } = setup([work()]);
    expect(await store.requestUpdate()).toBeNull();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    registration.deliver();
    await store.refreshWork();
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    listener.mockClear();
    await store.refreshWork();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("the update banner", () => {
  const render = (
    snapshot: Parameters<typeof UpdateBannerView>[0]["snapshot"]
  ) =>
    renderToStaticMarkup(
      <UpdateBannerView onApply={noop} snapshot={snapshot} />
    );
  const base = {
    applying: false,
    message: null,
    work: NO_PENDING_WORK,
  };

  it("renders nothing when there is no update", () => {
    expect(
      render({
        ...base,
        offer: offerFor(false, NO_PENDING_WORK),
        waiting: false,
      })
    ).toBe("");
  });

  it("offers an immediate update on an empty queue", () => {
    const html = render({
      ...base,
      offer: offerFor(true, NO_PENDING_WORK),
      waiting: true,
    });
    expect(html).toContain("Há uma nova versão do Polaris");
    expect(html).toContain("Atualizar agora");
  });

  it("explains that queued work is sent first", () => {
    const html = render({
      ...base,
      offer: offerFor(true, work({ pending: 2 })),
      waiting: true,
      work: work({ pending: 2 }),
    });
    expect(html).toContain("2 operações");
    expect(html).toContain("enviadas primeiro");
    expect(html).toContain("Enviar e atualizar");
  });

  it("has no update button while something is refused, and points to the attention panel", () => {
    const html = render({
      ...base,
      offer: offerFor(true, work({ rejected: 1 })),
      waiting: true,
      work: work({ rejected: 1 }),
    });
    expect(html).toContain("Pendências");
    expect(html).toContain("Nada foi perdido");
    expect(html).not.toContain("<button");
  });

  it("shows why the last attempt waited, and disables the button while applying", () => {
    const html = render({
      applying: true,
      message: "Não foi possível enviar as operações agora.",
      offer: offerFor(true, NO_PENDING_WORK),
      waiting: true,
      work: NO_PENDING_WORK,
    });
    expect(html).toContain("Não foi possível enviar as operações agora.");
    expect(html).toContain('disabled=""');
  });
});
