/**
 * The consumer's record of what it processed (plan PR109, ADR 0083), by the idempotency key of the
 * envelope: a duplicate delivery (the queue delivers at least once, and the dispatcher of PR110 may
 * send an event twice) finds the key done and does nothing.
 *
 * A claim has a lease, so a consumer that died holding one does not block the key for good. The
 * durable adapter (a table in PostgreSQL, under its own role) arrives with the dispatcher of PR110,
 * which creates the role it needs; until then the in-memory adapter below serves, and each handler
 * stays idempotent by itself (the data export claims its request in the database).
 */
type ClaimResult =
  | { result: "busy" }
  | { result: "done" }
  /** The token proves who holds the claim: only the holder gives it back. */
  | { result: "claimed"; token: string };

export interface ProcessingLedger {
  /** Takes the key if nobody has it (or the lease of the one who had it ended); says if it is already done. */
  claim: (key: string, leaseSeconds: number) => Promise<ClaimResult>;
  /** Records the key as processed for good (the work is done, whoever holds the claim now). */
  complete: (key: string) => Promise<void>;
  /** Gives the key back after a failure, so a retry can take it; does nothing if the claim is no longer the holder's. */
  release: (key: string, token: string) => Promise<void>;
}

/** The most keys the in-memory adapter keeps: the oldest go first, so it never grows without bound. */
const MAX_REMEMBERED_KEYS = 2000;

interface Entry {
  leaseUntil: number;
  state: "claimed" | "done";
  token: string;
}

/** A ledger in memory: one per isolate, lost with it. It serves tests, local development and the time before PR110. */
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
      const current = entries.get(key);
      if (current?.state === "done") {
        return Promise.resolve({ result: "done" });
      }
      if (current && current.leaseUntil > now()) {
        return Promise.resolve({ result: "busy" });
      }
      sequence += 1;
      const token = String(sequence);
      remember(key, {
        leaseUntil: now() + leaseSeconds * 1000,
        state: "claimed",
        token,
      });
      return Promise.resolve({ result: "claimed", token });
    },
    complete(key) {
      remember(key, { leaseUntil: 0, state: "done", token: "" });
      return Promise.resolve();
    },
    release(key, token) {
      const current = entries.get(key);
      if (current?.state === "claimed" && current.token === token) {
        entries.delete(key);
      }
      return Promise.resolve();
    },
  };
}
