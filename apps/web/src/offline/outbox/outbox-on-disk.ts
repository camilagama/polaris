import { outboxDatabaseName } from "./indexeddb-storage";

const OUTBOX_DATABASE_PREFIX = outboxDatabaseName("");

/** Whether this browser keeps any queue at all, whoever's store it is. */
export async function anyOutboxOnDisk(): Promise<boolean> {
  const databases = await indexedDB.databases();
  return databases.some(({ name }) => name?.startsWith(OUTBOX_DATABASE_PREFIX));
}
