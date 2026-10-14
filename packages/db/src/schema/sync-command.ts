import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organization";

const runtimeRole = "polaris_pr11_runtime";

/**
 * The idempotency record of `sync.push` (plan PR53): one row per command ID and
 * organization holding the outcome the server gave it, so the same command sent
 * again returns the same outcome instead of running twice. Rows are append-only
 * for the runtime: it can read and insert, never edit or delete.
 */
export const syncCommands = pgTable(
  "sync_commands",
  {
    commandId: uuid("command_id").notNull(),
    commandType: text("command_type").notNull(),
    deviceId: uuid("device_id"),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    leaseGrantId: uuid("lease_grant_id"),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    outcomeCode: text("outcome_code"),
    outcomeResult: jsonb("outcome_result"),
    outcomeStatus: text("outcome_status").notNull(),
    payloadHash: text("payload_hash").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    userId: text("user_id").notNull(),
  },
  (table) => [
    check(
      "sync_commands_outcome_status_allowed",
      sql`${table.outcomeStatus} IN ('accepted', 'rejected')`
    ),
    check(
      "sync_commands_outcome_coherent",
      sql`(${table.outcomeStatus} = 'accepted' AND ${table.outcomeCode} IS NULL) OR (${table.outcomeStatus} = 'rejected' AND ${table.outcomeCode} IS NOT NULL AND ${table.outcomeResult} IS NULL)`
    ),
    check(
      "sync_commands_outcome_code_format",
      sql`${table.outcomeCode} IS NULL OR ${table.outcomeCode} ~ '^[a-z][a-z0-9_]{0,63}$'`
    ),
    check(
      "sync_commands_command_type_format",
      sql`${table.commandType} ~ '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$' AND char_length(${table.commandType}) <= 100`
    ),
    check(
      "sync_commands_payload_hash_format",
      sql`${table.payloadHash} ~ '^[0-9a-f]{64}$'`
    ),
    uniqueIndex("sync_commands_organization_command_unique").on(
      table.organizationId,
      table.commandId
    ),
    index("sync_commands_organization_received_idx").on(
      table.organizationId,
      table.receivedAt
    ),
    pgPolicy("sync_commands_current_tenant_select", {
      for: "select",
      to: runtimeRole,
      using: sql`
        ${table.organizationId} = NULLIF(current_setting('app.organization_id', true), '')
        AND EXISTS (
          SELECT 1 FROM public.memberships AS membership_scope
          WHERE membership_scope.organization_id = ${table.organizationId}
            AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
            AND membership_scope.status = 'active'
        )
      `,
    }),
    pgPolicy("sync_commands_current_tenant_insert", {
      for: "insert",
      to: runtimeRole,
      withCheck: sql`
        ${table.organizationId} = NULLIF(current_setting('app.organization_id', true), '')
        AND ${table.userId} = NULLIF(current_setting('app.user_id', true), '')
        AND EXISTS (
          SELECT 1 FROM public.memberships AS membership_scope
          WHERE membership_scope.organization_id = ${table.organizationId}
            AND membership_scope.user_id = ${table.userId}
            AND membership_scope.status = 'active'
        )
        AND EXISTS (
          SELECT 1 FROM public.organizations AS organization_scope
          WHERE organization_scope.id = ${table.organizationId}
            AND organization_scope.status = 'active'
        )
      `,
    }),
  ]
).enableRLS();
