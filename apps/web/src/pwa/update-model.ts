/**
 * What to do when a new build of the app is waiting (plan PR61). An update swaps
 * the files under the running app, and the commands in the outbox were made by
 * the version that is running. So the rule is: never swap while work is queued.
 *
 * - nothing waiting: nothing to offer;
 * - waiting, queue empty: the person can update now (never automatically);
 * - waiting, work queued and nothing refused: send first, then update, and only
 *   if the queue really ended up empty;
 * - waiting, something refused: the update is deferred until the person has
 *   resolved it (it blocks the queue, so the queue cannot be emptied).
 *
 * There is no way to update over queued work: the durable queue would survive a
 * reload, but a new version may read its commands differently, and the
 * update can always wait one more day.
 */
export interface PendingWork {
  pending: number;
  rejected: number;
  sending: number;
}

export type UpdateOffer =
  | { kind: "after_sync"; pending: number; sending: number }
  | { kind: "deferred"; rejected: number; total: number }
  | { kind: "none" }
  | { kind: "ready" };

export const NO_PENDING_WORK: PendingWork = {
  pending: 0,
  rejected: 0,
  sending: 0,
};

export function offerFor(
  updateWaiting: boolean,
  work: PendingWork
): UpdateOffer {
  if (!updateWaiting) {
    return { kind: "none" };
  }
  const total = work.pending + work.sending + work.rejected;
  if (total === 0) {
    return { kind: "ready" };
  }
  if (work.rejected > 0) {
    return { kind: "deferred", rejected: work.rejected, total };
  }
  return { kind: "after_sync", pending: work.pending, sending: work.sending };
}

/** Where the app reads its queued work and sends it; the offline runtime plugs in here. */
export interface PendingWorkSource {
  read: () => Promise<PendingWork>;
  /** Sends the queue; rejects when it cannot (no network). */
  sync: () => Promise<void>;
}

export const idleWorkSource: PendingWorkSource = {
  read: () => Promise.resolve(NO_PENDING_WORK),
  sync: () => Promise.resolve(),
};

export type ApplyOutcome =
  | { status: "applying" }
  | { reason: "queue_not_empty" | "sync_failed"; status: "deferred" };

/**
 * The person asked to update. Sends first when work is queued, re-reads the queue
 * and applies only when it is empty; otherwise the update stays deferred.
 */
export async function applyWhenSafe(
  source: PendingWorkSource,
  apply: () => Promise<void> | void
): Promise<ApplyOutcome> {
  let work = await source.read();
  if (work.pending + work.sending + work.rejected > 0) {
    if (work.rejected > 0) {
      return { reason: "queue_not_empty", status: "deferred" };
    }
    try {
      await source.sync();
    } catch {
      return { reason: "sync_failed", status: "deferred" };
    }
    work = await source.read();
    if (work.pending + work.sending + work.rejected > 0) {
      return { reason: "queue_not_empty", status: "deferred" };
    }
  }
  await apply();
  return { status: "applying" };
}
