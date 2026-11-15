import { Pool } from "pg";
import { guardPoolErrors } from "./pool-errors";

/**
 * Where a tip of the activation series goes (ADR 0106, D2): the authentication role's `activation_notice_recipient`,
 * the one function that answers the address. Only for a notice still owed, of the oldest active owner of that store,
 * with the e-mail verified; null for anything else, with no reason. Never a member, an invitation or a typed address.
 * The address goes straight to the provider: never to a log, an error or an event.
 */
export interface ActivationNoticeRecipientClient {
  close: () => Promise<void>;
  recipient: (
    noticeId: string,
    organizationId: string
  ) => Promise<string | null>;
}

export function createActivationNoticeRecipientClient(
  connectionString: string
): ActivationNoticeRecipientClient {
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
      const result = await pool.query<{ recipient: unknown }>(
        "SELECT public.activation_notice_recipient(p_organization => $2::text, p_notice => $1::uuid) AS recipient, pg_catalog.clock_timestamp() AS at",
        [noticeId, organizationId]
      );
      const address = result.rows[0]?.recipient;
      return typeof address === "string" && address.length > 0 ? address : null;
    },
  };
}
