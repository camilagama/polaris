import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
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
import { activeTenantScope, productVariants } from "./product";

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
    /** The subscription was cancelled: access ends with the period already paid for. */
    cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** The cycle being paid, in months (1, 6 or 12), while Pro. */
    cycleMonths: integer("cycle_months"),
    /** The moment of the newest provider fact applied; an older fact is stale. */
    lastFactAt: timestamp("last_fact_at", { withTimezone: true }),
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /**
     * When the organization left Pro access (the end of the access that lapsed,
     * or the moment it was removed): the start of the adaptation window of Free
     * Over Limit (ADR 0064). Set when the record enters `free_over_limit`, cleared
     * when it leaves.
     */
    overLimitSince: timestamp("over_limit_since", { withTimezone: true }),
    /** A cycle change that takes effect at the next renewal. */
    pendingCycleMonths: integer("pending_cycle_months"),
    /** Which payment provider holds the subscription, and its reference there (no personal data). */
    provider: text("provider"),
    providerRef: text("provider_ref"),
    /**
     * The newest payment taken back by a refund or a chargeback (PR84), while
     * the record is not on a paid period: the end of the period that was paid
     * for, why it was taken back (`won`: a chargeback reversed before it was
     * applied) and what the subscription was. It keeps that payment's late
     * confirmation from reviving the access and lets a reversed chargeback
     * restore it. Cleared when the record is paid again.
     */
    revokedCancelAtPeriodEnd: boolean("revoked_cancel_at_period_end")
      .default(false)
      .notNull(),
    revokedCycleMonths: integer("revoked_cycle_months"),
    revokedReason: text("revoked_reason"),
    revokedThrough: timestamp("revoked_through", { withTimezone: true }),
    state: text("state").default("free").notNull(),
    /** When the trial was used, or waived by subscribing without one: it is offered once. */
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
    // a payment taken back is remembered whole or not at all, and never on a paid period
    check(
      "organization_billing_revoked_coherent",
      sql`
        (${table.revokedThrough} IS NULL AND ${table.revokedReason} IS NULL AND ${table.revokedCycleMonths} IS NULL AND NOT ${table.revokedCancelAtPeriodEnd})
        OR (
          ${table.revokedThrough} IS NOT NULL
          AND ${table.revokedReason} IN ('refund', 'chargeback', 'won')
          AND (${table.state} NOT IN ('active', 'grace') OR ${table.revokedReason} = 'won')
          AND (${table.revokedCycleMonths} IS NULL OR ${table.revokedCycleMonths} IN (1, 6, 12))
        )
      `
    ),
    // only a record that is free (over the limits, or setting up a trial) has an episode start
    check(
      "organization_billing_over_limit_since_coherent",
      sql`${table.overLimitSince} IS NULL OR ${table.state} IN ('free_over_limit', 'trial_setup')`
    ),
    check(
      "organization_billing_cycle_allowed",
      sql`(${table.cycleMonths} IS NULL OR ${table.cycleMonths} IN (1, 6, 12)) AND (${table.pendingCycleMonths} IS NULL OR ${table.pendingCycleMonths} IN (1, 6, 12))`
    ),
    // a free record has no cycle, nothing pending and nothing cancelled
    check(
      "organization_billing_free_has_no_subscription_flags",
      sql`
        ${table.state} IN ('trialing', 'active', 'grace')
        OR (NOT ${table.cancelAtPeriodEnd} AND ${table.cycleMonths} IS NULL AND ${table.pendingCycleMonths} IS NULL)
      `
    ),
    check(
      "organization_billing_provider_coherent",
      sql`
        (${table.provider} IS NULL AND ${table.providerRef} IS NULL)
        OR (
          ${table.provider} ~ '^[a-z][a-z0-9_]{1,31}$'
          AND char_length(${table.providerRef}) BETWEEN 1 AND 128
        )
      `
    ),
    // one subscription at a provider belongs to one organization
    uniqueIndex("organization_billing_provider_ref_unique")
      .on(table.provider, table.providerRef)
      .where(sql`${table.providerRef} IS NOT NULL`),
    // the sweep of expired access reads this
    index("organization_billing_due_idx")
      .on(table.accessEndsAt)
      .where(sql`${table.state} IN ('trialing', 'active', 'grace')`),
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

/**
 * The inbox and the ledger of billing (plan PR79 and PR81): every fact a
 * provider reported (already reduced to what the lifecycle needs, with no
 * personal data and no raw payload) and every transition time caused, with the
 * state before and after. A provider event is stored once (`provider` and
 * `provider_event_id` are unique), so a delivered-twice webhook is one row; a
 * row is only ever updated to record how it was processed and is never deleted.
 */
