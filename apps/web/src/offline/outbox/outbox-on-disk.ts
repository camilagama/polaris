import { countOutboxCommands, outboxDatabaseName } from "./indexeddb-storage";

const OUTBOX_DATABASE_PREFIX = outboxDatabaseName("");

/**
 * Whether this browser keeps any queued command at all, whoever's store it is.
 * An emptied outbox stays on the disk as an empty database, so the names alone
 * say nothing; counting never creates a database.
 */
export async function anyOutboxOnDisk(): Promise<boolean> {
  const names = (await indexedDB.databases())
    .map(({ name }) => name ?? "")
    .filter((name) => name.startsWith(OUTBOX_DATABASE_PREFIX));
  for (const name of names) {
    // biome-ignore lint/performance/noAwaitInLoops: stops at the first queue found
    if ((await countOutboxCommands(name)) > 0) {
      return true;
    }
  }
  return false;
}
