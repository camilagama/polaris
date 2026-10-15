import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organization";
import { activeTenantScope } from "./product";

const runtimeRole = "polaris_pr11_runtime";

/**
 * The plan catalog (plan PR72): global reference data, the same for every
 * organization. Commercial values are rows here, not code, so a price or a
 * quota changes by migration or admin action without a deploy. The runtime
 * role can only read it.
 */
export const billingPlans = pgTable(
  "billing_plans",
  {
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    id: text("id").primaryKey(),
    name: text("name").notNull(),
  },
  (table) => [
    check("billing_plans_id_allowed", sql`${table.id} IN ('free', 'pro')`),
    check(
      "billing_plans_name_allowed",
      sql`char_length(btrim(${table.name})) BETWEEN 1 AND 60`
    ),
    pgPolicy("billing_plans_read", {
      for: "select",
      to: runtimeRole,
      using: sql`true`,
    }),
  ]
).enableRLS();

/** What a plan costs for a billing interval (BRL, two places). Free has no price. */
export const billingPrices = pgTable(
  "billing_prices",
  {
    active: boolean("active").default(true).notNull(),
    amount: numeric("amount").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    id: text("id").primaryKey(),
    intervalMonths: integer("interval_months").notNull(),
    planId: text("plan_id")
      .notNull()
      .references(() => billingPlans.id, { onDelete: "restrict" }),
  },
  (table) => [
    check(
      "billing_prices_interval_allowed",
      sql`${table.intervalMonths} IN (1, 6, 12)`
    ),
    check(
      "billing_prices_amount_allowed",
      sql`${table.amount} > 0 AND scale(${table.amount}) = 2 AND ${table.amount} < 1000000`
    ),
    check("billing_prices_paid_plan", sql`${table.planId} <> 'free'`),
    index("billing_prices_plan_idx").on(table.planId, table.intervalMonths),
    // one live price per plan and interval
    uniqueIndex("billing_prices_active_unique")
      .on(table.planId, table.intervalMonths)
      .where(sql`${table.active}`),
    pgPolicy("billing_prices_read", {
      for: "select",
      to: runtimeRole,
      using: sql`true`,
    }),
  ]
).enableRLS();

/**
 * One entitlement of one plan: a numeric limit or a yes/no flag, exactly one
 * of the two values according to the key.
 */
export const planEntitlements = pgTable(
  "plan_entitlements",
  {
    flagValue: boolean("flag_value"),
    key: text("key").notNull(),
    limitValue: integer("limit_value"),
    planId: text("plan_id")
      .notNull()
      .references(() => billingPlans.id, { onDelete: "restrict" }),
  },
  (table) => [
    primaryKey({
      columns: [table.planId, table.key],
      name: "plan_entitlements_pk",
    }),
    check(
      "plan_entitlements_key_value_coherent",
      sql`
        (${table.key} IN ('goals.active.max', 'images.active.max', 'images.per_product.max', 'variants.active.max')
          AND ${table.limitValue} IS NOT NULL AND ${table.limitValue} >= 0 AND ${table.flagValue} IS NULL)
        OR (${table.key} IN ('offline.write', 'public_catalog')
          AND ${table.flagValue} IS NOT NULL AND ${table.limitValue} IS NULL)
      `
    ),
    pgPolicy("plan_entitlements_read", {
      for: "select",
      to: runtimeRole,
      using: sql`true`,
    }),
  ]
).enableRLS();

/**
 * The organization's billing record (plan PR76): the canonical state Polaris
 * derives from validated facts, never what a provider just reported. No row
 * means the organization is on Free. The runtime reads it; state changes
 * arrive with the billing lifecycle, through named commands.
 */
export const organizationBilling = pgTable(
  "organization_billing",
  {
    /** When Pro access ends unless renewed; null in the free states. */
    accessEndsAt: timestamp("access_ends_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    state: text("state").default("free").notNull(),
    /** When the organization first started a trial: it is offered once. */
    trialStartedAt: timestamp("trial_started_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    version: integer("version").default(1).notNull(),
  },
  (table) => [
    check(
      "organization_billing_state_allowed",
      sql`${table.state} IN ('free', 'trial_setup', 'trialing', 'active', 'grace', 'free_over_limit')`
    ),
    // Pro access always has an end date; the free states never do
    check(
      "organization_billing_access_coherent",
      sql`
        (${table.state} IN ('trialing', 'active', 'grace') AND ${table.accessEndsAt} IS NOT NULL)
        OR (${table.state} IN ('free', 'trial_setup', 'free_over_limit') AND ${table.accessEndsAt} IS NULL)
      `
    ),
    check(
      "organization_billing_trial_recorded",
      sql`${table.state} <> 'trialing' OR ${table.trialStartedAt} IS NOT NULL`
    ),
    check("organization_billing_version_positive", sql`${table.version} >= 1`),
    pgPolicy("organization_billing_current_tenant_select", {
      for: "select",
      to: runtimeRole,
      using: activeTenantScope(table.organizationId),
    }),
  ]
).enableRLS();

/**
 * A temporary grant (support, a promotion): raises one entitlement of one
 * organization until it expires. It always has an end; a permanent change is a
 * plan change.
 */
export const entitlementGrants = pgTable(
  "entitlement_grants",
  {
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    flagValue: boolean("flag_value"),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    key: text("key").notNull(),
    limitValue: integer("limit_value"),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
  },
  (table) => [
    check(
      "entitlement_grants_key_value_coherent",
      sql`
        (${table.key} IN ('goals.active.max', 'images.active.max', 'images.per_product.max', 'variants.active.max')
          AND ${table.limitValue} IS NOT NULL AND ${table.limitValue} >= 0 AND ${table.flagValue} IS NULL)
        OR (${table.key} IN ('offline.write', 'public_catalog')
          AND ${table.flagValue} IS NOT NULL AND ${table.limitValue} IS NULL)
      `
    ),
    check(
      "entitlement_grants_reason_allowed",
      sql`char_length(btrim(${table.reason})) BETWEEN 1 AND 300`
    ),
    index("entitlement_grants_organization_idx").on(
      table.organizationId,
      table.expiresAt
    ),
    pgPolicy("entitlement_grants_current_tenant_select", {
      for: "select",
      to: runtimeRole,
      using: activeTenantScope(table.organizationId),
    }),
  ]
).enableRLS();
