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
/** Owns `purge_unverified_users()` (0093): only the users never verified, and what it reads of them (0098). */
const unverifiedUserOwnerRole = "polaris_unverified_user_owner";
/** Owns `create_initial_organization()` (0095): only the user of the call, by `app.owner_scope.*`, to lock it. */
const onboardingOwnerRole = "polaris_onboarding_owner";
/** Owns the two functions of the closure notices (0091): only the user of the notice of the call (0098). */
const noticeRecipientOwnerRole = "polaris_notice_recipient_owner";
const deviceSessionUserScope = sql`NULLIF(pg_catalog.current_setting('app.owner_scope.device_session_user_id', true), '')`;
const onboardingUserScope = sql`NULLIF(pg_catalog.current_setting('app.owner_scope.onboarding_user_id', true), '')`;
const noticeRecipientNoticeScope = sql`NULLIF(pg_catalog.current_setting('app.owner_scope.notice_recipient_notice_id', true), '')`;
/** The same predicate as the candidates of `purge_unverified_users()`: the owner never sees a verified user's rows. */
const ofUnverifiedUser = (userId: unknown) =>
  sql`EXISTS (SELECT 1 FROM public."user" AS u WHERE u.id = ${userId} AND NOT u.email_verified)`;

// Row security with FORCE (0098), as on session: one policy per role with a grant, each TO its role, none TO PUBLIC. Better
// Auth's runtime keeps every row (it has no `app.*` setting); each owner sees only the rows its function is about.
export const user = pgTable(
  "user",
  {
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
  },
  (table) => [
    pgPolicy("user_auth_runtime_all", {
      for: "all",
      to: authRuntimeRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
    pgPolicy("user_unverified_user_owner_select", {
      for: "select",
      to: unverifiedUserOwnerRole,
      using: sql`NOT ${table.emailVerified}`,
    }),
    // UPDATE only for the lock (FOR UPDATE SKIP LOCKED): the check is false, so no row is ever changed
    pgPolicy("user_unverified_user_owner_lock", {
      for: "update",
      to: unverifiedUserOwnerRole,
      using: sql`NOT ${table.emailVerified}`,
      withCheck: sql`false`,
    }),
    pgPolicy("user_unverified_user_owner_delete", {
      for: "delete",
      to: unverifiedUserOwnerRole,
      using: sql`NOT ${table.emailVerified}`,
    }),
    pgPolicy("user_onboarding_owner_select", {
      for: "select",
      to: onboardingOwnerRole,
      using: sql`${table.id} = ${onboardingUserScope}`,
    }),
    // UPDATE only for the lock (FOR SHARE): the check is false, so no row is ever changed
    pgPolicy("user_onboarding_owner_lock", {
      for: "update",
      to: onboardingOwnerRole,
      using: sql`${table.id} = ${onboardingUserScope}`,
      withCheck: sql`false`,
    }),
    // the notice by its ID as text (a malformed setting is false, never an error), and only while the owner sees it (owed)
    pgPolicy("user_notice_recipient_owner_select", {
      for: "select",
      to: noticeRecipientOwnerRole,
      using: sql`EXISTS (SELECT 1 FROM public.closure_notices AS n WHERE n.id::text = ${noticeRecipientNoticeScope} AND n.user_id = ${table.id})`,
    }),
  ]
).enableRLS();

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
  // no policy sees no row. The purge owner sees only the sessions of users never verified (0098).
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
      using: ofUnverifiedUser(table.userId),
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
  // Row security with FORCE (0098): the purge owner sees only the accounts of users never verified, the same predicate as
  // its candidates, so it never hides an account of a candidate (its NOT EXISTS stays closed)
  (table) => [
    index("account_user_id_idx").on(table.userId),
    pgPolicy("account_auth_runtime_all", {
      for: "all",
      to: authRuntimeRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
    pgPolicy("account_unverified_user_owner_select", {
      for: "select",
      to: unverifiedUserOwnerRole,
      using: ofUnverifiedUser(table.userId),
    }),
  ]
).enableRLS();

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
  // Row security with FORCE (0098): Better Auth's runtime only
  (table) => [
    index("verification_identifier_idx").on(table.identifier),
    pgPolicy("verification_auth_runtime_all", {
      for: "all",
      to: authRuntimeRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ]
).enableRLS();

export const authSchema = { account, session, user, verification };