export const billingEvents = pgTable(
  "billing_events",
  {
    attempts: integer("attempts").default(0).notNull(),
    /** The normalized fact, as the lifecycle reads it. */
    fact: jsonb("fact").notNull(),
    factType: text("fact_type").notNull(),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    /** The organization, when known; resolved from `provider_ref` otherwise. */
    organizationId: text("organization_id").references(() => organizations.id, {
      onDelete: "restrict",
    }),
    /** `not_applicable`, `stale` and `reference_mismatch` for ignored facts, `unknown_organization` and `error` for failed ones. */
    outcomeCode: text("outcome_code"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    /** The subscription reference the provider reported. */
    providerRef: text("provider_ref"),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    stateAfter: text("state_after"),
    stateBefore: text("state_before"),
    status: text("status").default("received").notNull(),
  },
  (table) => [
    check(
      "billing_events_provider_format",
      sql`${table.provider} ~ '^[a-z][a-z0-9_]{1,31}$' AND char_length(${table.providerEventId}) BETWEEN 1 AND 160`
    ),
    check(
      "billing_events_provider_ref_length",
      sql`${table.providerRef} IS NULL OR char_length(${table.providerRef}) BETWEEN 1 AND 128`
    ),
    check(
      "billing_events_fact_type_allowed",
      sql`${table.factType} IN ('trial_method_ready', 'charge_succeeded', 'charge_failed', 'subscription_cancelled', 'cycle_change_scheduled', 'charge_refunded', 'charge_disputed', 'dispute_reversed', 'time_elapsed', 'command')`
    ),
    check(
      "billing_events_status_allowed",
      sql`${table.status} IN ('received', 'applied', 'ignored', 'failed')`
    ),
    check(
      "billing_events_outcome_allowed",
      sql`${table.outcomeCode} IS NULL OR ${table.outcomeCode} IN ('not_applicable', 'stale', 'reference_mismatch', 'unknown_organization', 'error')`
    ),
    check(
      "billing_events_fact_is_small_object",
      sql`jsonb_typeof(${table.fact}) = 'object' AND pg_column_size(${table.fact}) < 2048`
    ),
    check("billing_events_attempts_nonnegative", sql`${table.attempts} >= 0`),
    uniqueIndex("billing_events_provider_event_unique").on(
      table.provider,
      table.providerEventId
    ),
    index("billing_events_organization_idx").on(
      table.organizationId,
      table.receivedAt
    ),
    // what the retry pass reads
    index("billing_events_pending_idx")
      .on(table.receivedAt)
      .where(sql`${table.status} IN ('received', 'failed')`),
    // a person sees the billing history of their own organization, never writes it
    pgPolicy("billing_events_current_tenant_select", {
      for: "select",
      to: runtimeRole,
      using: sql`${table.organizationId} IS NOT NULL AND ${activeTenantScope(table.organizationId)}`,
    }),
  ]
).enableRLS();

/**
 * The variants that stay operational while an organization is over the Free
 * limit (plan PR82, ADR 0064): the choice is a record of its own, never a
 * property of the variant. Each row belongs to one "left Pro" episode
 * (`episode_started_at`); rows of an earlier episode are ignored and replaced.
 * While the adaptation window is open the choice is replaced freely; after it
 * the rows can only be added (the command enforces it), so a variant cannot be
 * unlocked and locked again to work around the plan.
 */
export const operationalVariantSelections = pgTable(
  "operational_variant_selections",
  {
    episodeStartedAt: timestamp("episode_started_at", {
      withTimezone: true,
    }).notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    productId: uuid("product_id").notNull(),
    selectedAt: timestamp("selected_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** `user` when the organization chose it, `default` when the window ended without a choice. */
    source: text("source").default("user").notNull(),
    variantId: uuid("variant_id").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.variantId],
      name: "operational_variant_selections_pk",
    }),
    check(
      "operational_variant_selections_source_allowed",
      sql`${table.source} IN ('user', 'default')`
    ),
    foreignKey({
      columns: [table.organizationId, table.productId, table.variantId],
      foreignColumns: [
        productVariants.organizationId,
        productVariants.productId,
        productVariants.id,
      ],
      name: "operational_variant_selections_organization_variant_fk",
    }).onDelete("cascade"),
    pgPolicy("operational_variant_selections_current_tenant_select", {
      for: "select",
      to: runtimeRole,
      using: activeTenantScope(table.organizationId),
    }),
    pgPolicy("operational_variant_selections_current_tenant_insert", {
      for: "insert",
      to: runtimeRole,
      withCheck: activeTenantScope(table.organizationId),
    }),
    pgPolicy("operational_variant_selections_current_tenant_delete", {
      for: "delete",
      to: runtimeRole,
      using: activeTenantScope(table.organizationId),
    }),
  ]
).enableRLS();
