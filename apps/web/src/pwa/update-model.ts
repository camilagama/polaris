/**
 * When a new build of the app goes in (ADR 0041): by itself, with nobody asked, at a moment
 * when nobody is looking and nothing on the page would be lost (`swap-guard.ts`). The moments:
 *
 * - `hidden`: the tab went to the background;
 * - `return`: the tab came back after `RETURN_AFTER_MS` or more away, before the first touch, key or scroll, and
 *   within `RETURN_WINDOW_MS` (the time to find and install a build published while away);
 * - `idle`: the tab is in front with no touch, key or scroll for `IDLE_MS`, and the build has waited more than
 *   `IDLE_WAITING_MS` (the counter computer that is never hidden); the screen comes back where it was.
 *
 * And never a build this device saw less than `SETTLE_MS` ago: a bad build goes in only 2 h after it reached a
 * device, which gives the time to revert it. Both the settling and the `IDLE_WAITING_MS` count from when the device
 * first saw the build (the install of its worker, `sw.ts`), never from when it was published: a build promoted hours
 * after its commit is new to the device all the same. An urgent build (`POLARIS_SWAP_URGENT=1`: a revert, a security
 * fix) skips both and goes in at the first safe moment; the page's guard still holds it over work. A normal build that
 * takes the place of an urgent one still waiting inherits it, until the first swap the page sees (`update-store.ts`).
 * The clock is the device's: one moved ahead while the build waits shortens the settling, with no bound (ADR 0041).
 */
export interface PendingWork {
  pending: number;
  rejected: number;
  sending: number;
}

export const NO_PENDING_WORK: PendingWork = {
  pending: 0,
  rejected: 0,
  sending: 0,
};

/** Where the app reads its queued work; the offline runtime plugs in here. */
export interface PendingWorkSource {
  read: () => Promise<PendingWork>;
  /** Sends the queue; rejects when it cannot (no network). The automatic swap never calls it: it only reads. */
  sync: () => Promise<void>;
}

export const idleWorkSource: PendingWorkSource = {
  read: () => Promise.resolve(NO_PENDING_WORK),
  sync: () => Promise.resolve(),
};

/**
 * The queue before the offline runtime hands its own: with the runtime off there is no queue, so it is empty; with
 * it on, a queue may sit on the device (the login screen, a runtime still opening), so it cannot be read.
 */
export function workSourceBeforeRuntime(
  offlineRuntimeEnabled: boolean
): PendingWorkSource {
  return offlineRuntimeEnabled
    ? {
        read: () => Promise.reject(new Error("queue_not_attached")),
        sync: () => Promise.reject(new Error("queue_not_attached")),
      }
    : idleWorkSource;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

export const SETTLE_MS = 2 * HOUR;
export const RETURN_AFTER_MS = 5 * MINUTE;
export const RETURN_WINDOW_MS = 30 * 1000;
export const IDLE_MS = 15 * MINUTE;
export const IDLE_WAITING_MS = 24 * HOUR;

export type SwapMoment = "hidden" | "idle" | "return";

/**
 * Whether a build that has waited this long since the device saw it may go in at this moment (the page's guard comes
 * after); an urgent one at any moment.
 */
export function momentAllows(
  moment: SwapMoment,
  waited: number,
  urgent = false
): boolean {
  if (urgent) {
    return true;
  }
  if (waited < SETTLE_MS) {
    return false;
  }
  return moment !== "idle" || waited > IDLE_WAITING_MS;
}
