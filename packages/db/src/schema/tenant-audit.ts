import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organization";

const runtimeRole = "polaris_pr11_runtime";

export const tenantAuditEvents = pgTable(
  "tenant_audit_event",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").notNull(),
    eventType: text("event_type").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    requestId: uuid("request_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "tenant_audit_actor_nonempty",
      sql`btrim(${table.actorUserId}) <> ''`
    ),
    check("tenant_audit_type_nonempty", sql`btrim(${table.eventType}) <> ''`),
    check(
      "tenant_audit_entity_type_nonempty",
      sql`btrim(${table.entityType}) <> ''`
    ),
    check(
      "tenant_audit_entity_id_nonempty",
      sql`btrim(${table.entityId}) <> ''`
    ),
    index("tenant_audit_event_org_created_idx").on(
      table.organizationId,
      table.createdAt
    ),
    index("tenant_audit_event_request_idx").on(table.requestId),
    pgPolicy("tenant_audit_event_current_actor_insert", {
      for: "insert",
      to: runtimeRole,
      withCheck: sql`
        ${table.organizationId} = NULLIF(current_setting('app.organization_id', true), '')
        AND ${table.actorUserId} = NULLIF(current_setting('app.user_id', true), '')
        AND EXISTS (
          SELECT 1
          FROM public.memberships AS membership_scope
          WHERE membership_scope.organization_id = ${table.organizationId}
            AND membership_scope.user_id = ${table.actorUserId}
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
