import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { activeTenantScope } from "./product";
import { sales } from "./sale";

const runtimeRole = "polaris_pr11_runtime";

/**
 * Whole-sale cancellation: a compensatory, append-only record. The confirmed
 * sale and its original movements stay untouched; the inverse ledger movements
 * (type `sale_cancellation`) are written in the same transaction. A sale can be
 * cancelled once, and a command ID is unique per organization.
 */
export const saleCancellations = pgTable(
  "sale_cancellations",
  {
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }).defaultNow().notNull(),
    cancelledBy: text("cancelled_by").notNull(),
    commandId: uuid("command_id").notNull(),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    organizationId: text("organization_id").notNull(),
    reasonCode: text("reason_code"),
    reasonNote: text("reason_note"),
    saleId: uuid("sale_id").notNull(),
  },
  (table) => [
    check(
      "sale_cancellations_cancelled_by_not_blank",
      sql`char_length(btrim(${table.cancelledBy})) BETWEEN 1 AND 255`
    ),
    check(
      "sale_cancellations_reason_valid",
      sql`
        (${table.reasonCode} IS NULL AND ${table.reasonNote} IS NULL)
        OR (
          ${table.reasonCode} IN ('customer_request', 'entry_error', 'payment_issue', 'other')
          AND (
            ${table.reasonNote} IS NULL
            OR char_length(btrim(${table.reasonNote})) BETWEEN 1 AND 500
          )
          AND (${table.reasonCode} <> 'other' OR ${table.reasonNote} IS NOT NULL)
        )
      `
    ),
    foreignKey({
      columns: [table.organizationId, table.saleId],
      foreignColumns: [sales.organizationId, sales.id],
      name: "sale_cancellations_organization_sale_fk",
    }).onDelete("restrict"),
    uniqueIndex("sale_cancellations_organization_sale_unique").on(
      table.organizationId,
      table.saleId
    ),
    uniqueIndex("sale_cancellations_organization_command_unique").on(
      table.organizationId,
      table.commandId
    ),
    uniqueIndex("sale_cancellations_organization_id_id_unique").on(
      table.organizationId,
      table.id
    ),
    pgPolicy("sale_cancellations_current_tenant_select", {
      for: "select",
      to: runtimeRole,
      using: activeTenantScope(table.organizationId),
    }),
    pgPolicy("sale_cancellations_current_tenant_insert", {
      for: "insert",
      to: runtimeRole,
      withCheck: sql`
        ${activeTenantScope(table.organizationId)}
        AND ${table.cancelledBy} = NULLIF(current_setting('app.user_id', true), '')
      `,
    }),
  ]
).enableRLS();
