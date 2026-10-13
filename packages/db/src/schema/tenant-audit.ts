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
    actorUserId: text("actor_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    entityId: text("entity_id").notNull(),
    entityType: text("entity_type").notNull(),
    eventType: text("event_type").notNull(),
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    requestId: uuid("request_id"),
  },
  (table) => [
    check(
      "tenant_audit_actor_id_length",
      sql`char_length(btrim(${table.actorUserId})) BETWEEN 1 AND 255`
    ),
    check(
      "tenant_audit_event_type_format",
      sql`char_length(${table.eventType}) BETWEEN 1 AND 128 AND ${table.eventType} ~ '^[a-z][a-z0-9_.-]*$'`
    ),
    check(
      "tenant_audit_entity_type_format",
      sql`char_length(${table.entityType}) BETWEEN 1 AND 64 AND ${table.entityType} ~ '^[a-z][a-z0-9_]*$'`
    ),
    check(
      "tenant_audit_entity_id_uuid",
      sql`char_length(${table.entityId}) = 36 AND ${table.entityId} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`
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
