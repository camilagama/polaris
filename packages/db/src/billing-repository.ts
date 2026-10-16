import {
  type BillingFacts,
  type BillingState,
  type EffectiveEntitlements,
  type EntitlementGrant,
  isEntitlementKey,
  isLimitKey,
  type PlanCatalog,
  planCatalogFromRows,
  resolveEntitlements,
} from "@polaris/domain/billing/entitlements";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import {
  billingPlans,
  billingPrices,
  entitlementGrants,
  organizationBilling,
  planEntitlements,
} from "./schema/billing";
import type { TenantRequestTransaction } from "./tenant-transaction";

/** What billing reads need to know: which organization (row security scopes the rest). */
export interface OrganizationScope {
  organizationId: string;
}

/**
 * Billing reads (plan PR72 and PR73). Entitlements are derived here, on the
 * server, from Polaris's own records: the plan catalog, the organization's
 * billing state and its unexpired grants. Any member of the organization may
 * ask what the organization can do; row security scopes the tenant tables.
 */

/** The plan catalog as stored: every plan with all of its entitlements. */
export async function readPlanCatalog(
  transaction: TenantRequestTransaction
): Promise<PlanCatalog> {
  const rows = await transaction
    .select({
      flagValue: planEntitlements.flagValue,
      key: planEntitlements.key,
      limitValue: planEntitlements.limitValue,
      planId: planEntitlements.planId,
    })
    .from(planEntitlements);
  return planCatalogFromRows(rows);
}

/** The prices of the paid plans, cheapest interval first. */
export async function listBillingPrices(transaction: TenantRequestTransaction) {
  return await transaction
    .select({
      amount: billingPrices.amount,
      id: billingPrices.id,
      intervalMonths: billingPrices.intervalMonths,
      planId: billingPrices.planId,
    })
    .from(billingPrices)
    .where(eq(billingPrices.active, true))
    .orderBy(billingPrices.intervalMonths);
}

export async function listPlans(transaction: TenantRequestTransaction) {
  return await transaction
    .select({ id: billingPlans.id, name: billingPlans.name })
    .from(billingPlans)
    .orderBy(billingPlans.id);
}

/** The organization's billing facts; no record means Free. */
async function readBillingFacts(
  transaction: TenantRequestTransaction,
  scope: OrganizationScope
): Promise<BillingFacts & { version: number }> {
  const [row] = await transaction
    .select({
      accessEndsAt: organizationBilling.accessEndsAt,
      state: organizationBilling.state,
      version: organizationBilling.version,
    })
    .from(organizationBilling)
    .where(eq(organizationBilling.organizationId, scope.organizationId));
  if (!row) {
    return { accessEndsAt: null, state: "free", version: 0 };
  }
  return {
    accessEndsAt: row.accessEndsAt,
    state: row.state as BillingState,
    version: row.version,
  };
}

async function readGrants(
  transaction: TenantRequestTransaction,
  scope: OrganizationScope
): Promise<EntitlementGrant[]> {
  const rows = await transaction
    .select({
      expiresAt: entitlementGrants.expiresAt,
      flagValue: entitlementGrants.flagValue,
      key: entitlementGrants.key,
      limitValue: entitlementGrants.limitValue,
      startsAt: entitlementGrants.startsAt,
    })
    .from(entitlementGrants)
    .where(
      and(
        eq(entitlementGrants.organizationId, scope.organizationId),
        // one revoked before it started was never in force
        or(
          isNull(entitlementGrants.revokedAt),
          gt(entitlementGrants.revokedAt, entitlementGrants.startsAt)
        )
      )
    );
  const grants: EntitlementGrant[] = [];
  for (const row of rows) {
    if (!isEntitlementKey(row.key)) {
      continue;
    }
    const value = isLimitKey(row.key) ? row.limitValue : row.flagValue;
    if (value !== null) {
      grants.push({
        expiresAt: row.expiresAt,
        key: row.key,
        startsAt: row.startsAt,
        value,
      });
    }
  }
  return grants;
}

/**
 * What the organization may do right now: the plan in force at the database
 * clock, raised by unexpired grants. A trial, period or grace that ran out
 * counts as Free even if the billing record was not updated yet.
 */
export async function getEffectiveEntitlements(
  transaction: TenantRequestTransaction,
  scope: OrganizationScope
): Promise<EffectiveEntitlements> {
  const catalog = await readPlanCatalog(transaction);
  const facts = await readBillingFacts(transaction, scope);
  const grants = await readGrants(transaction, scope);
  const clock = await transaction.execute<{ now: Date }>(
    sql`SELECT now() AS now`
  );
  // the database clock decides, never the application server's
  const databaseNow = clock.rows[0]?.now;
  if (!databaseNow) {
    throw new Error("database_clock_unavailable");
  }
  const now = new Date(databaseNow);
  return resolveEntitlements({
    catalog,
    facts: { accessEndsAt: facts.accessEndsAt, state: facts.state },
    grants,
    now,
  });
}
