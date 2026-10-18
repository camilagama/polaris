import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organization";
import { platformPrincipals } from "./platform";

const ownerRole = "polaris_admin_owner";

/**
 * Support and privacy cases (plan PR96, ADR 0072): why an operator is looking at
 * an organization. A case names the organization, the reason and who opened it;
 * a temporary grant to read that organization's records hangs from an open case.
 * The Admin reaches this table only through functions that also write the audit.
 */
export const supportCases = pgTable(
  "support_cases",
  {
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by").references(() => platformPrincipals.id),
    /** Typed by the operator: what is being looked into. Never tenant data. */
    context: text("context"),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    kind: text("kind").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    openedBy: uuid("opened_by")
      .notNull()
      .references(() => platformPrincipals.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    resolution: text("resolution"),
    status: text("status").default("open").notNull(),
  },
  (table) => [
    unique("support_cases_id_organization_unique").on(
      table.id,
      table.organizationId
    ),
    index("support_cases_organization_idx").on(table.organizationId, table.id),
    index("support_cases_status_idx").on(table.status, table.id),
    check(
      "support_cases_kind_allowed",
      sql`${table.kind} IN ('support', 'privacy')`
    ),
    check(
      "support_cases_status_allowed",
      sql`${table.status} IN ('open', 'closed')`
    ),
    check(
      "support_cases_reason_allowed",
      sql`char_length(${table.reason}) BETWEEN 1 AND 500 AND ${table.reason} = btrim(${table.reason})`
    ),
    check(
      "support_cases_context_allowed",
      sql`${table.context} IS NULL OR char_length(${table.context}) BETWEEN 1 AND 2000`
    ),
    check(
      "support_cases_resolution_allowed",
      sql`${table.resolution} IS NULL OR char_length(${table.resolution}) BETWEEN 1 AND 500`
    ),
    check(
      "support_cases_closing_coherent",
      sql`(${table.status} = 'open' AND ${table.closedAt} IS NULL AND ${table.closedBy} IS NULL AND ${table.resolution} IS NULL) OR (${table.status} = 'closed' AND ${table.closedAt} IS NOT NULL AND ${table.closedBy} IS NOT NULL)`
    ),
    pgPolicy("support_cases_admin_owner_select", {
      for: "select",
      to: ownerRole,
      using: sql`true`,
    }),
    pgPolicy("support_cases_admin_owner_insert", {
      for: "insert",
      to: ownerRole,
      withCheck: sql`true`,
    }),
    pgPolicy("support_cases_admin_owner_update", {
      for: "update",
      to: ownerRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ]
).enableRLS();

/**
 * A temporary read-only grant on one organization, for one operator, hanging
 * from an open case (plan PR97). It has an end by design (at most four hours),
 * can only be shortened by revoking it, and is the only thing that lets the
 * Admin read the organization's records.
 */
export const tenantAccessGrants = pgTable(
  "tenant_access_grants",
  {
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    organizationId: text("organization_id").notNull(),
    principalId: uuid("principal_id")
      .notNull()
      .references(() => platformPrincipals.id),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by").references(() => platformPrincipals.id),
    startsAt: timestamp("starts_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    supportCaseId: uuid("support_case_id").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.supportCaseId, table.organizationId],
      foreignColumns: [supportCases.id, supportCases.organizationId],
      name: "tenant_access_grants_case_organization_fk",
    }).onDelete("restrict"),
    index("tenant_access_grants_case_idx").on(table.supportCaseId),
    index("tenant_access_grants_principal_idx").on(
      table.principalId,
      table.expiresAt
    ),
    check(
      "tenant_access_grants_window_allowed",
      sql`${table.expiresAt} > ${table.startsAt} AND ${table.expiresAt} <= ${table.startsAt} + interval '4 hours'`
    ),
    check(
      "tenant_access_grants_revocation_coherent",
      sql`(${table.revokedAt} IS NULL) = (${table.revokedBy} IS NULL)`
    ),
    pgPolicy("tenant_access_grants_admin_owner_select", {
      for: "select",
      to: ownerRole,
      using: sql`true`,
    }),
    pgPolicy("tenant_access_grants_admin_owner_insert", {
      for: "insert",
      to: ownerRole,
      withCheck: sql`true`,
    }),
    pgPolicy("tenant_access_grants_admin_owner_update", {
      for: "update",
      to: ownerRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ]
).enableRLS();

/**
 * The administrative audit (plan PR99 of the source design): stricter than
 * logging. Append-only, written by the same functions that do the thing, and
 * never holding the sensitive value itself: a reveal records which field of
 * which record, not what it said.
 */
export const platformAuditEvents = pgTable(
  "platform_audit_events",
  {
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** A short, non-sensitive note (a field name, a count, a duration). */
    detail: text("detail"),
    entityId: text("entity_id"),
    entityType: text("entity_type"),
    eventType: text("event_type").notNull(),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    organizationId: text("organization_id"),
    principalId: uuid("principal_id")
      .notNull()
      .references(() => platformPrincipals.id),
    supportCaseId: uuid("support_case_id"),
  },
  (table) => [
    index("platform_audit_events_case_idx").on(table.supportCaseId, table.id),
    index("platform_audit_events_organization_idx").on(
      table.organizationId,
      table.id
    ),
    check(
      "platform_audit_events_type_allowed",
      sql`${table.eventType} IN ('support_case.opened', 'support_case.closed', 'tenant_access.granted', 'tenant_access.revoked', 'tenant_data.customers_read', 'pii.revealed', 'organization.suspended', 'organization.reactivated', 'billing.entitlement_grant_requested', 'billing.entitlement_granted', 'billing.entitlement_revoke_requested', 'billing.entitlement_revoked', 'privacy_case.stage_recorded', 'privacy_case.action_recorded', 'operational_incident.retry')`
    ),
    check(
      "platform_audit_events_detail_allowed",
      sql`${table.detail} IS NULL OR char_length(${table.detail}) <= 200`
    ),
    pgPolicy("platform_audit_events_admin_owner_select", {
      for: "select",
      to: ownerRole,
      using: sql`true`,
    }),
    pgPolicy("platform_audit_events_admin_owner_insert", {
      for: "insert",
      to: ownerRole,
      withCheck: sql`true`,
    }),
  ]
).enableRLS();
