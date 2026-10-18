import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const runtimeRole = "polaris_pr11_runtime";
const ownerRole = "polaris_privacy_owner";

/**
 * The deletion ledger (plan PR106, ADR 0080): one tombstone for each thing privacy took out of the
 * system, so that a restore of a backup can take it out again. It holds opaque IDs, the kind of record
 * and of operation, the time and, when there is one, the privacy case. No name, contact, note or value
 * of a record. It has no foreign key to the organization or to the record: it has to outlive both (the
 * purge deletes the organization, and the ledger is how its objects are found again).
 *
 * Append-only: the tenant runtime inserts (only the tombstone of a customer that is already anonymized,
 * in its own organization) and reads nothing; no role updates or deletes, because the table forces row
 * level security and no policy allows it. The privacy owner reads, for the restore.
 */
export const deletionLedger = pgTable(
  "deletion_ledger",
  {
    entityId: text("entity_id").notNull(),
    entityType: text("entity_type").notNull(),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    operation: text("operation").notNull(),
    organizationId: text("organization_id").notNull(),
    privacyCaseId: uuid("privacy_case_id"),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("deletion_ledger_entity_operation_unique").on(
      table.entityType,
      table.entityId,
      table.operation
    ),
    index("deletion_ledger_recorded_idx").on(table.recordedAt),
    index("deletion_ledger_organization_idx").on(table.organizationId),
    check(
      "deletion_ledger_kind_allowed",
      sql`(${table.entityType} = 'customer' AND ${table.operation} = 'anonymize')
        OR (${table.entityType} = 'organization' AND ${table.operation} = 'purge')`
    ),
    check(
      "deletion_ledger_ids_opaque",
      sql`${table.entityId} ~ '^[A-Za-z0-9_-]{1,64}$'
        AND ${table.organizationId} ~ '^[A-Za-z0-9_-]{1,64}$'`
    ),
    check(
      "deletion_ledger_entity_shape",
      sql`(${table.entityType} <> 'customer'
          OR ${table.entityId} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
        AND (${table.entityType} <> 'organization' OR ${table.entityId} = ${table.organizationId})`
    ),
    // the tenant runtime writes the tombstone of a customer anonymized in this very transaction
    pgPolicy("deletion_ledger_customer_anonymization_insert", {
      for: "insert",
      to: runtimeRole,
      withCheck: sql`
        ${table.organizationId} = NULLIF(current_setting('app.organization_id', true), '')
        AND ${table.entityType} = 'customer'
        AND ${table.operation} = 'anonymize'
        AND ${table.privacyCaseId} IS NULL
        AND EXISTS (
          SELECT 1
          FROM public.memberships AS membership_scope
          WHERE membership_scope.organization_id = ${table.organizationId}
            AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
            AND membership_scope.status = 'active'
        )
        AND EXISTS (
          SELECT 1
          FROM public.organizations AS organization_scope
          WHERE organization_scope.id = ${table.organizationId}
            AND organization_scope.status = 'active'
        )
        AND EXISTS (
          SELECT 1
          FROM public.customers AS customer_scope
          WHERE customer_scope.id::text = ${table.entityId}
            AND customer_scope.organization_id = ${table.organizationId}
            AND customer_scope.anonymized_at IS NOT NULL
        )`,
    }),
    pgPolicy("deletion_ledger_privacy_owner_select", {
      for: "select",
      to: ownerRole,
      using: sql`true`,
    }),
  ]
).enableRLS();
