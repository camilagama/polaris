import { Pool } from "pg";
import { guardPoolErrors } from "./pool-errors";

/**
 * The preference of the "tips for getting started" for the person's own session (ADR 0106, D8): the two functions of
 * migration 0134, which only the tenant runtime executes. They work on the same row of `email_opt_outs` that the
 * one-click page writes through `activation_record_opt_out`, so both doors tell the same story. The person is always
 * the one of the session, taken by the server, never a value the client sends.
 */
export interface ActivationPreference {
  /** How many tips went out to the person, in every store of theirs. */
  sent: number;
  /** False when the person asked not to receive them. */
  tips: boolean;
}

/** The read: the function of migration 0134, with the person as its one parameter. */
export const ACTIVATION_PREFERENCE_STATEMENT =
  "SELECT public.activation_email_preference($1::text) AS preference";

/** The write: turns the tips on or off and answers the state after, in the shape of the read. */
export const ACTIVATION_SET_TIPS_STATEMENT =
  "SELECT public.activation_set_tips($1::text, $2::boolean) AS preference";

/** Reads what a function of migration 0134 answered; anything but its two fields is a defect, not a state. */
export function parseActivationPreference(
  value: unknown
): ActivationPreference {
  if (typeof value === "object" && value !== null) {
    const { sent, tips } = value as { sent?: unknown; tips?: unknown };
    if (
      typeof tips === "boolean" &&
      typeof sent === "number" &&
      Number.isInteger(sent) &&
      sent >= 0
    ) {
      return { sent, tips };
    }
  }
  throw new Error("The activation preference has an unexpected shape.");
}

export interface ActivationPreferenceClient {
  close: () => Promise<void>;
  read: (userId: string) => Promise<ActivationPreference>;
  setTips: (userId: string, on: boolean) => Promise<ActivationPreference>;
}

export function createActivationPreferenceClient(
  connectionString: string
): ActivationPreferenceClient {
  const pool = guardPoolErrors(
    new Pool({
      connectionString,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 5000,
      max: 1,
      // one row each way: a statement held longer than this answers the screen "try again" instead of the Worker's limit
      query_timeout: 5000,
    })
  );
  return {
    close: () => pool.end(),
    async read(userId) {
      const answer = await pool.query<{ preference: unknown }>(
        ACTIVATION_PREFERENCE_STATEMENT,
        [userId]
      );
      return parseActivationPreference(answer.rows[0]?.preference);
    },
    async setTips(userId, on) {
      const answer = await pool.query<{ preference: unknown }>(
        ACTIVATION_SET_TIPS_STATEMENT,
        [userId, on]
      );
      return parseActivationPreference(answer.rows[0]?.preference);
    },
  };
}
