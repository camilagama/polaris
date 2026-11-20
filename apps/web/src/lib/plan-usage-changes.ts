/**
 * The writes that change what the plan counts (products, variants, images) or the plan itself, `sync/push` included
 * (a product made offline reaches the server through it). The procedures are spelled out: a new write that changes the
 * use shows up here, in review, and `plan-usage-changes.test.ts` keeps the list equal to the contract's writes of those
 * groups, each one either here or in the exclusions.
 */
export const PLAN_USAGE_WRITES: readonly string[] = [
  "billing/cancelRenewal",
  "billing/openOverduePayment",
  "billing/requestRefund",
  "billing/startCheckout",
  "plan/selectOperationalVariants",
  "product/archive",
  "product/configureVariants",
  "product/create",
  "product/delete",
  "product/importBatch",
  "product/restore",
  "product/update",
  "sync/push",
];

/** Writes of the same groups that never change a count or the plan: a price and a SKU of a variant that exists. */
export const PLAN_USAGE_NEUTRAL_WRITES: readonly string[] = [
  "product/setVariantListPrice",
  "product/setVariantSku",
];

const usageWrites = new Set(PLAN_USAGE_WRITES);
const listeners = new Set<() => void>();

export function writeChangesPlanUsage(path: readonly string[]): boolean {
  return usageWrites.has(path.join("/"));
}

/** Something that the plan counts, or the plan, may have changed: whoever keeps a reading of it lets it go. */
export function notifyPlanUsageChanged(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribePlanUsageChanges(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Runs a write that changes the use, then tells the readers, whether it answered or failed: a write that failed on the
 * way back may have been applied, and a number kept from before it must not outlive it.
 */
export async function trackPlanUsageWrite<T>(
  call: () => Promise<T>
): Promise<T> {
  try {
    return await call();
  } finally {
    notifyPlanUsageChanged();
  }
}
