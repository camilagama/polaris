import { BILLING_NOTICE_KINDS } from "@polaris/domain/billing/notices";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { organizations } from "./organization";

const billingRuntimeRole = "polaris_billing_runtime";
const billingOwnerRole = "polaris_billing_owner";
const purgeOwnerRole = "polaris_purge_owner";
const noticeRecipientOwnerRole = "polaris_notice_recipient_owner";

const kindList = BILLING_NOTICE_KINDS.map((kind) => `'${kind}'`).join(", ");

/**
 * The notices of the billing cycle and the welcome (ADR 0104, decision 7; design t268 v2, §8 and §9): one row per
 * notice, recorded in the same transaction as the change of the billing record that causes it (or by the hourly
 * sweep), with an outbox event `billing.notice` that names it. One per store, kind and `dedupe_key` (an opaque
 * reference, a date or an ID: the same transition twice records one), and one welcome per person.
 *
 * The row holds IDs, dates and short codes, never the e-mail: the consumer reads the address when it sends, through
 * `billing_notice_recipient` (the authentication role), and marks the outcome. A billing notice has no user: it goes to
 * the oldest active owner of the store at the time it is sent. The welcome has the person it is for, and leaves with
 * that person's account (foreign key in cascade: the purge of the users who never verified the e-mail takes it).
 *
 * Under FORCE ROW LEVEL SECURITY (the migration says so) with no policy for the tenant: the billing role records,
 * reads and marks them (column grants of the migration), the purge removes those of the store with the rest of its
 * data, the owner of the recipient's function sees only the notices still owed, and the owner of the welcome's sweep
 * sees only who already has a welcome.
 */
export const billingNotices = pgTable(
  "billing_notices",
  {
    /** One notice per store and kind: the provider's link, a date of the record, the ledger row or the user. */
    dedupeKey: text("dedupe_key").notNull(),
    /** Not to go out before this instant: a receipt and a cancellation wait for the fact that would suppress them. */
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    /** A short code of why the provider refused the e-mail; never a message or an address. */
    failureCode: text("failure_code"),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    kind: text("kind").notNull(),
    /** Restrictive on purpose: the purge keeps the store's row and deletes the notices in a step of its own. */
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    /** Why the consumer did not send it (no longer true, no recipient, the e-mail off): a short code. */
    skippedReason: text("skipped_reason"),
    /** Only for the welcome: the person it is for (an internal ID, never a name or an e-mail). */
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    unique("billing_notices_dedupe_unique").on(
      table.organizationId,
      table.kind,
      table.dedupeKey
    ),
    // one welcome per person, whatever the store
    uniqueIndex("billing_notices_welcome_user_unique")
      .on(table.userId)
      .where(sql`${table.kind} = 'welcome'`),
    // the cascade from the user's account (only the welcome has one)
    index("billing_notices_user_idx")
      .on(table.userId)
      .where(sql`${table.userId} IS NOT NULL`),
    check(
      "billing_notices_kind_allowed",
      sql.raw(`"billing_notices"."kind" IN (${kindList})`)
    ),
    check(
      "billing_notices_user_only_for_welcome",
      sql`(${table.kind} = 'welcome') = (${table.userId} IS NOT NULL)`
    ),
    // an opaque key: no space, no control character, no "@" (never an e-mail), short
    check(
      "billing_notices_dedupe_key_format",
      sql`char_length(${table.dedupeKey}) BETWEEN 1 AND 200 AND ${table.dedupeKey} !~ '[[:space:][:cntrl:]@]'`
    ),
    check(
      "billing_notices_outcome_coherent",
      sql`(CASE WHEN ${table.sentAt} IS NULL THEN 0 ELSE 1 END
          + CASE WHEN ${table.failedAt} IS NULL THEN 0 ELSE 1 END
          + CASE WHEN ${table.skippedReason} IS NULL THEN 0 ELSE 1 END) <= 1
        AND ((${table.failedAt} IS NULL) = (${table.failureCode} IS NULL))`
    ),
    check(
      "billing_notices_codes_format",
      sql`(${table.failureCode} IS NULL OR ${table.failureCode} ~ '^[a-z][a-z0-9_]{0,63}$')
        AND (${table.skippedReason} IS NULL OR ${table.skippedReason} ~ '^[a-z][a-z0-9_]{0,63}$')`
    ),
    pgPolicy("billing_notices_billing_runtime_select", {
      for: "select",
      to: billingRuntimeRole,
      using: sql`true`,
    }),
    // recorded owed: the outcome is written later, once
    pgPolicy("billing_notices_billing_runtime_insert", {
      for: "insert",
      to: billingRuntimeRole,
      withCheck: sql`${table.sentAt} IS NULL AND ${table.failedAt} IS NULL AND ${table.skippedReason} IS NULL`,
    }),
    // the outcome of a notice still owed
    pgPolicy("billing_notices_billing_runtime_update", {
      for: "update",
      to: billingRuntimeRole,
      using: sql`${table.sentAt} IS NULL AND ${table.failedAt} IS NULL AND ${table.skippedReason} IS NULL`,
      withCheck: sql`true`,
    }),
    // who already has a welcome: the welcome's sweep (`welcome_notice_candidates`)
    pgPolicy("billing_notices_billing_owner_select_welcome", {
      for: "select",
      to: billingOwnerRole,
      using: sql`${table.kind} = 'welcome'`,
    }),
    pgPolicy("billing_notices_recipient_owner_select_owed", {
      for: "select",
      to: noticeRecipientOwnerRole,
      using: sql`${table.sentAt} IS NULL AND ${table.failedAt} IS NULL AND ${table.skippedReason} IS NULL`,
    }),
    pgPolicy("billing_notices_purge_owner_select", {
      for: "select",
      to: purgeOwnerRole,
      using: sql`EXISTS (SELECT 1 FROM public.organizations AS purge_scope WHERE purge_scope.id = ${table.organizationId} AND purge_scope.status = 'purge_pending')`,
    }),
    pgPolicy("billing_notices_purge_owner_delete", {
      for: "delete",
      to: purgeOwnerRole,
      using: sql`EXISTS (SELECT 1 FROM public.organizations AS purge_scope WHERE purge_scope.id = ${table.organizationId} AND purge_scope.status = 'purge_pending')`,
    }),
  ]
).enableRLS();
