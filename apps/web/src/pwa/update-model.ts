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
 * And never a build published less than `SETTLE_MS` ago: a bad build stops reaching everyone in the same minute. The
 * time is the one the build carries (the commit's), less `CLOCK_TOLERANCE_MS` for a device clock ahead; with no time
 * in the build, or one in the device's future (a clock behind), the age counts from when this page first saw it.
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

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

export const SETTLE_MS = 2 * HOUR;
export const CLOCK_TOLERANCE_MS = 10 * MINUTE;
export const RETURN_AFTER_MS = 5 * MINUTE;
export const RETURN_WINDOW_MS = 30 * 1000;
export const IDLE_MS = 15 * MINUTE;
export const IDLE_WAITING_MS = 24 * HOUR;

export type SwapMoment = "hidden" | "idle" | "return";

/** How long the build has been out, as far as this device can tell (see above). */
export function waitedFor(
  publishedAt: number | null,
  firstSeenAt: number,
  now: number
): number {
  if (publishedAt !== null && publishedAt <= now + CLOCK_TOLERANCE_MS) {
    return now - publishedAt - CLOCK_TOLERANCE_MS;
  }
  return now - firstSeenAt;
}

/** Whether a build that has waited this long may go in at this moment (the page's guard comes after). */
export function momentAllows(moment: SwapMoment, waited: number): boolean {
  if (waited < SETTLE_MS) {
    return false;
  }
  return moment !== "idle" || waited > IDLE_WAITING_MS;
}
