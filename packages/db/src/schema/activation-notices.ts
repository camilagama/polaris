import { sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  index,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { memberships } from "./organization";

const billingRuntimeRole = "polaris_billing_runtime";
const activationNoticeOwnerRole = "polaris_activation_notice_owner";
const purgeOwnerRole = "polaris_purge_owner";

/** The three e-mails of the series (ADR 0106, D4). */
export const ACTIVATION_NOTICE_STEPS = Object.freeze([
  "a1",
  "a2",
  "a3",
] as const);

const stepList = ACTIVATION_NOTICE_STEPS.map((step) => `'${step}'`).join(", ");

const owedNotice = (table: {
  failedAt: unknown;
  sentAt: unknown;
  skippedReason: unknown;
}) =>
  sql`${table.sentAt} IS NULL AND ${table.failedAt} IS NULL AND ${table.skippedReason} IS NULL`;

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});

/**
 * The notices of the activation series (ADR 0106, D1): one row per person and step, in the format of
 * `billing_notices` but apart from it (another legal basis, an opt-out, another reading role). IDs, dates and short
 * codes, never an address, a name or a text: every text column refuses "@". The person and the store are one
 * membership (composite foreign key in cascade), so the row leaves with the membership, which the purge of the store
 * deletes and which the deletion of the account must delete first.
 *
 * Under FORCE ROW LEVEL SECURITY with no policy for the tenant: the billing role records, reads and marks them, the
 * owner of the series reads them (column grants of the migration), and the purge owner sees those of a store being
 * purged.
 */
export const activationNotices = pgTable(
  "activation_notices",
  {
    /** Not to go out before this instant: the trigger of the step. */
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    /** A short code of why the provider refused the e-mail; never a message or an address. */
    failureCode: text("failure_code"),
    /** When the consumer first went to send it (the database's clock): the provider's idempotency window counts from here. */
    firstAttemptedAt: timestamp("first_attempted_at", { withTimezone: true }),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    lastAttemptedAt: timestamp("last_attempted_at", { withTimezone: true }),
    organizationId: text("organization_id").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    /** Why it did not go out (a stop rule, expired, suppressed): a short code. */
    skippedReason: text("skipped_reason"),
    step: text("step").notNull(),
    userId: text("user_id").notNull(),
  },
  (table) => [
    // one e-mail of each step per person, whatever the store (the first store of the person is the one)
    unique("activation_notices_user_step_unique").on(table.userId, table.step),
    foreignKey({
      columns: [table.organizationId, table.userId],
      foreignColumns: [memberships.organizationId, memberships.userId],
      name: "activation_notices_membership_fk",
    }).onDelete("cascade"),
    // the cascade from the membership looks rows up by store first
    index("activation_notices_organization_user_idx").on(
      table.organizationId,
      table.userId
    ),
    check(
      "activation_notices_step_allowed",
      sql.raw(`"activation_notices"."step" IN (${stepList})`)
    ),
    check(
      "activation_notices_ids_format",
      sql`${table.organizationId} !~ '[[:space:][:cntrl:]@]' AND ${table.userId} !~ '[[:space:][:cntrl:]@]'`
    ),
    check(
      "activation_notices_outcome_coherent",
      sql`(CASE WHEN ${table.sentAt} IS NULL THEN 0 ELSE 1 END
          + CASE WHEN ${table.failedAt} IS NULL THEN 0 ELSE 1 END
          + CASE WHEN ${table.skippedReason} IS NULL THEN 0 ELSE 1 END) <= 1
        AND ((${table.failedAt} IS NULL) = (${table.failureCode} IS NULL))
        AND ((${table.firstAttemptedAt} IS NULL) = (${table.lastAttemptedAt} IS NULL))`
    ),
    check(
      "activation_notices_codes_format",
      sql`(${table.failureCode} IS NULL OR ${table.failureCode} ~ '^[a-z][a-z0-9_]{0,63}$')
        AND (${table.skippedReason} IS NULL OR ${table.skippedReason} ~ '^[a-z][a-z0-9_]{0,63}$')`
    ),
    pgPolicy("activation_notices_billing_runtime_select", {
      for: "select",
      to: billingRuntimeRole,
      using: sql`true`,
    }),
    // recorded owed and untried: the outcome is written later, once
    pgPolicy("activation_notices_billing_runtime_insert", {
      for: "insert",
      to: billingRuntimeRole,
      withCheck: sql`${owedNotice(table)} AND ${table.firstAttemptedAt} IS NULL`,
    }),
    pgPolicy("activation_notices_billing_runtime_update", {
      for: "update",
      to: billingRuntimeRole,
      using: owedNotice(table),
      withCheck: sql`true`,
    }),
    pgPolicy("activation_notices_owner_select", {
      for: "select",
      to: activationNoticeOwnerRole,
      using: sql`true`,
    }),
    pgPolicy("activation_notices_purge_owner_select", {
      for: "select",
      to: purgeOwnerRole,
      using: sql`EXISTS (SELECT 1 FROM public.organizations AS purge_scope WHERE purge_scope.id = ${table.organizationId} AND purge_scope.status = 'purge_pending')`,
    }),
  ]
).enableRLS();

/**
 * Who asked not to receive the e-mails sent on legitimate interest (ADR 0106, D8): the person and when, valid in every
 * store of that person. The row leaves with the account (foreign key in cascade); deleting it turns the e-mails back on.
 * Forced row security, no policy for the tenant.
 */
export const emailOptOuts = pgTable(
  "email_opt_outs",
  {
    optedOutAt: timestamp("opted_out_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    check(
      "email_opt_outs_user_format",
      sql`${table.userId} !~ '[[:space:][:cntrl:]@]'`
    ),
    pgPolicy("email_opt_outs_billing_runtime_select", {
      for: "select",
      to: billingRuntimeRole,
      using: sql`true`,
    }),
    pgPolicy("email_opt_outs_owner_select", {
      for: "select",
      to: activationNoticeOwnerRole,
      using: sql`true`,
    }),
  ]
).enableRLS();

/**
 * Addresses the series no longer writes to, after a bounce or a complaint (ADR 0106, D8 and D11): the HMAC-SHA256 of
 * the normalized address under a key of its own, never the address, and no link to an account (it outlives the account
 * and holds for another account with the same address). The database has no key and gets no address: the Worker
 * computes the HMAC. Re-keying rewrites the HMAC and keeps `recorded_at` (the retention counts from it).
 */
export const activationEmailSuppressions = pgTable(
  "activation_email_suppressions",
  {
    addressHmac: bytea("address_hmac").notNull(),
    reason: text("reason").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.addressHmac, table.reason],
      name: "activation_email_suppressions_pk",
    }),
    check(
      "activation_email_suppressions_hmac_length",
      sql`octet_length(${table.addressHmac}) = 32`
    ),
    check(
      "activation_email_suppressions_reason_allowed",
      sql`${table.reason} IN ('bounce', 'complaint')`
    ),
    pgPolicy("activation_email_suppressions_billing_runtime_select", {
      for: "select",
      to: billingRuntimeRole,
      using: sql`true`,
    }),
    pgPolicy("activation_email_suppressions_billing_runtime_insert", {
      for: "insert",
      to: billingRuntimeRole,
      withCheck: sql`true`,
    }),
    pgPolicy("activation_email_suppressions_billing_runtime_update", {
      for: "update",
      to: billingRuntimeRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ]
).enableRLS();
