import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
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
 * The change log a device pulls from (plan PR51). Rows are written only by the
 * SECURITY DEFINER trigger functions of the domain tables, in the same
 * transaction as the change they describe, so the runtime can read the log but
 * never forge or edit it. `seq` is assigned per organization at COMMIT, under a
 * per-organization lock, so sequence order is commit order and a reader that
 * advances its cursor can never skip a change that commits later.
 */
export const syncChanges = pgTable(
  "sync_changes",
  {
    changeKind: text("change_kind").default("upsert").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    entityId: uuid("entity_id").notNull(),
    entityType: text("entity_type").notNull(),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Null only inside the transaction that wrote the row; set before commit. */
    seq: bigint("seq", { mode: "number" }),
  },
  (table) => [
    check(
      "sync_changes_entity_type_allowed",
      sql`${table.entityType} IN ('category', 'customer', 'inventory_balance', 'payment_profile', 'product', 'sale')`
    ),
    check(
      "sync_changes_change_kind_allowed",
      sql`${table.changeKind} = 'upsert'`
    ),
    check(
      "sync_changes_seq_positive",
      sql`${table.seq} IS NULL OR ${table.seq} > 0`
    ),
    uniqueIndex("sync_changes_organization_seq_unique")
      .on(table.organizationId, table.seq)
      .where(sql`${table.seq} IS NOT NULL`),
    index("sync_changes_organization_entity_idx").on(
      table.organizationId,
      table.entityType,
      table.entityId
    ),
    pgPolicy("sync_changes_current_tenant_select", {
      for: "select",
      to: runtimeRole,
      using: sql`
        ${table.organizationId} = NULLIF(current_setting('app.organization_id', true), '')
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
      `,
    }),
  ]
).enableRLS();

/** The last sequence assigned per organization; only the triggers touch it. */
export const syncCursors = pgTable("sync_cursors", {
  lastSeq: bigint("last_seq", { mode: "number" }).default(0).notNull(),
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
}).enableRLS();
