import { sql } from "drizzle-orm";
import type { TenantRequestTransaction } from "./tenant-transaction";

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

/**
 * The read: the function of migration 0134, with the person as its one parameter. The gate runs this text; the
 * functions below build the same text with drizzle, and the router test holds the two together.
 */
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

async function runPreference(
  transaction: TenantRequestTransaction,
  query: ReturnType<typeof sql>
): Promise<ActivationPreference> {
  const answer = await transaction.execute(query);
  return parseActivationPreference(answer.rows[0]?.preference);
}

/** Reads the preference on the connection and in the transaction the caller already holds: no connection of its own. */
export function readActivationPreference(
  transaction: TenantRequestTransaction,
  userId: string
): Promise<ActivationPreference> {
  return runPreference(
    transaction,
    sql`SELECT public.activation_email_preference(${userId}::text) AS preference`
  );
}

/** Turns the tips on or off in the transaction the caller already holds, and answers the state after. */
export function setActivationTips(
  transaction: TenantRequestTransaction,
  userId: string,
  on: boolean
): Promise<ActivationPreference> {
  return runPreference(
    transaction,
    sql`SELECT public.activation_set_tips(${userId}::text, ${on}::boolean) AS preference`
  );
}
