import { Pool } from "pg";
import { guardPoolErrors } from "./pool-errors";

/**
 * The one write of the page that stops the tips e-mails (ADR 0106, D8): `activation_record_opt_out` of migration 0129,
 * which the billing role only executes. It answers nothing, and ends the same for a person already recorded and for one
 * that does not exist, so the caller has nothing to tell apart.
 */
/** The one statement: the function of migration 0129, with the person as its one parameter. */
export const ACTIVATION_OPT_OUT_STATEMENT =
  "SELECT public.activation_record_opt_out($1::text)";

export interface ActivationOptOutWriter {
  close: () => Promise<void>;
  record: (userId: string) => Promise<void>;
}

export function createActivationOptOutWriter(
  connectionString: string
): ActivationOptOutWriter {
  const pool = guardPoolErrors(
    new Pool({
      connectionString,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 5000,
      max: 1,
      // a write of one row: a statement held longer than this answers the page "try again" instead of the Worker's limit
      query_timeout: 5000,
    })
  );
  return {
    close: () => pool.end(),
    async record(userId) {
      await pool.query(ACTIVATION_OPT_OUT_STATEMENT, [userId]);
    },
  };
}
