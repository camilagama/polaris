import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organization";
import { activeTenantScope } from "./product";

const runtimeRole = "polaris_pr11_runtime";

/**
 * A target for a period (plan PR70), measured by net sales, the estimated
 * operating result or the number of sales. Progress is never stored: it is
 * derived from the period result. Status moves only forward from `active`
 * (completed, missed or cancelled are final); `achieved_value` and
 * `settled_at` record the moment a goal was completed or missed.
 */
export const goals = pgTable(
  "goals",
  {
    /** The measure when the goal settled (decimal text); null while active or cancelled. */
    achievedValue: numeric("achieved_value"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    endsOn: date("ends_on", { mode: "string" }).notNull(),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    kind: text("kind").notNull(),
    name: text("name"),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    startsOn: date("starts_on", { mode: "string" }).notNull(),
    status: text("status").default("active").notNull(),
    /** Money kinds have two places; a count is a whole number. */
    target: numeric("target").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    version: integer("version").default(1).notNull(),
  },
  (table) => {
    const tenantScope = activeTenantScope(table.organizationId);
    return [
      check(
        "goals_kind_allowed",
        sql`${table.kind} IN ('net_sales', 'operating_result', 'sale_count')`
      ),
      check(
        "goals_status_allowed",
        sql`${table.status} IN ('active', 'completed', 'missed', 'cancelled')`
      ),
      check(
        "goals_target_allowed",
        sql`
          ${table.target} > 0
          AND (
            (${table.kind} = 'sale_count' AND scale(${table.target}) = 0 AND ${table.target} <= 1000000)
            OR (${table.kind} <> 'sale_count' AND scale(${table.target}) <= 2 AND ${table.target} < 1000000000000000000)
          )
        `
      ),
      check(
        "goals_period_allowed",
        sql`
          ${table.startsOn} >= DATE '2000-01-01'
          AND ${table.endsOn} >= ${table.startsOn}
          AND ${table.endsOn} - ${table.startsOn} < 366
        `
      ),
      check(
        "goals_name_allowed",
        sql`${table.name} IS NULL OR (char_length(btrim(${table.name})) >= 1 AND char_length(${table.name}) <= 100)`
      ),
      // a settled goal says when; an active or cancelled one carries neither
      check(
        "goals_settlement_coherent",
        sql`
          (${table.status} IN ('completed', 'missed') AND ${table.settledAt} IS NOT NULL AND ${table.achievedValue} IS NOT NULL)
          OR (${table.status} IN ('active', 'cancelled') AND ${table.achievedValue} IS NULL)
        `
      ),
      check("goals_version_positive", sql`${table.version} >= 1`),
      uniqueIndex("goals_organization_id_id_unique").on(
        table.organizationId,
        table.id
      ),
      index("goals_organization_status_period_idx").on(
        table.organizationId,
        table.status,
        table.startsOn
      ),
      pgPolicy("goals_current_tenant_select", {
        for: "select",
        to: runtimeRole,
        using: tenantScope,
      }),
      pgPolicy("goals_current_tenant_insert", {
        for: "insert",
        to: runtimeRole,
        withCheck: tenantScope,
      }),
      pgPolicy("goals_current_tenant_update", {
        for: "update",
        to: runtimeRole,
        using: tenantScope,
        withCheck: tenantScope,
      }),
    ];
  }
).enableRLS();

/** Every change of an active goal's target, kept (append-only): the audit of "the target moved". */
export const goalTargetChanges = pgTable(
  "goal_target_changes",
  {
    changedAt: timestamp("changed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    changedBy: text("changed_by").notNull(),
    goalId: uuid("goal_id").notNull(),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    newTarget: numeric("new_target").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    previousTarget: numeric("previous_target").notNull(),
  },
  (table) => {
    const tenantScope = activeTenantScope(table.organizationId);
    return [
      check(
        "goal_target_changes_targets_allowed",
        sql`${table.newTarget} > 0 AND ${table.previousTarget} > 0 AND ${table.newTarget} <> ${table.previousTarget}`
      ),
      foreignKey({
        columns: [table.organizationId, table.goalId],
        foreignColumns: [goals.organizationId, goals.id],
        name: "goal_target_changes_organization_goal_fk",
      }).onDelete("restrict"),
      index("goal_target_changes_organization_goal_idx").on(
        table.organizationId,
        table.goalId,
        table.changedAt
      ),
      pgPolicy("goal_target_changes_current_tenant_select", {
        for: "select",
        to: runtimeRole,
        using: tenantScope,
      }),
      pgPolicy("goal_target_changes_current_tenant_insert", {
        for: "insert",
        to: runtimeRole,
        withCheck: tenantScope,
      }),
    ];
  }
).enableRLS();
