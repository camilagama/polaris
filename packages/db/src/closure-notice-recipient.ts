import { Pool } from "pg";
import { guardPoolErrors } from "./pool-errors";

/**
 * Where a closure notice goes (ADR 0102 amended): the one function
 * of the authentication role that answers an address, `closure_notice_recipient`. It answers only for a notice still
 * owed, by its ID and organization, the e-mail of the user the notice is for (joined with the notice, never a free
 * read of the users), and only when that e-mail is verified. The name is never read. The address goes straight to the
 * provider: never to a log, an error or an event.
 */
export type ClosureNoticeRecipient =
  | { email: string; verified: true }
  | { verified: false };

export interface ClosureNoticeRecipientClient {
  close: () => Promise<void>;
  /** Null when the notice is not owed any more (sent, failed, skipped, dismissed) or names no user. */
  recipient: (
    noticeId: string,
    organizationId: string
  ) => Promise<ClosureNoticeRecipient | null>;
}

interface RecipientRow {
  email?: unknown;
  verified?: unknown;
}

export function createClosureNoticeRecipientClient(
  connectionString: string
): ClosureNoticeRecipientClient {
  const pool = guardPoolErrors(
    new Pool({
      connectionString,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 5000,
      max: 1,
    })
  );
  return {
    close: () => pool.end(),
    async recipient(noticeId, organizationId) {
      // clock_timestamp() makes the statement volatile, so a pooler that caches reads never answers it
      const result = await pool.query<{ recipient: RecipientRow | null }>(
        "SELECT public.closure_notice_recipient($1::uuid, $2::text) AS recipient, pg_catalog.clock_timestamp() AS at",
        [noticeId, organizationId]
      );
      const row = result.rows[0]?.recipient;
      if (!row) {
        return null;
      }
      if (
        row.verified === true &&
        typeof row.email === "string" &&
        row.email.length > 0
      ) {
        return { email: row.email, verified: true };
      }
      return { verified: false };
    },
  };
}
