import { sql } from "drizzle-orm";
import {
  check,
  integer,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

const legalAcceptanceOwnerRole = "polaris_legal_acceptance_owner";

/**
 * The acceptance of the terms of use and of the privacy policy (ADR 0100, entry screen P4): one row for
 * each document version a user accepted, with the SHA-256 of the text shown, the instant by the database
 * clock, where it was accepted (`signup` or `reaceite`) and the request ID. It never holds an IP or a
 * browser: the proof is that this user accepted this text, not where from.
 *
 * Per user, not per organization, and `user_id` is an opaque Better Auth ID without a foreign key, so a
 * row outlives the deletion of the user (kept 10 years after the account is deleted, retention class
 * `legal_acceptance`). Append-only: triggers refuse UPDATE, DELETE and TRUNCATE for every role. No runtime
 * role reads or writes the table: only `polaris_legal_acceptance_owner` has privileges on it, and its two
 * functions, executed by the authentication runtime, are the whole interface (`record_legal_acceptance`
 * appends, `legal_acceptance_versions` reads the highest version of each document a user accepted).
 */
export const legalAcceptance = pgTable(
  "legal_acceptance",
  {
    /** The database clock, never a value from the client. */
    acceptedAt: timestamp("accepted_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    document: text("document").notNull(),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    origin: text("origin").notNull(),
    requestId: text("request_id").notNull(),
    /** Computed by the server from the archived text; the client never sends it. */
    textSha256: text("text_sha256").notNull(),
    userId: text("user_id").notNull(),
    version: integer("version").notNull(),
  },
  (table) => [
    // also the lookup by user: `user_id` is its first column
    unique("legal_acceptance_user_document_version_key").on(
      table.userId,
      table.document,
      table.version
    ),
    check(
      "legal_acceptance_user_format",
      sql`${table.userId} ~ '^[A-Za-z0-9_-]{1,64}$'`
    ),
    check(
      "legal_acceptance_document_allowed",
      sql`${table.document} IN ('terms', 'privacy')`
    ),
    // a version number is a small counter of the texts: the cap leaves no room for a huge one that no minimum could pass
    check(
      "legal_acceptance_version_range",
      sql`${table.version} BETWEEN 1 AND 1000`
    ),
    check(
      "legal_acceptance_sha256_format",
      sql`${table.textSha256} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "legal_acceptance_origin_allowed",
      sql`${table.origin} IN ('signup', 'reaceite')`
    ),
    check(
      "legal_acceptance_request_format",
      sql`${table.requestId} ~ '^[A-Za-z0-9_-]{1,64}$'`
    ),
    pgPolicy("legal_acceptance_owner_insert", {
      for: "insert",
      to: legalAcceptanceOwnerRole,
      withCheck: sql`true`,
    }),
    pgPolicy("legal_acceptance_owner_select", {
      for: "select",
      to: legalAcceptanceOwnerRole,
      using: sql`true`,
    }),
  ]
).enableRLS();

const unverifiedUserOwnerRole = "polaris_unverified_user_owner";

/**
 * When the contract of a user ended, the date the 10 years of `legal_acceptance` count from (ADR 0100): one row
 * per user, by the database clock, with why it ended. The only writer today is `purge_unverified_users`, in the
 * same statement that deletes the user (`reason = 'unverified_user_deleted'`); the routine that deletes an
 * account will write the same row. Opaque `user_id`, no e-mail, no foreign key (the user is gone), append-only
 * (triggers refuse UPDATE, DELETE and TRUNCATE for every role), and no runtime role reads or writes it: the
 * expiry of the acceptance, when it exists, reads it as the owner of the acceptance.
 */
export const legalAcceptanceContractEnd = pgTable(
  "legal_acceptance_contract_end",
  {
    /** The database clock, never a value from the client. */
    endedAt: timestamp("ended_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    reason: text("reason").notNull(),
    userId: text("user_id").primaryKey(),
  },
  (table) => [
    check(
      "legal_acceptance_contract_end_user_format",
      sql`${table.userId} ~ '^[A-Za-z0-9_-]{1,64}$'`
    ),
    check(
      "legal_acceptance_contract_end_reason_allowed",
      sql`${table.reason} IN ('unverified_user_deleted')`
    ),
    pgPolicy("legal_acceptance_contract_end_unverified_user_insert", {
      for: "insert",
      to: unverifiedUserOwnerRole,
      withCheck: sql`true`,
    }),
  ]
).enableRLS();
