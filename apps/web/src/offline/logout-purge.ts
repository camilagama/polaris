import { wipeLocalStore } from "./local-store";
import type { LocalNamespace } from "./namespace";
import { wipeOutboxStore } from "./outbox/outbox-store";
import { wipeThumbnails } from "./thumbnail-store";

/**
 * Empties everything this device keeps for one user's organization (plan PR59):
 * the outbox, with the signed leases in it (the empty database stays), the
 * thumbnails and the local collections. The
 * outbox goes first and refuses to drop queued commands unless the person chose
 * to discard them, so a refusal leaves the local collections in place. The caller
 * closes any open stores of the namespace before calling.
 */
export async function purgeNamespace(
  namespace: LocalNamespace,
  options: { discardPending: boolean }
): Promise<void> {
  await wipeOutboxStore(namespace, options);
  await wipeNamespaceCollections(namespace);
}

/**
 * The copy of the store without its queue: the local collections and the thumbnails shown from them. What the
 * runtime drops when it must keep a queue it cannot send (the access revoked with commands still queued). Both are
 * tried, and a failure of either is thrown only after both settled: a thumbnails database that will not go never
 * keeps the collections on the disk, nor the other way around.
 */
export async function wipeNamespaceCollections(
  namespace: LocalNamespace
): Promise<void> {
  const [collections, thumbnails] = await Promise.allSettled([
    wipeLocalStore(namespace),
    wipeThumbnails(namespace.key),
  ]);
  for (const result of [collections, thumbnails]) {
    if (result.status === "rejected") {
      throw result.reason;
    }
  }
}
