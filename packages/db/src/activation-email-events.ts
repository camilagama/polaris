import { Pool } from "pg";
import { hexOf } from "./activation-notice-store";
import { guardPoolErrors } from "./pool-errors";

/**
 * The write of the provider's webhook (ADR 0106, D7): `activation_record_email_event` of migration 0135, which only the
 * billing runtime executes. One call is one transaction in the database: the event once by its `svix-id`, one
 * suppression per HMAC and, for a complaint, the stop of the series. It takes HMACs and a key identifier, never an
 * address, and answers counts and flags, never a row.
 */
export type ActivationEmailEventKind = "bounce" | "complaint";

export interface ActivationEmailEvent {
  /** HMACs of the normalized addresses, at most 50; empty when none can be normalized (a complaint still stops). */
  hmacs: readonly Uint8Array[];
  /** The identifier of the secret the HMACs were computed with. */
  keyId: string;
  kind: ActivationEmailEventKind;
  /** The `svix-id` of the delivery: the key of the inbox. */
  eventId: string;
}

export type ActivationEmailEventOutcome =
  | { duplicate: true }
  | { duplicate: false; stopped: boolean; suppressed: number };

/** The statement: the HMACs go as hexadecimal text and are decoded in the database. */
export const ACTIVATION_EMAIL_EVENT_STATEMENT = `SELECT public.activation_record_email_event(
  $1::text, $2::text, $3::text,
  ARRAY(SELECT pg_catalog.decode(hex, 'hex') FROM unnest($4::text[]) AS hex)
) AS outcome`;

/** Reads what the function answered; anything but its two shapes is a defect of the database, not a state. */
export function parseActivationEmailEventOutcome(
  value: unknown
): ActivationEmailEventOutcome {
  if (typeof value === "object" && value !== null) {
    const { duplicate, stopped, suppressed } = value as {
      duplicate?: unknown;
      stopped?: unknown;
      suppressed?: unknown;
    };
    if (duplicate === true) {
      return { duplicate: true };
    }
    if (
      duplicate === false &&
      typeof stopped === "boolean" &&
      typeof suppressed === "number" &&
      Number.isInteger(suppressed) &&
      suppressed >= 0
    ) {
      return { duplicate: false, stopped, suppressed };
    }
  }
  throw new Error("The activation email event has an unexpected shape.");
}

export interface ActivationEmailEventRecorder {
  close: () => Promise<void>;
  record: (event: ActivationEmailEvent) => Promise<ActivationEmailEventOutcome>;
}

export function createActivationEmailEventRecorder(
  connectionString: string
): ActivationEmailEventRecorder {
  const pool = guardPoolErrors(
    new Pool({
      connectionString,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 5000,
      max: 1,
      // a few rows in one transaction: a statement held longer than this is answered 503 and the provider sends again
      query_timeout: 5000,
    })
  );
  return {
    close: () => pool.end(),
    async record(event) {
      const answer = await pool.query<{ outcome: unknown }>(
        ACTIVATION_EMAIL_EVENT_STATEMENT,
        [event.eventId, event.kind, event.keyId, event.hmacs.map(hexOf)]
      );
      return parseActivationEmailEventOutcome(answer.rows[0]?.outcome);
    },
  };
}
