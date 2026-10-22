import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  pgPolicy,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/** Better Auth's runtime (0041): the whole of `session`, with no `app.*` setting on its connection. */
const authRuntimeRole = "polaris_auth_runtime";
/** Owns `end_device_sessions()` (0078): only the sessions of the user of the call, by `app.owner_scope.*` (0097). */
const deviceSessionOwnerRole = "polaris_device_session_owner";
/** Owns `purge_unverified_users()` (0093): reads `user_id` to keep a user who has a session. */
const unverifiedUserOwnerRole = "polaris_unverified_user_owner";
const deviceSessionUserScope = sql`NULLIF(pg_catalog.current_setting('app.owner_scope.device_session_user_id', true), '')`;

export const user = pgTable("user", {
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  id: text("id").primaryKey(),
  image: text("image"),
  name: text("name").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
  /**
   * When the last e-mail link to verify the address stops working, by the database clock, written by the
   * server each time it sends one (never read from the e-mail). The purge of the users who never verified
   * waits for it (ADR 0100, P10): while a link is still valid the account is kept. Null: no link was sent.
   */
  verificationLinkExpiresAt: timestamp("verification_link_expires_at", {
    withTimezone: true,
  }),
});

export const session = pgTable(
  "session",
  {
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    id: text("id").primaryKey(),
    ipAddress: text("ip_address"),
    token: text("token").notNull().unique(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  // Row security with FORCE (0097): one policy per role with a grant, none TO PUBLIC; a role that gets a grant one day and
  // no policy sees no row. `"user"`, `account`, `verification` and `auth_security_audit_event` still have none (the next task).
  (table) => [
    index("session_user_id_idx").on(table.userId),
    pgPolicy("session_auth_runtime_all", {
      for: "all",
      to: authRuntimeRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
    pgPolicy("session_unverified_user_owner_select", {
      for: "select",
      to: unverifiedUserOwnerRole,
      using: sql`true`,
    }),
    pgPolicy("session_device_session_owner_select", {
      for: "select",
      to: deviceSessionOwnerRole,
      using: sql`${table.userId} = ${deviceSessionUserScope}`,
    }),
    pgPolicy("session_device_session_owner_delete", {
      for: "delete",
      to: deviceSessionOwnerRole,
      using: sql`${table.userId} = ${deviceSessionUserScope}`,
    }),
  ]
).enableRLS();

export const account = pgTable(
  "account",
  {
    accessToken: text("access_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    accountId: text("account_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    id: text("id").primaryKey(),
    idToken: text("id_token"),
    password: text("password"),
    providerId: text("provider_id").notNull(),
    refreshToken: text("refresh_token"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
    }),
    scope: text("scope"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("account_user_id_idx").on(table.userId)]
);

export const verification = pgTable(
  "verification",
  {
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    value: text("value").notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)]
);

export const authSchema = { account, session, user, verification };
