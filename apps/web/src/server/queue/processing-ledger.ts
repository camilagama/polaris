/**
 * The consumer's record of what it processed (plans PR109 and PR110, ADRs 0083 and 0084), by the
 * organization and idempotency key of the envelope, with the event's ID and the dispatch attempt: a
 * duplicate delivery of an attempt already done (the queue delivers at least once, and the dispatcher
 * may send an event twice) finds it done and does nothing; a later attempt (an event the dispatcher sent
 * again because its work is still owed) runs again. The same key under another event ID is refused.
 *
 * A claim has a lease, so a consumer that died holding one does not block the key for good. The
 * durable adapter keeps the record in PostgreSQL, behind the functions of the outbox role, which also
 * refuse an event the outbox does not hold; the in-memory one serves tests, local development and an
 * environment without that role. Either way, each handler stays idempotent by itself: "done" here is
 * "the handler ran for this attempt", never proof of its effect (that is the state in the database).
 */

/** Which event a message says it carries. */
export interface ProcessingKey {
  /** The dispatch attempt (from 1), counted by the dispatcher. */
  attempt: number;
  eventId: string;
  idempotencyKey: string;
  organizationId: string;
  type: string;
}

/** Why a message is refused, for the log of the drop (no data of the message). */
type UnknownReason = "event_not_held" | "key_of_another_event";

type ClaimResult =
  | { result: "busy" }
  | { result: "done" }
  /** Not an event the record accepts: another event under the same key, or (durable) one the outbox does not hold. */
  | { reason: UnknownReason; result: "unknown" }
  /** The token proves who holds the claim: only the holder gives it back. */
  | { result: "claimed"; token: string };

export interface ProcessingLedger {
  /** Takes the key if nobody has it (or the lease of the one who had it ended); says if this attempt is already done. */
  claim: (key: ProcessingKey, leaseSeconds: number) => Promise<ClaimResult>;
  /** Records the attempt as processed for good (the work is done, whoever holds the claim now). */
  complete: (key: ProcessingKey) => Promise<void>;
  /** Gives the key back after a failure, so a retry can take it; does nothing if the claim is no longer the holder's. */
  release: (key: ProcessingKey, token: string) => Promise<void>;
}

/** The most keys the in-memory adapter keeps: the oldest go first, so it never grows without bound. */
const MAX_REMEMBERED_KEYS = 2000;

interface Entry {
  attempt: number;
  eventId: string;
  leaseUntil: number;
  state: "claimed" | "done";
  token: string;
}

const keyOf = (key: ProcessingKey) =>
  `${key.organizationId}:${key.idempotencyKey}`;

/** A ledger in memory: one per isolate, lost with it. */
export function createInMemoryProcessingLedger(
  now: () => number = Date.now
): ProcessingLedger {
  const entries = new Map<string, Entry>();
  let sequence = 0;
  const remember = (key: string, entry: Entry) => {
    // re-inserting moves the key to the end of the order
    entries.delete(key);
    entries.set(key, entry);
    if (entries.size > MAX_REMEMBERED_KEYS) {
      // the oldest key that is done: a claim in progress is not forgotten while it runs
      for (const [oldest, candidate] of entries) {
        if (candidate.state === "done") {
          entries.delete(oldest);
          break;
        }
      }
    }
  };
  return {
    claim(key, leaseSeconds) {
      const id = keyOf(key);
      const current = entries.get(id);
      if (current && current.eventId !== key.eventId) {
        return Promise.resolve({
          reason: "key_of_another_event",
          result: "unknown",
        });
      }
      if (current?.state === "done" && current.attempt >= key.attempt) {
        return Promise.resolve({ result: "done" });
      }
      if (current?.state === "claimed" && current.leaseUntil > now()) {
        return Promise.resolve({ result: "busy" });
      }
      sequence += 1;
      const token = String(sequence);
      remember(id, {
        attempt: Math.max(current?.attempt ?? 0, key.attempt),
        eventId: key.eventId,
        leaseUntil: now() + leaseSeconds * 1000,
        state: "claimed",
        token,
      });
      return Promise.resolve({ result: "claimed", token });
    },
    complete(key) {
      const id = keyOf(key);
      const current = entries.get(id);
      if (current && current.eventId !== key.eventId) {
        return Promise.resolve();
      }
      remember(id, {
        attempt: Math.max(current?.attempt ?? 0, key.attempt),
        eventId: key.eventId,
        leaseUntil: 0,
        state: "done",
        token: "",
      });
      return Promise.resolve();
    },
    release(key, token) {
      const id = keyOf(key);
      const current = entries.get(id);
      if (current?.state === "claimed" && current.token === token) {
        entries.delete(id);
      }
      return Promise.resolve();
    },
  };
}

/** What the durable adapter needs of the database client (`@polaris/db/outbox-dispatch`). */
export interface ProcessingStore {
  claimProcessing: (
    key: ProcessingKey,
    leaseSeconds: number
  ) => Promise<ClaimResult>;
  completeProcessing: (key: ProcessingKey) => Promise<void>;
  releaseProcessing: (key: ProcessingKey, token: string) => Promise<void>;
}

/** The ledger in PostgreSQL: shared by every isolate and deploy, and it checks the event against the outbox. */
export function createDurableProcessingLedger(
  store: ProcessingStore
): ProcessingLedger {
  return {
    claim: (key, leaseSeconds) => store.claimProcessing(key, leaseSeconds),
    complete: (key) => store.completeProcessing(key),
    release: (key, token) => store.releaseProcessing(key, token),
  };
}
