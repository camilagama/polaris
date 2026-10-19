import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  pgPolicy,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const loginLockOwnerRole = "polaris_login_lock_owner";

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() {
    return "bytea";
  },
});

/**
 * The lock of the sign-in by password (ADR 0100, entry screen P2): 5 failures in 15 minutes lock the
 * e-mail typed for 15 minutes. One row per e-mail typed, whether an account exists or not, so the answer
 * to a locked e-mail is the same either way. The key is the HMAC-SHA-256 (lowercase hex) of the
 * normalized e-mail, with its own scope and the Better Auth secret: the table never holds the e-mail in
 * the clear, a user ID or an IP, and rotating the secret only zeroes counters that live one day.
 *
 * Not a tenant table and without a foreign key. No runtime role reads or writes it: only
 * `polaris_login_lock_owner` has privileges (and the only policy), and the functions it owns, executed by
 * the authentication runtime, are the whole interface (`auth_login_lock_begin` reserves the attempt
 * before the password is checked). The expiry removes rows untouched for a day.
 */
export const authLoginLock = pgTable(
  "auth_login_lock",
  {
    attempts: smallint("attempts").default(0).notNull(),
    emailKey: text("email_key").primaryKey(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    /** SHA-256 of the unlock token: the token itself is never stored. */
    unlockTokenExpiresAt: timestamp("unlock_token_expires_at", {
      withTimezone: true,
    }),
    unlockTokenSha256: bytea("unlock_token_sha256"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "auth_login_lock_email_key_format",
      sql`${table.emailKey} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "auth_login_lock_attempts_range",
      sql`${table.attempts} BETWEEN 0 AND 5`
    ),
    check(
      "auth_login_lock_unlock_token_length",
      sql`${table.unlockTokenSha256} IS NULL OR octet_length(${table.unlockTokenSha256}) = 32`
    ),
    check(
      "auth_login_lock_unlock_token_coherent",
      sql`(${table.unlockTokenSha256} IS NULL) = (${table.unlockTokenExpiresAt} IS NULL)`
    ),
    // the unlock looks the row up by the token hash
    uniqueIndex("auth_login_lock_unlock_token_idx")
      .on(table.unlockTokenSha256)
      .where(sql`${table.unlockTokenSha256} IS NOT NULL`),
    // the expiry cuts by date
    index("auth_login_lock_updated_idx").on(table.updatedAt),
    pgPolicy("auth_login_lock_owner_all", {
      for: "all",
      to: loginLockOwnerRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ]
).enableRLS();
