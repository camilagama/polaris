/**
 * The writes that change what the plan counts (products, variants, images) or the plan itself. The procedures are
 * spelled out: a new write that changes the use shows up here, in review, and `plan-usage-changes.test.ts` keeps the
 * list equal to the contract's writes of those groups, each one either here or in the exclusions.
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
];

/** Writes of the same groups that change neither what the plan limits nor the plan: a price and a SKU of a variant that exists. */
export const PLAN_USAGE_NEUTRAL_WRITES: readonly string[] = [
  "product/setVariantListPrice",
  "product/setVariantSku",
];

/**
 * `sync/push` carries a product made offline, so it changes the use, but a batch of only sales, stock and customers does
 * not: the decision is in `syncBatchChangesPlanUsage`, by the types the batch carries.
 */
export const PLAN_USAGE_CONDITIONAL_WRITES: readonly string[] = ["sync/push"];

/**
 * The offline command types that never change what the plan limits (products, variants, images). They can still change
 * other figures of `billing/readPlan`: `stock.*` and `sale.confirm` move the balance, so `usage.freeable` (archived
 * products with no stock); `sale.confirm` also moves `kept.sales` and `kept.historyMonths`. Those wait for the TTL of
 * the reading. Any other type, one not listed here included, lets go of the reading: a command that changes variants
 * or images must never be missed by a list that did not hear of it.
 */
export const PLAN_USAGE_NEUTRAL_COMMAND_TYPES: readonly string[] = [
  "customer.create",
  "customer.update",
  "sale.confirm",
  "stock.count",
  "stock.receive",
  "stock.write_off",
];

const usageWrites = new Set(PLAN_USAGE_WRITES);
const neutralCommandTypes = new Set(PLAN_USAGE_NEUTRAL_COMMAND_TYPES);
const listeners = new Set<() => void>();

function syncBatchChangesPlanUsage(input: unknown): boolean {
  const commands = (input as { commands?: unknown } | null | undefined)
    ?.commands;
  if (!Array.isArray(commands)) {
    return true;
  }
  return commands.some((command) => {
    const type = (command as { type?: unknown } | null)?.type;
    return typeof type !== "string" || !neutralCommandTypes.has(type);
  });
}

/** `input` is the write's own input: the batch of `sync/push` is read for the types it carries. */
export function writeChangesPlanUsage(
  path: readonly string[],
  input?: unknown
): boolean {
  const name = path.join("/");
  if (PLAN_USAGE_CONDITIONAL_WRITES.includes(name)) {
    return syncBatchChangesPlanUsage(input);
  }
  return usageWrites.has(name);
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
