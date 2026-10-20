import { createBillingStore } from "@polaris/db/billing-store";
import {
  billingProviderHandled,
  checkoutOpen,
  type RenewalCancellationStatus,
  renewalCancellationStatus,
} from "@polaris/domain/billing/renewal-cancellation";
import { logger } from "@polaris/observability/logger";
import { describeError } from "@polaris/observability/wide-event";
import type { WorkerBindings } from "../environment";

/**
 * What the panel of a closed organization says about its renewal (ADR 0074,
 * L4): derived on the server from the billing record, never a setting of the
 * screen, so it never promises a cancellation that does not exist. The caller
 * has already proved the session user owns these organizations (the closed
 * status functions); this reads only their billing records, on the billing role.
 * A record that cannot be read now is `null` (unknown), never a guess: the
 * panel, where the owner also undoes the closure and asks for the copy, still
 * opens.
 */
export type RenewalStatusReader = (
  bindings: WorkerBindings,
  organizationIds: readonly string[]
) => Promise<ReadonlyMap<string, RenewalCancellationStatus | null>>;

export function createRenewalStatusReader(
  createStore: typeof createBillingStore = createBillingStore
): RenewalStatusReader {
  return async (bindings, organizationIds) => {
    const statuses = new Map<string, RenewalCancellationStatus | null>();
    if (organizationIds.length === 0) {
      return statuses;
    }
    const connectionString = bindings.BILLING_HYPERDRIVE?.connectionString;
    if (!connectionString) {
      // billing is not provisioned here: no subscription Polaris could cancel
      for (const id of organizationIds) {
        statuses.set(id, "not_handled");
      }
      return statuses;
    }
    let store: ReturnType<typeof createBillingStore> | null = null;
    try {
      store = createStore(connectionString);
      for (const id of organizationIds) {
        // biome-ignore lint/performance/noAwaitInLoops: Two organizations at most (one open, two closed per person).
        const [record, link] = await Promise.all([
          store.readRecord(id),
          store.readProviderLink(id),
        ]);
        // a checkout still open is pending until the closure gives it up (the ledger says when)
        const discarded =
          link && checkoutOpen(record, link, false)
            ? await store.checkoutDiscarded(id, link)
            : false;
        statuses.set(
          id,
          renewalCancellationStatus(
            record,
            link,
            billingProviderHandled,
            discarded
          )
        );
      }
    } catch (error: unknown) {
      logger.warn("billing_renewal_status_unavailable", {
        ...describeError(error),
      });
      for (const id of organizationIds) {
        statuses.set(id, null);
      }
    } finally {
      await store?.close().catch(() => undefined);
    }
    return statuses;
  };
}
