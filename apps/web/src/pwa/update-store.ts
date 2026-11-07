import type { BuildInfo } from "./sw";
import { type SwapState, swapIsSafe } from "./swap-guard";
import {
  askBuildInfo,
  type ContainerLike,
  type RegistrationLike,
  takeOver,
  type WorkerLike,
  watchForUpdate,
} from "./update-controller";
import {
  idleWorkSource,
  momentAllows,
  NO_PENDING_WORK,
  type PendingWork,
  type PendingWorkSource,
  type SwapMoment,
} from "./update-model";

/**
 * The state of the update cycle of this page (ADR 0041): which build it runs, whether a newer
 * one waits for it, and the swap, which the page does by itself at a safe moment (`trySwap`). A small external store
 * so React reads it with `useSyncExternalStore` (the line of Configurações) and tests drive it without a browser.
 *
 * A build waits for this page in two ways: `waiting`, a worker installed and not active yet; or `stale`, another tab
 * made it active (the `controllerchange` this page got was not its own) and this page still runs the old build, whose
 * files the new worker serves from the caches kept (`sw.ts`). Either way this page swaps at its own moment, never at
 * another tab's. A waiting build with the same content as this page's (the same id and the same worker code: a new
 * commit, the same files) is taken at once and without a reload: nothing on the page changes.
 */
export interface PendingBuild {
  /** What the worker said of its build; null when it did not answer. */
  build: BuildInfo | null;
  /**
   * When this device first saw it: the time its worker wrote at install (`seenAt`), or, without one or with one in the
   * device's future (a clock set back since), when this page first saw it. The settling and the 24 h count from here.
   */
  firstSeenAt: number;
  kind: "stale" | "waiting";
  /**
   * Skips the settling and the 24 h: the build is urgent, or it took the place of an urgent one still waiting (a
   * normal commit published on top of a revert must not leave the device on the bad build for 2 h). The inheritance
   * ends at the first swap on the device: once an urgent build is active, this page reloads into it and the next
   * build waits its own settling.
   */
  urgent: boolean;
}

export interface UpdateSnapshot {
  /** The build this page runs, as its worker said when the page opened; null without an answer. */
  current: BuildInfo | null;
  pending: PendingBuild | null;
  swapping: boolean;
  work: PendingWork;
}

export interface UpdateStore {
  /** A registration to watch for new builds. */
  attach: (registration: RegistrationLike) => Promise<void>;
  getSnapshot: () => UpdateSnapshot;
  /** Re-reads the queue (the owner of the outbox calls this when it changes). */
  refreshWork: () => Promise<void>;
  setWorkSource: (source: PendingWorkSource) => void;
  subscribe: (listener: () => void) => () => void;
  /**
   * A moment came: swaps when the build waited long enough for it and the page holds nothing. `lasts` says whether
   * the moment still holds (the tab still hidden...): asked again right before the reload.
   */
  trySwap: (moment: SwapMoment, lasts?: () => boolean) => Promise<boolean>;
}

export interface UpdateStoreOptions {
  /** Which build a worker serves (`BUILD_INFO`). */
  buildInfoOf?: (
    worker: Pick<WorkerLike, "postMessage"> | null
  ) => Promise<BuildInfo | null>;
  container: ContainerLike;
  /** Runs right before the reload of a swap (the idle swap keeps the scroll). */
  keepScreen?: (moment: SwapMoment) => void;
  now?: () => number;
  /** What the page holds now, with the queue just read (`swap-guard.ts`). */
  readGuard: (work: PendingWork) => SwapState;
  reload: () => void;
  /** Where the queue is read until the offline runtime hands its own (`setWorkSource`). */
  workSource?: PendingWorkSource;
}

