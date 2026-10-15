import {
  assertWithinLimit,
  type FlagKey,
  type LimitKey,
} from "@polaris/domain/billing/entitlements";
import { sql } from "drizzle-orm";
import {
  getEffectiveEntitlements,
  type OrganizationScope,
} from "./billing-repository";
import type { TenantRequestTransaction } from "./tenant-transaction";

/**
 * Plan limits applied where the data is written (plan PR74 and PR75), not only
 * in the interface. Each check reads the effective entitlements of the
 * organization inside the caller's transaction and refuses an addition that
 * would pass the limit; what the organization already holds above it (after a
 * downgrade) is never touched, only further additions are refused.
 */

/**
 * Serializes the additions that are counted against one limit of one
 * organization for the rest of the transaction: without it, two requests could
 * each count the same total and both commit past the limit. Transaction-scoped
 * and keyed by organization and limit, so other organizations never wait.
 */
async function lockLimit(
  transaction: TenantRequestTransaction,
  scope: OrganizationScope,
  key: LimitKey
): Promise<void> {
  await transaction.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`polaris.entitlement:${key}:${scope.organizationId}`}, 0))`
  );
}

/**
 * Refuses an addition of `adding` to what is counted for `key`. `count` is read
 * after the lock is taken, so it sees every addition committed before this one.
 */
export async function assertRoomFor(
  transaction: TenantRequestTransaction,
  scope: OrganizationScope,
  key: LimitKey,
  adding: number,
  count: () => Promise<number>
): Promise<void> {
  await lockLimit(transaction, scope, key);
  const entitlements = await getEffectiveEntitlements(transaction, scope);
  assertWithinLimit(entitlements, key, await count(), adding);
}

/** Whether the plan includes a capability, for callers that turn a refusal into their own outcome. */
export async function isFlagEnabled(
  transaction: TenantRequestTransaction,
  scope: OrganizationScope,
  key: FlagKey
): Promise<boolean> {
  return (await getEffectiveEntitlements(transaction, scope)).values[key];
}
