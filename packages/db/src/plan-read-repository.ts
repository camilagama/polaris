import type { EffectiveEntitlements } from "@polaris/domain/billing/entitlements";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  getEffectiveEntitlements,
  listBillingPrices,
  type OrganizationScope,
} from "./billing-repository";
import { countActiveGoals } from "./goal-repository";
import { countActiveImages } from "./media-repository";
import { countOrganizationVariants } from "./product-repository";
import { products } from "./schema/product";
import { sales } from "./schema/sale";
import type { TenantRequestTransaction } from "./tenant-transaction";

/** What the organization holds against the limits of its plan, counted as the writes count it. */
export interface PlanUsage {
  goals: number;
  images: number;
  variants: number;
}

/** What the organization already keeps (AS-24): numbers of the database, never estimated. */
export interface PlanKept {
  /** The calendar months with at least one sale. */
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
 * role's.
 */
export async function readOwnerPlanTenantFacts(
  transaction: TenantRequestTransaction,
  scope: OrganizationScope
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
      months: sql<number>`count(DISTINCT date_trunc('month', ${sales.occurredOn}))::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(sales)
    .where(eq(sales.organizationId, organizationId));
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
      historyMonths: saleCounts?.months ?? 0,
      products: productCount?.total ?? 0,
      sales: saleCounts?.total ?? 0,
    },
    prices,
    usage,
  };
}
