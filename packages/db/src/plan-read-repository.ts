import type { EffectiveEntitlements } from "@polaris/domain/billing/entitlements";
import { historyMonthsOf } from "@polaris/domain/billing/plan-view";
import { localDate } from "@polaris/domain/organization/closure-deadlines";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  getEffectiveEntitlements,
  listBillingPrices,
  type OrganizationScope,
} from "./billing-repository";
import { countActiveGoals } from "./goal-repository";
import { countActiveImages } from "./media-repository";
import { countOrganizationVariants } from "./product-repository";
import { organizations } from "./schema/organization";
import { products } from "./schema/product";
import { sales } from "./schema/sale";
import type { TenantRequestTransaction } from "./tenant-transaction";

/** The database clock decides, never the application server's (as `getEffectiveEntitlements`). */
async function databaseNow(
  transaction: TenantRequestTransaction
): Promise<Date> {
  const clock = await transaction.execute<{ now: Date }>(
    sql`SELECT now() AS now`
  );
  const value = clock.rows[0]?.now;
  if (!value) {
    throw new Error("database_clock_unavailable");
  }
  return new Date(value);
}

/** What the organization holds against the limits of its plan, counted as the writes count it. */
export interface PlanUsage {
  goals: number;
  images: number;
  variants: number;
}

/** What the organization already keeps (AS-24): numbers of the database, never estimated. */
export interface PlanKept {
  /** The calendar months from the first confirmed sale to the current one, both counted (0 without a sale). */
  historyMonths: number;
  /** The products not deleted (archived ones too). */
  products: number;
  /** The confirmed sales, cancelled or returned ones too: they stay in the history. */
  sales: number;
}

export interface OwnerPlanTenantFacts {
  entitlements: EffectiveEntitlements;
  kept: PlanKept;
  prices: Awaited<ReturnType<typeof listBillingPrices>>;
  usage: PlanUsage;
}

/**
 * The tenant's part of the owner's read of the plan (ADR 0104, decision 2), in the caller's transaction (already
 * authorized with `billing:manage`): the active prices, the effective entitlements at the database clock (a grant
 * raises a limit), the usage by the very queries `assertRoomFor` counts with, and what the store keeps. Nothing of the
 * billing record beyond what `getEffectiveEntitlements` already reads: the columns of migration 0100 are the billing
 * role's. `now` is the clock of the history months (the database's own when not given), read in the store's calendar.
 */
export async function readOwnerPlanTenantFacts(
  transaction: TenantRequestTransaction,
  scope: OrganizationScope,
  now?: Date
): Promise<OwnerPlanTenantFacts> {
  const { organizationId } = scope;
  const prices = await listBillingPrices(transaction);
  const entitlements = await getEffectiveEntitlements(transaction, scope);
  const usage: PlanUsage = {
    goals: await countActiveGoals(transaction, organizationId),
    images: await countActiveImages(transaction, organizationId),
    variants: await countOrganizationVariants(transaction, organizationId),
  };
  const [saleCounts] = await transaction
    .select({
      firstOn: sql<string | null>`min(${sales.occurredOn})::text`,
      total: sql<number>`count(*)::int`,
    })
    .from(sales)
    .where(eq(sales.organizationId, organizationId));
  const clock = now ?? (await databaseNow(transaction));
  const [organization] = await transaction
    .select({ timezone: organizations.timezone })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  if (!organization) {
    throw new Error("organization_not_found");
  }
  const [productCount] = await transaction
    .select({ total: sql<number>`count(*)::int` })
    .from(products)
    .where(
      and(
        eq(products.organizationId, organizationId),
        isNull(products.deletedAt)
      )
    );
  return {
    entitlements,
    kept: {
      historyMonths: historyMonthsOf(
        saleCounts?.firstOn ?? null,
        localDate(clock, organization.timezone)
      ),
      products: productCount?.total ?? 0,
      sales: saleCounts?.total ?? 0,
    },
    prices,
    usage,
  };
}
