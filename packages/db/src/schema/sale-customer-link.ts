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
import { customers } from "./customer";
import { activeTenantScope } from "./product";
import { sales } from "./sale";

const runtimeRole = "polaris_pr11_runtime";

/**
 * Append-only attribution history of a confirmed sale. Each row is one version:
 * `assign`, `reassign` or `unassign` (customer is null only for `unassign`). The
 * current attribution is the row with the highest version; a sale with no rows
 * has never had a customer. Rows are never updated or deleted, and the sale's
 * economic rows are not touched.
 */
export const saleCustomerLinks = pgTable(
  "sale_customer_links",
  {
    action: text("action").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    customerId: uuid("customer_id"),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    organizationId: text("organization_id").notNull(),
    saleId: uuid("sale_id").notNull(),
    version: integer("version").notNull(),
  },
  (table) => [
    check(
      "sale_customer_links_action_allowed",
      sql`${table.action} IN ('assign', 'reassign', 'unassign')`
    ),
    check("sale_customer_links_version_positive", sql`${table.version} >= 1`),
    check(
      "sale_customer_links_customer_matches_action",
      sql`
        (${table.action} = 'unassign' AND ${table.customerId} IS NULL)
        OR (${table.action} <> 'unassign' AND ${table.customerId} IS NOT NULL)
      `
    ),
    check(
      "sale_customer_links_first_version_assigns",
      sql`${table.version} > 1 OR ${table.action} = 'assign'`
    ),
    foreignKey({
      columns: [table.organizationId, table.saleId],
      foreignColumns: [sales.organizationId, sales.id],
      name: "sale_customer_links_organization_sale_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.customerId],
      foreignColumns: [customers.organizationId, customers.id],
      name: "sale_customer_links_organization_customer_fk",
    }).onDelete("restrict"),
    uniqueIndex("sale_customer_links_organization_sale_version_unique").on(
      table.organizationId,
      table.saleId,
      table.version
    ),
    index("sale_customer_links_organization_customer_idx").on(
      table.organizationId,
      table.customerId,
      table.saleId
    ),
    pgPolicy("sale_customer_links_current_tenant_select", {
      for: "select",
      to: runtimeRole,
      using: activeTenantScope(table.organizationId),
    }),
    pgPolicy("sale_customer_links_current_tenant_insert", {
      for: "insert",
      to: runtimeRole,
      withCheck: activeTenantScope(table.organizationId),
    }),
  ]
).enableRLS();
