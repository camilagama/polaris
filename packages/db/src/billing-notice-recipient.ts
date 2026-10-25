import { Pool } from "pg";
import type { ClosureNoticeRecipient } from "./closure-notice-recipient";
import { guardPoolErrors } from "./pool-errors";

/**
 * Where a billing notice goes (ADR 0104, decision 7): the authentication role's `billing_notice_recipient`, the one
 * function that answers the address. Only for a notice still owed of that store: the welcome's person, or the oldest
 * active owner of the store for a notice of the billing cycle (never the payer of the Pix), and only when that e-mail is
 * verified. The name is never read. The address goes straight to the provider: never to a log, an error or an event.
 */
export type BillingNoticeRecipient = ClosureNoticeRecipient;

export interface BillingNoticeRecipientClient {
  close: () => Promise<void>;
  /** Null when the notice is not owed any more or has nobody to go to (the store purged, the person gone). */
  recipient: (
    noticeId: string,
    organizationId: string
  ) => Promise<BillingNoticeRecipient | null>;
}

interface RecipientRow {
  email?: unknown;
  verified?: unknown;
}

export function createBillingNoticeRecipientClient(
  connectionString: string
): BillingNoticeRecipientClient {
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
      // named arguments: the store comes first in the function, the notice first here. clock_timestamp() makes the
      // statement volatile, so a pooler that caches reads never answers it
      const result = await pool.query<{ recipient: RecipientRow | null }>(
        "SELECT public.billing_notice_recipient(p_organization => $2::text, p_notice => $1::uuid) AS recipient, pg_catalog.clock_timestamp() AS at",
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