export function createUpdateStore({
  buildInfoOf = askBuildInfo,
  container,
  keepScreen = () => undefined,
  now = Date.now,
  readGuard,
  reload,
  workSource = idleWorkSource,
}: UpdateStoreOptions): UpdateStore {
  let registration: RegistrationLike | null = null;
  let source = workSource;
  let snapshot: UpdateSnapshot = {
    current: null,
    pending: null,
    swapping: false,
    work: NO_PENDING_WORK,
  };
  const listeners = new Set<() => void>();

  function set(next: Partial<UpdateSnapshot>) {
    const merged = { ...snapshot, ...next };
    if (
      (Object.keys(next) as (keyof UpdateSnapshot)[]).every(
        (key) => merged[key] === snapshot[key]
      )
    ) {
      return;
    }
    snapshot = merged;
    for (const listener of listeners) {
      listener();
    }
  }
  async function readWork(): Promise<PendingWork | null> {
    try {
      const work = await source.read();
      const same =
        work.pending === snapshot.work.pending &&
        work.rejected === snapshot.work.rejected &&
        work.sending === snapshot.work.sending;
      set({ work: same ? snapshot.work : work });
      return work;
    } catch {
      // the queue could not be read: never claim it is empty
      return null;
    }
  }
  /** The same files and the same worker: a worker whose code changed is a build like any other. */
  const sameContent = (build: BuildInfo | null) =>
    build !== null &&
    build.workerId !== null &&
    snapshot.current?.id === build.id &&
    snapshot.current.workerId === build.workerId;
  const firstSeenOf = (build: BuildInfo | null) => {
    const at = now();
    const seenAt = build?.seenAt ?? null;
    if (seenAt !== null && seenAt <= at) {
      return seenAt;
    }
    const known = snapshot.pending;
    return known &&
      build &&
      known.build?.id === build.id &&
      known.build.workerId === build.workerId
      ? known.firstSeenAt
      : at;
  };

  async function onWaiting(current: RegistrationLike) {
    const worker = current.waiting;
    if (!worker || snapshot.swapping) {
      return;
    }
    const build = await buildInfoOf(worker);
    if (sameContent(build)) {
      // a new worker for the same files: it takes over now, and this page (and every other) keeps running as it is
      worker.postMessage({ type: "SKIP_WAITING" });
      return;
    }
    const known = snapshot.pending;
    if (known?.kind === "stale" && known.urgent && build?.urgent !== true) {
      // the urgent build already went in on this device and this page still runs the one it replaced: the page loads
      // the active build at its first safe moment, and this one waits its own settling from the next page
      return;
    }
    set({
      pending: {
        build,
        firstSeenAt: firstSeenOf(build),
        kind: "waiting",
        urgent: build?.urgent === true || known?.urgent === true,
      },
    });
    await readWork();
  }

  async function onControllerChange() {
    if (snapshot.swapping) {
      return;
    }
    const build = await buildInfoOf(container.controller);
    if (sameContent(build)) {
      return;
    }
    // another tab made a build active (or this page's own reload was held); this page still runs its own and swaps at
    // its own moment, as urgently as it waited: loading the build already active hurries no build on the device
    set({
      pending: {
        build,
        firstSeenAt: firstSeenOf(build),
        kind: "stale",
        urgent: build?.urgent === true || snapshot.pending?.urgent === true,
      },
    });
  }

  /**
   * The reload of a swap, if the moment still lasts and nothing came up in the page meanwhile: the worker may take
   * seconds to take over (longer on a phone that froze the hidden tab), so the queue is read again and the moment
   * asked again. Otherwise this page is left on its build, which the new worker serves, for the next moment.
   */
  async function reloadIfStillSafe(moment: SwapMoment, lasts: () => boolean) {
    const work = await readWork();
    if (work === null || !lasts() || !swapIsSafe(readGuard(work))) {
      set({ swapping: false });
      await onControllerChange();
      return;
    }
    keepScreen(moment);
    reload();
  }

  return {
    async attach(next) {
      registration = next;
      set({ current: await buildInfoOf(container.controller) });
      container.addEventListener("controllerchange", () => {
        onControllerChange().catch(() => undefined);
      });
      watchForUpdate(next, container, () => {
        onWaiting(next).catch(() => undefined);
      });
    },
    getSnapshot: () => snapshot,
    async refreshWork() {
      await readWork();
    },
    setWorkSource(next) {
      source = next;
      readWork().catch(() => undefined);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async trySwap(moment, lasts = () => true) {
      const { pending } = snapshot;
      if (!pending || snapshot.swapping) {
        return false;
      }
      const waited = now() - pending.firstSeenAt;
      if (!momentAllows(moment, waited, pending.urgent)) {
        return false;
      }
      const work = await readWork();
      // the guard is read after the queue: what the page holds now, not before the wait
      if (
        work === null ||
        snapshot.swapping ||
        snapshot.pending !== pending ||
        !lasts() ||
        !swapIsSafe(readGuard(work))
      ) {
        return false;
      }
      set({ swapping: true });
      const current = registration;
      const reloadNow = () => {
        reloadIfStillSafe(moment, lasts).catch(() => undefined);
      };
      if (
        pending.kind === "waiting" &&
        current &&
        takeOver(current, container, reloadNow)
      ) {
        return true;
      }
      // the build is already active (another tab took it over): loading the page is the swap
      reloadNow();
      return true;
    },
  };
}
