import type { LocalNamespace } from "../namespace";
import {
  deleteOutboxDatabase,
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
 * Deletes the outbox of a namespace (logout, leaving an organization). It never
 * discards queued commands silently: with any left it throws
 * `PendingCommandsError` unless the caller passes the explicit discard flag the
 * person chose in the interface.
 */
export async function wipeOutboxStore(
  namespace: LocalNamespace,
  options: { discardPending: boolean }
): Promise<{ discarded: number }> {
  const name = outboxDatabaseName(namespace.key);
  const storage = await IndexedDbOutboxStorage.open(name);
  let pending = 0;
  try {
    pending = (await storage.transaction((tx) => tx.all())).length;
    if (pending > 0 && !options.discardPending) {
      throw new PendingCommandsError(pending);
    }
  } finally {
    storage.close();
  }
  await deleteOutboxDatabase(name);
  return { discarded: pending };
}
