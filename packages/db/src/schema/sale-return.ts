import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { activeTenantScope } from "./product";
import { saleItems, sales } from "./sale";

const runtimeRole = "polaris_pr11_runtime";

/**
 * A partial return of a confirmed sale: a compensatory, append-only record.
 * The sale and its original movements are never edited. A sale can have many
 * returns, until every unit has been returned; a cancelled sale has none.
 */
export const saleReturns = pgTable(
  "sale_returns",
  {
    commandId: uuid("command_id").notNull(),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    organizationId: text("organization_id").notNull(),
    reasonCode: text("reason_code"),
    reasonNote: text("reason_note"),
    returnedAt: timestamp("returned_at", { withTimezone: true }).defaultNow().notNull(),
    returnedBy: text("returned_by").notNull(),
    saleId: uuid("sale_id").notNull(),
  },
  (table) => [
    check(
      "sale_returns_returned_by_not_blank",
      sql`char_length(btrim(${table.returnedBy})) BETWEEN 1 AND 255`
    ),
    check(
      "sale_returns_reason_valid",
      sql`
        (${table.reasonCode} IS NULL AND ${table.reasonNote} IS NULL)
        OR (
          ${table.reasonCode} IN ('customer_request', 'defective', 'wrong_item', 'other')
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
      name: "sale_returns_organization_sale_fk",
    }).onDelete("restrict"),
    uniqueIndex("sale_returns_organization_command_unique").on(
      table.organizationId,
      table.commandId
    ),
    uniqueIndex("sale_returns_organization_id_id_sale_unique").on(
      table.organizationId,
      table.id,
      table.saleId
    ),
    index("sale_returns_organization_sale_idx").on(
      table.organizationId,
      table.saleId,
      table.returnedAt
    ),
    pgPolicy("sale_returns_current_tenant_select", {
      for: "select",
      to: runtimeRole,
      using: activeTenantScope(table.organizationId),
    }),
    pgPolicy("sale_returns_current_tenant_insert", {
      for: "insert",
      to: runtimeRole,
      withCheck: sql`
        ${activeTenantScope(table.organizationId)}
        AND ${table.returnedBy} = NULLIF(current_setting('app.user_id', true), '')
      `,
    }),
  ]
).enableRLS();

/**
 * One line of a return, identified by the position of the sale item. The
 * returned quantity and the quantity that goes back to sellable stock are kept
 * separately: `restocked <= returned`.
 */
export const saleReturnItems = pgTable(
  "sale_return_items",
  {
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    itemPosition: integer("item_position").notNull(),
    organizationId: text("organization_id").notNull(),
    restockedQuantity: integer("restocked_quantity").notNull(),
    returnId: uuid("return_id").notNull(),
    returnedQuantity: integer("returned_quantity").notNull(),
    saleId: uuid("sale_id").notNull(),
  },
  (table) => [
    check(
      "sale_return_items_position_nonnegative",
      sql`${table.itemPosition} >= 0`
    ),
    check(
      "sale_return_items_returned_positive",
      sql`${table.returnedQuantity} >= 1`
    ),
    check(
      "sale_return_items_restocked_within_returned",
      sql`${table.restockedQuantity} >= 0 AND ${table.restockedQuantity} <= ${table.returnedQuantity}`
    ),
    foreignKey({
      columns: [table.organizationId, table.returnId, table.saleId],
      foreignColumns: [
        saleReturns.organizationId,
        saleReturns.id,
        saleReturns.saleId,
      ],
      name: "sale_return_items_organization_return_sale_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.saleId, table.itemPosition],
      foreignColumns: [
        saleItems.organizationId,
        saleItems.saleId,
        saleItems.position,
      ],
      name: "sale_return_items_organization_sale_item_fk",
    }).onDelete("restrict"),
    uniqueIndex("sale_return_items_organization_return_position_unique").on(
      table.organizationId,
      table.returnId,
      table.itemPosition
    ),
    index("sale_return_items_organization_sale_position_idx").on(
      table.organizationId,
      table.saleId,
      table.itemPosition
    ),
    pgPolicy("sale_return_items_current_tenant_select", {
      for: "select",
      to: runtimeRole,
      using: activeTenantScope(table.organizationId),
    }),
    pgPolicy("sale_return_items_current_tenant_insert", {
      for: "insert",
      to: runtimeRole,
      withCheck: activeTenantScope(table.organizationId),
    }),
  ]
).enableRLS();
