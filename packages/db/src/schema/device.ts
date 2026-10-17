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
import { user } from "./auth";
import { memberships, organizations } from "./organization";

const runtimeRole = "polaris_pr11_runtime";

const currentUser = sql`NULLIF(current_setting('app.user_id', true), '')`;

/**
 * One browser installation of one user. Devices belong to the user, not to an
 * organization, so their policies only look at the session user. A device is not
 * an authentication factor and stores no fingerprint: a random id, an optional
 * label the user typed and timestamps.
 */
export const devices = pgTable(
  "devices",
  {
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    label: text("label"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    check(
      "devices_label_format",
      sql`${table.label} IS NULL OR (char_length(${table.label}) BETWEEN 1 AND 80 AND ${table.label} = btrim(${table.label}) AND ${table.label} !~ '[[:cntrl:]]')`
    ),
    index("devices_user_created_idx").on(table.userId, table.createdAt),
    uniqueIndex("devices_user_id_id_unique").on(table.userId, table.id),
    pgPolicy("devices_current_user_select", {
      for: "select",
      to: runtimeRole,
      using: sql`${table.userId} = ${currentUser}`,
    }),
    pgPolicy("devices_current_user_insert", {
      for: "insert",
      to: runtimeRole,
      withCheck: sql`${table.userId} = ${currentUser}`,
    }),
    pgPolicy("devices_current_user_update", {
      for: "update",
      to: runtimeRole,
      using: sql`${table.userId} = ${currentUser}`,
      withCheck: sql`${table.userId} = ${currentUser}`,
    }),
  ]
).enableRLS();

/**
 * The server-side record of an authorization lease issued to a device for one
 * organization. It lives at most 72 hours, can be revoked and never changes
 * otherwise. The signed lease the client keeps arrives with PR49; the server
 * keeps revalidating everything at sync time regardless.
 */
export const offlineGrants = pgTable(
  "offline_grants",
  {
    authorizationEpoch: integer("authorization_epoch").notNull(),
    deviceId: uuid("device_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    issuedAt: timestamp("issued_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
    userId: text("user_id").notNull(),
  },
  (table) => {
    const grantScope = sql`
      ${table.organizationId} = NULLIF(current_setting('app.organization_id', true), '')
      AND ${table.userId} = ${currentUser}
      AND EXISTS (
        SELECT 1
        FROM public.memberships AS membership_scope
        WHERE membership_scope.organization_id = ${table.organizationId}
          AND membership_scope.user_id = ${table.userId}
          AND membership_scope.status = 'active'
      )
      AND EXISTS (
        SELECT 1
        FROM public.organizations AS organization_scope
        WHERE organization_scope.id = ${table.organizationId}
          AND organization_scope.status = 'active'
      )
    `;

    return [
      foreignKey({
        columns: [table.userId, table.deviceId],
        foreignColumns: [devices.userId, devices.id],
        name: "offline_grants_user_device_fk",
      }).onDelete("cascade"),
      foreignKey({
        columns: [table.organizationId, table.userId],
        foreignColumns: [memberships.organizationId, memberships.userId],
        name: "offline_grants_membership_fk",
      }).onDelete("cascade"),
      check(
        "offline_grants_epoch_non_negative",
        sql`${table.authorizationEpoch} >= 0`
      ),
      check(
        "offline_grants_window",
        sql`${table.expiresAt} > ${table.issuedAt} AND ${table.expiresAt} <= ${table.issuedAt} + interval '72 hours'`
      ),
      check(
        "offline_grants_revocation_consistent",
        sql`(${table.revokedAt} IS NULL) = (${table.revokedReason} IS NULL) AND (${table.revokedReason} IS NULL OR ${table.revokedReason} IN ('device_revoked', 'user_revoked', 'security_event', 'organization_suspended', 'organization_closed'))`
      ),
      index("offline_grants_org_user_device_idx").on(
        table.organizationId,
        table.userId,
        table.deviceId,
        table.issuedAt
      ),
      index("offline_grants_device_idx").on(table.userId, table.deviceId),
      pgPolicy("offline_grants_current_tenant_select", {
        for: "select",
        to: runtimeRole,
        using: grantScope,
      }),
      pgPolicy("offline_grants_current_tenant_insert", {
        for: "insert",
        to: runtimeRole,
        withCheck: grantScope,
      }),
      pgPolicy("offline_grants_current_tenant_update", {
        for: "update",
        to: runtimeRole,
        using: grantScope,
        withCheck: grantScope,
      }),
    ];
  }
).enableRLS();
