import { Pool } from "pg";
import { guardPoolErrors } from "./pool-errors";

/**
 * What the background job does to the users who never verified the e-mail (ADR 0100, Q-D2): it deletes, through
 * `purge_unverified_users`, at most `limit` of the ones that meet every condition together (e-mail not verified,
 * no account but `credential`, no session, no membership, created more than 24 hours ago). The function is the
 * whole interface: it holds the conditions, writes the audit (no e-mail) and belongs to a role of its own.
 */
export interface AuthUnverifiedUserMaintenanceClient {
  close: () => Promise<void>;
  /** Deletes at most `limit` users that meet every condition and says how many. */
  purge: (limit: number) => Promise<number>;
}

export function createAuthUnverifiedUserMaintenanceClient(
  connectionString: string
): AuthUnverifiedUserMaintenanceClient {
  const pool = guardPoolErrors(
    new Pool({
      connectionString,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 5000,
      max: 1,
    })
  );
  return {
    async close() {
      await pool.end();
    },
    async purge(limit) {
      const result = await pool.query<{ removed: number }>(
        "SELECT public.purge_unverified_users($1::integer) AS removed",
        [limit]
      );
      return Number(result.rows[0]?.removed ?? 0);
    },
  };
}
