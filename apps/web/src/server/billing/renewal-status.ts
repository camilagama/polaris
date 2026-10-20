import { createBillingStore } from "@polaris/db/billing-store";
import {
  type RenewalCancellationStatus,
  renewalCancellationStatus,
} from "@polaris/domain/billing/renewal-cancellation";
import type { WorkerBindings } from "../environment";
import { billingProviderHandled } from "./provider-ports";

/**
 * What the panel of a closed organization says about its renewal (ADR 0074,
 * L4): derived on the server from the billing record, never a setting of the
 * screen, so it never promises a cancellation that does not exist. The caller
 * has already proved the session user owns these organizations (the closed
 * status functions); this reads only their billing records, on the billing role.
 */
export type RenewalStatusReader = (
  bindings: WorkerBindings,
  organizationIds: readonly string[]
) => Promise<ReadonlyMap<string, RenewalCancellationStatus>>;

export function createRenewalStatusReader(
  createStore: typeof createBillingStore = createBillingStore
): RenewalStatusReader {
  return async (bindings, organizationIds) => {
    const statuses = new Map<string, RenewalCancellationStatus>();
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
    const store = createStore(connectionString);
    try {
      for (const id of organizationIds) {
        // biome-ignore lint/performance/noAwaitInLoops: Two organizations at most (one open, two closed per person).
        const [record, link] = await Promise.all([
          store.readRecord(id),
          store.readProviderLink(id),
        ]);
        statuses.set(
          id,
          renewalCancellationStatus(record, link, billingProviderHandled)
        );
      }
      return statuses;
    } finally {
      await store.close().catch(() => undefined);
    }
  };
}
