import { wipeLocalStore } from "./local-store";
import type { LocalNamespace } from "./namespace";
import { wipeOutboxStore } from "./outbox/outbox-store";

/**
 * Removes everything this device keeps for one user's organization (plan PR59):
 * the outbox, with the signed leases in it, and the local collections. The
 * outbox goes first and refuses to drop queued commands unless the person chose
 * to discard them, so a refusal leaves the local collections in place. The caller
 * closes any open stores of the namespace before calling.
 */
export async function purgeNamespace(
  namespace: LocalNamespace,
  options: { discardPending: boolean }
): Promise<void> {
  await wipeOutboxStore(namespace, options);
  await wipeLocalStore(namespace);
}
