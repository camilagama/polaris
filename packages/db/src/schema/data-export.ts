import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organization";

const runtimeRole = "polaris_pr11_runtime";
const ownerRole = "polaris_privacy_owner";

function activeTenantScope(organizationId: unknown) {
  return sql`
    ${organizationId} = NULLIF(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1
      FROM public.memberships AS membership_scope
      WHERE membership_scope.organization_id = ${organizationId}
        AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
        AND membership_scope.status = 'active'
    )
    AND EXISTS (
      SELECT 1
      FROM public.organizations AS organization_scope
      WHERE organization_scope.id = ${organizationId}
        AND organization_scope.status = 'active'
    )
  `;
}

/**
 * A request for a copy of an organization's data (plan PR104, ADR 0078). The owner inserts the
 * request (and only that: the tenant runtime updates nothing); the privacy role's functions claim
 * it, record its files, and finish, fail or expire it. At most one is in flight per organization,
 * and at most three are asked for in a day.
 */
export const dataExports = pgTable(
  "data_exports",
  {
    attempts: integer("attempts").default(0).notNull(),
    errorCode: text("error_code"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    filesDeletedAt: timestamp("files_deleted_at", { withTimezone: true }),
    formats: text("formats").array().notNull(),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** An internal user ID, never a name or e-mail. */
    requestedByUserId: text("requested_by_user_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    status: text("status").default("requested").notNull(),
    totalBytes: bigint("total_bytes", { mode: "number" }),
  },
  (table) => [
    index("data_exports_organization_requested_idx").on(
      table.organizationId,
      table.requestedAt
    ),
    index("data_exports_status_idx").on(table.status, table.requestedAt),
    uniqueIndex("data_exports_one_in_flight_unique")
      .on(table.organizationId)
      .where(sql`${table.status} IN ('requested', 'running')`),
    check(
      "data_exports_status_allowed",
      sql`${table.status} IN ('requested', 'running', 'ready', 'failed', 'expired')`
    ),
    check(
      "data_exports_formats_allowed",
      sql`cardinality(${table.formats}) BETWEEN 1 AND 3 AND ${table.formats} <@ ARRAY['json', 'csv', 'images']::text[]`
    ),
    check(
      "data_exports_attempts_allowed",
      sql`${table.attempts} BETWEEN 0 AND 3`
    ),
    check(
      "data_exports_error_code_format",
      sql`${table.errorCode} IS NULL OR ${table.errorCode} ~ '^[a-z][a-z0-9_]{0,63}$'`
    ),
    check(
      "data_exports_requester_allowed",
      sql`char_length(btrim(${table.requestedByUserId})) BETWEEN 1 AND 255`
    ),
    // each state holds what it must, and only that
    check(
      "data_exports_state_coherent",
      sql`(${table.status} <> 'running' OR (${table.lockedUntil} IS NOT NULL AND ${table.startedAt} IS NOT NULL))
        AND (${table.status} <> 'ready' OR (${table.readyAt} IS NOT NULL AND ${table.expiresAt} IS NOT NULL AND ${table.totalBytes} IS NOT NULL AND ${table.errorCode} IS NULL))
        AND (${table.status} <> 'failed' OR ${table.errorCode} IS NOT NULL)
        AND (${table.status} IN ('ready', 'expired') OR ${table.expiresAt} IS NULL)
        AND (${table.status} = 'requested' OR ${table.status} = 'running' OR ${table.lockedUntil} IS NULL)`
    ),
    pgPolicy("data_exports_current_tenant_select", {
      for: "select",
      to: runtimeRole,
      using: activeTenantScope(table.organizationId),
    }),
    pgPolicy("data_exports_current_owner_insert", {
      for: "insert",
      to: runtimeRole,
      withCheck: sql`${activeTenantScope(table.organizationId)}
        AND ${table.requestedByUserId} = NULLIF(current_setting('app.user_id', true), '')
        AND ${table.status} = 'requested'
        AND ${table.attempts} = 0`,
    }),
    pgPolicy("data_exports_privacy_owner_select", {
      for: "select",
      to: ownerRole,
      using: sql`true`,
    }),
    pgPolicy("data_exports_privacy_owner_update", {
      for: "update",
      to: ownerRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ]
).enableRLS();

/** One downloadable file of a finished export. Written only by the privacy role's functions. */
export const dataExportFiles = pgTable(
  "data_export_files",
  {
    contentType: text("content_type").default("application/zip").notNull(),
    exportId: uuid("export_id")
      .notNull()
      .references(() => dataExports.id, { onDelete: "cascade" }),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    name: text("name").notNull(),
    ordinal: integer("ordinal").notNull(),
    organizationId: text("organization_id").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    storageKey: text("storage_key").notNull(),
  },
  (table) => [
    uniqueIndex("data_export_files_export_ordinal_unique").on(
      table.exportId,
      table.ordinal
    ),
    uniqueIndex("data_export_files_storage_key_unique").on(table.storageKey),
    check(
      "data_export_files_ordinal_allowed",
      sql`${table.ordinal} BETWEEN 1 AND 999`
    ),
    check(
      "data_export_files_name_allowed",
      sql`${table.name} ~ '^polaris-[a-z]+-[0-9]{4}-[0-9]{2}-[0-9]{2}(-parte-[0-9]{3})?\\.zip$'`
    ),
    check(
      "data_export_files_size_allowed",
      sql`${table.sizeBytes} BETWEEN 1 AND 104857600`
    ),
    check(
      "data_export_files_key_allowed",
      sql`${table.storageKey} ~ '^exports/v1/[A-Za-z0-9_-]+/[0-9a-f-]{36}/[A-Za-z0-9._-]+$'`
    ),
    pgPolicy("data_export_files_current_tenant_select", {
      for: "select",
      to: runtimeRole,
      using: activeTenantScope(table.organizationId),
    }),
    pgPolicy("data_export_files_privacy_owner_select", {
      for: "select",
      to: ownerRole,
      using: sql`true`,
    }),
    pgPolicy("data_export_files_privacy_owner_insert", {
      for: "insert",
      to: ownerRole,
      withCheck: sql`true`,
    }),
    pgPolicy("data_export_files_privacy_owner_delete", {
      for: "delete",
      to: ownerRole,
      using: sql`true`,
    }),
  ]
).enableRLS();
