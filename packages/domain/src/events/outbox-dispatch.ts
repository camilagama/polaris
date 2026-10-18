import { QUEUE_ENVELOPE_MAX_ATTEMPT } from "./queue-envelope";

/**
 * The rules of the outbox dispatcher (plan PR110, ADR 0084): how many events one run takes, how long it
 * holds them while it sends, when a failed send is tried again and when an event stops being tried.
 * The database functions that claim, mark and release the events check the same bounds.
 *
 * Delivery is at least once: an event is marked dispatched only after the queue accepted it, so a run
 * that dies between the two sends it again later (a duplicate the consumer absorbs).
 */

/** The most events one run claims: one `sendBatch` per queue holds up to 100, and the cron has 10 ms of CPU on the Free plan. */
export const OUTBOX_DISPATCH_BATCH = 25;

/**
 * How long a claim holds an event while the run sends it. A cron invocation lasts at most 15 minutes
 * of wall time, so a claim older than that belongs to a run that is gone: the next run takes the event
 * again (the sweep), and the event may arrive twice.
 */
export const OUTBOX_DISPATCH_LEASE_SECONDS = 960;

/**
 * Past this many claims the event is no longer taken (it waits for the dead-letter handling of PR111):
 * the queue envelope counts at most this many attempts.
 */
export const OUTBOX_MAX_DISPATCH_ATTEMPTS = QUEUE_ENVELOPE_MAX_ATTEMPT;

const BASE_DELAY_SECONDS = 30;
const MAX_DELAY_SECONDS = 3600;

/** When a failed send is tried again: thirty seconds doubling with each claim, at most an hour. */
export function outboxRetryDelaySeconds(attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts, 16) - 1);
  return Math.min(BASE_DELAY_SECONDS * 2 ** exponent, MAX_DELAY_SECONDS);
}

/** An event that cannot be sent by this deploy (a type it does not know, a body it refuses) waits the longest. */
export const OUTBOX_UNSENDABLE_DELAY_SECONDS = MAX_DELAY_SECONDS;
