import type { LocalNamespace } from "../namespace";
import {
  clearOutboxDatabase,
  IndexedDbOutboxStorage,
  outboxDatabaseName,
} from "./indexeddb-storage";
import { Outbox } from "./outbox";

/**
 * The outbox of one user's organization on one device: the durable storage of
 * its namespace plus the rules on top. Several tabs may open it; IndexedDB
 * serializes their transactions. A restart calls `recoverInterrupted()`.
 */
export interface OutboxStore {
  close: () => void;
  outbox: Outbox;
}

class PendingCommandsError extends Error {
  readonly pending: number;

  constructor(pending: number) {
    super("outbox_has_pending_commands");
    this.name = "PendingCommandsError";
    this.pending = pending;
  }
}

export async function openOutboxStore(
  namespace: LocalNamespace,
  deviceId: string
): Promise<OutboxStore> {
  const storage = await IndexedDbOutboxStorage.open(
    outboxDatabaseName(namespace.key)
  );
  return {
    close: () => storage.close(),
    outbox: new Outbox({
      deviceId,
      organizationId: namespace.organizationId,
      storage,
      userId: namespace.userId,
    }),
  };
}

/**
 * Empties the outbox of a namespace (logout, leaving an organization). It never
 * discards queued commands silently: with any left it throws
 * `PendingCommandsError` unless the caller passes the explicit discard flag the
 * person chose in the interface. Counting and clearing are one IndexedDB
 * transaction, so a command another tab queues lands either before it (and is
 * counted) or after it (and stays); the database is never deleted.
 */
export async function wipeOutboxStore(
  namespace: LocalNamespace,
  options: { discardPending: boolean }
): Promise<{ discarded: number }> {
  const discarded = await clearOutboxDatabase(
    outboxDatabaseName(namespace.key),
    (pending) => {
      if (pending > 0 && !options.discardPending) {
        throw new PendingCommandsError(pending);
      }
    }
  );
  return { discarded };
}
