import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { platformPrincipals } from "./platform";
import { supportCases } from "./platform-support";

const ownerRole = "polaris_admin_owner";

/**
 * The workflow of a privacy request (plan PR103, ADR 0077): one row per support
 * case of kind privacy, moved forward one step at a time by database functions that
 * also write the administrative audit. It holds codes, an opaque reference and a
 * short note: no name, e-mail, document or value of a record. The database itself
 * refuses a row that skips a step, accepts a request whose identity failed, or lets
 * Polaris accept on its own authority data it only processes.
 */
export const privacyCases = pgTable(
  "privacy_cases",
  {
    channel: text("channel").notNull(),
    decision: text("decision"),
    decisionNote: text("decision_note"),
    decisionReason: text("decision_reason"),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    identityMethod: text("identity_method"),
    identityStatus: text("identity_status"),
    /** Typed by the operator when the request arrived. Never personal data. */
    note: text("note"),
    polarisRole: text("polaris_role"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    requesterKind: text("requester_kind").notNull(),
    requestType: text("request_type").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    scopeCategories: text("scope_categories").array(),
    stage: text("stage").default("requested").notNull(),
    /** An opaque ID (for instance a customer's UUID), never a name or a contact. */
    subjectReference: text("subject_reference"),
    supportCaseId: uuid("support_case_id").primaryKey(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.supportCaseId],
      foreignColumns: [supportCases.id],
      name: "privacy_cases_support_case_fk",
    }).onDelete("restrict"),
    index("privacy_cases_stage_due_idx").on(table.stage, table.dueAt),
    check(
      "privacy_cases_stage_allowed",
      sql`${table.stage} IN ('requested', 'identity_checked', 'role_determined', 'scoped', 'decided', 'executed', 'resolved')`
    ),
    check(
      "privacy_cases_request_allowed",
      sql`${table.requestType} IN ('access', 'correction', 'deletion', 'portability', 'objection', 'restriction', 'other')
        AND ${table.requesterKind} IN ('data_subject', 'organization_owner', 'authority', 'other')
        AND ${table.channel} IN ('email', 'in_app', 'support_ticket', 'other')`
    ),
    check(
      "privacy_cases_due_after_receipt",
      sql`${table.dueAt} > ${table.receivedAt}`
    ),
    check(
      "privacy_cases_identity_allowed",
      sql`(${table.identityStatus} IS NULL AND ${table.identityMethod} IS NULL)
        OR (${table.identityStatus} IN ('verified', 'failed')
            AND ${table.identityMethod} IN ('authenticated_session', 'email_ownership', 'owner_confirmation', 'document_review', 'other'))`
    ),
    check(
      "privacy_cases_role_allowed",
      sql`${table.polarisRole} IS NULL OR ${table.polarisRole} IN ('controller', 'processor')`
    ),
    check(
      "privacy_cases_scope_allowed",
      sql`${table.scopeCategories} IS NULL
        OR (cardinality(${table.scopeCategories}) BETWEEN 1 AND 9
            AND ${table.scopeCategories} <@ ARRAY['account', 'authentication', 'organization_profile', 'customers', 'sales', 'inventory_catalog', 'media', 'billing', 'audit_logs']::text[])`
    ),
    check(
      "privacy_cases_decision_allowed",
      sql`(${table.decision} IS NULL OR ${table.decision} IN ('accept', 'partially_accept', 'reject', 'redirect_to_controller'))
        AND (${table.decisionReason} IS NULL OR ${table.decisionReason} IN ('identity_not_verified', 'no_authority', 'controller_is_reseller', 'legal_retention', 'manifestly_unfounded', 'not_personal_data', 'other'))
        AND (${table.decision} IS NULL OR ${table.decision} = 'accept' OR ${table.decisionReason} IS NOT NULL)`
    ),
    check(
      "privacy_cases_texts_allowed",
      sql`(${table.note} IS NULL OR (char_length(${table.note}) BETWEEN 1 AND 500 AND ${table.note} !~ '[[:cntrl:]]'))
        AND (${table.decisionNote} IS NULL OR (char_length(${table.decisionNote}) BETWEEN 1 AND 500 AND ${table.decisionNote} !~ '[[:cntrl:]]'))
        AND (${table.subjectReference} IS NULL OR (char_length(${table.subjectReference}) BETWEEN 1 AND 64 AND ${table.subjectReference} ~ '^[A-Za-z0-9_-]+$'))`
    ),
    // each step fills in its own part, and only once the one before it is done
    check(
      "privacy_cases_steps_in_order",
      sql`((${table.stage} = 'requested') = (${table.identityStatus} IS NULL))
        AND ((${table.stage} IN ('requested', 'identity_checked')) = (${table.polarisRole} IS NULL))
        AND ((${table.stage} IN ('requested', 'identity_checked', 'role_determined')) = (${table.scopeCategories} IS NULL))
        AND ((${table.stage} IN ('requested', 'identity_checked', 'role_determined', 'scoped')) = (${table.decision} IS NULL))
        AND ((${table.stage} = 'resolved') = (${table.resolvedAt} IS NOT NULL))`
    ),
    // what the database refuses to let an operator decide
    check(
      "privacy_cases_decision_fits_facts",
      sql`(${table.identityStatus} IS DISTINCT FROM 'failed'
            OR ${table.decision} IS NULL
            OR (${table.decision} = 'reject' AND ${table.decisionReason} = 'identity_not_verified'))
        AND (${table.decisionReason} IS DISTINCT FROM 'identity_not_verified' OR ${table.identityStatus} = 'failed')
        AND (${table.polarisRole} IS DISTINCT FROM 'processor'
            OR ${table.requesterKind} = 'organization_owner'
            OR ${table.decision} IS NULL
            OR ${table.decision} NOT IN ('accept', 'partially_accept'))
        AND (${table.decision} IS DISTINCT FROM 'redirect_to_controller' OR ${table.polarisRole} = 'processor')`
    ),
    pgPolicy("privacy_cases_admin_owner_select", {
      for: "select",
      to: ownerRole,
      using: sql`true`,
    }),
    pgPolicy("privacy_cases_admin_owner_insert", {
      for: "insert",
      to: ownerRole,
      withCheck: sql`true`,
    }),
    pgPolicy("privacy_cases_admin_owner_update", {
      for: "update",
      to: ownerRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ]
).enableRLS();

/** What was done to carry a decision out. Append-only, like the audit. */
export const privacyCaseActions = pgTable(
  "privacy_case_actions",
  {
    action: text("action").notNull(),
    /** The record acted on, as a UUID; never a name. */
    entityId: text("entity_id"),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    recordedBy: uuid("recorded_by")
      .notNull()
      .references(() => platformPrincipals.id),
    supportCaseId: uuid("support_case_id").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.supportCaseId],
      foreignColumns: [privacyCases.supportCaseId],
      name: "privacy_case_actions_case_fk",
    }).onDelete("restrict"),
    index("privacy_case_actions_case_idx").on(table.supportCaseId, table.id),
    check(
      "privacy_case_actions_action_allowed",
      sql`${table.action} IN ('customer_anonymized', 'organization_closed', 'export_delivered', 'purge_scheduled', 'redirected_to_reseller', 'no_action_required', 'other')`
    ),
    check(
      "privacy_case_actions_entity_allowed",
      sql`${table.entityId} IS NULL OR ${table.entityId} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`
    ),
    pgPolicy("privacy_case_actions_admin_owner_select", {
      for: "select",
      to: ownerRole,
      using: sql`true`,
    }),
    pgPolicy("privacy_case_actions_admin_owner_insert", {
      for: "insert",
      to: ownerRole,
      withCheck: sql`true`,
    }),
  ]
).enableRLS();
