import {
  ACTIVATION_NOTICE_REREAD_REASONS,
  type ActivationNoticeSkipReason,
} from "@polaris/domain/activation/notices";
import { logger } from "@polaris/observability/logger";
import { Pool } from "pg";
import { guardPoolErrors } from "./pool-errors";

/**
 * What the consumer of `activation.notice` reads and writes on the billing connection (ADR 0106): the notice still
 * owed, the database's re-read of it (`activation_notice_still_owed`, migration 0131), whether an address is
 * suppressed (`activation_address_suppressed`, migration 0135), and the outcome, written once. The billing runtime reads
 * the notices directly and no other table of the series' rules: those only through the re-read, which answers a code or
 * what the e-mail needs, and the suppressions only through the function that finds and re-keys them.
 */

export interface ActivationNoticeClaim {
  firstAttemptedAt: Date | null;
  userId: string;
}

export type ActivationNoticeStep = "a1" | "a2" | "a3";

/** The HMAC of one normalized address under one secret of the suppression, and the identifier of that secret. */
export interface ActivationSuppressionKey {
  hmac: Uint8Array;
  keyId: string;
}

/** The HMAC under the current secret and, while one is set, under the previous one. */
export interface ActivationSuppressionKeys {
  current: ActivationSuppressionKey;
  previous?: ActivationSuppressionKey;
}

/** The re-read: null when the notice is not owed any more; the first rule that stopped holding; or the e-mail's facts. */
export type ActivationNoticeReread =
  | null
  | { skip: (typeof ACTIVATION_NOTICE_REREAD_REASONS)[number] }
  | { hasProduct: boolean; step: ActivationNoticeStep; store: string };

export interface ActivationNoticeStore {
  /** Null when the notice is not owed (sent, failed, skipped), does not exist or is of another store. */
  claim: (
    noticeId: string,
    organizationId: string
  ) => Promise<ActivationNoticeClaim | null>;
  close: () => Promise<void>;
  /**
   * Whether the address is suppressed and still in force at `now`, for any reason; a row found under the previous
   * secret is re-keyed under the current one by the database. A database that does not have the function yet (the
   * Worker deployed before the migration) answers suppressed: nothing is sent without the check.
   */
  isSuppressed: (
    keys: ActivationSuppressionKeys,
    now: Date
  ) => Promise<boolean>;
  /** Writes the attempt (last always, first once) on its own, before the send, so it stays if the send throws. */
  markAttempted: (noticeId: string, organizationId: string) => Promise<boolean>;
  markFailed: (
    noticeId: string,
    organizationId: string,
    code: string
  ) => Promise<boolean>;
  markSent: (noticeId: string, organizationId: string) => Promise<boolean>;
  markSkipped: (
    noticeId: string,
    organizationId: string,
    reason: ActivationNoticeSkipReason
  ) => Promise<boolean>;
  stillOwed: (
    noticeId: string,
    organizationId: string,
    now: Date
  ) => Promise<ActivationNoticeReread>;
}

const NOTICE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OWED = "sent_at IS NULL AND failed_at IS NULL AND skipped_reason IS NULL";
const STEPS: readonly string[] = ["a1", "a2", "a3"];
const REREAD_CODES: readonly string[] = ACTIVATION_NOTICE_REREAD_REASONS;
const HMAC_BYTES = 32;
const KEY_ID = /^[0-9a-f]{8}$/;
const UNDEFINED_FUNCTION = "42883";

/** The statement of the suppression check: the function of migration 0135, the HMACs as hexadecimal text. */
export const ACTIVATION_ADDRESS_SUPPRESSED_STATEMENT = `SELECT public.activation_address_suppressed(
  p_current => pg_catalog.decode($1::text, 'hex'), p_current_key_id => $2::text,
  p_previous => pg_catalog.decode($3::text, 'hex'), p_previous_key_id => $4::text,
  p_now => $5::timestamptz) AS suppressed`;

export type ActivationSuppressionQuery = (
  statement: string,
  values: readonly (string | null)[]
) => Promise<{ rows: readonly { suppressed: boolean }[] }>;

function isRereadCode(
  value: unknown
): value is (typeof ACTIVATION_NOTICE_REREAD_REASONS)[number] {
  return typeof value === "string" && REREAD_CODES.includes(value);
}

function isStep(value: unknown): value is ActivationNoticeStep {
  return typeof value === "string" && STEPS.includes(value);
}

/** The function's answer, held to its three shapes: anything else is a fault of the database, never a send. */
export function parseActivationNoticeReread(
  answer: unknown
): ActivationNoticeReread {
  if (answer === null || answer === undefined) {
    return null;
  }
  if (typeof answer === "object" && !Array.isArray(answer)) {
    const shape = answer as Record<string, unknown>;
    if ("skip" in shape && isRereadCode(shape.skip)) {
      return { skip: shape.skip };
    }
    if (
      isStep(shape.step) &&
      typeof shape.hasProduct === "boolean" &&
      typeof shape.store === "string"
    ) {
      return {
        hasProduct: shape.hasProduct,
        step: shape.step,
        store: shape.store,
      };
    }
  }
  throw new Error("activation_notice_reread_unknown");
}

/** Lower-case hexadecimal of the bytes: the form the statements send an HMAC in. */
export function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
}

/** 42883 about this function only: the same code for another function missing inside a body is a defect, not a deploy order. */
function isMissingSuppressionFunction(error: unknown): boolean {
  const { code, message } = (error ?? {}) as {
    code?: unknown;
    message?: unknown;
  };
  return (
    code === UNDEFINED_FUNCTION &&
    typeof message === "string" &&
    message.includes("activation_address_suppressed")
  );
}

function assertSuppressionKey(key: ActivationSuppressionKey): void {
  if (key.hmac.length !== HMAC_BYTES || !KEY_ID.test(key.keyId)) {
    throw new Error("activation_suppression_hmac_invalid");
  }
}

/**
 * Asks the database whether the address is suppressed. SQLSTATE 42883 (the function does not exist, the Worker
 * deployed before the migration) counts as suppressed: failing closed sends nothing, whereas failing open could send to
 * whoever complained.
 */
export async function addressSuppressed(
  query: ActivationSuppressionQuery,
  keys: ActivationSuppressionKeys,
  now: Date
): Promise<boolean> {
  assertSuppressionKey(keys.current);
  if (keys.previous) {
    assertSuppressionKey(keys.previous);
  }
  try {
    const result = await query(ACTIVATION_ADDRESS_SUPPRESSED_STATEMENT, [
      hexOf(keys.current.hmac),
      keys.current.keyId,
      keys.previous ? hexOf(keys.previous.hmac) : null,
      keys.previous ? keys.previous.keyId : null,
      now.toISOString(),
    ]);
    return result.rows[0]?.suppressed === true;
  } catch (error) {
    if (isMissingSuppressionFunction(error)) {
      logger.warn("activation_suppression_function_missing", {
        outcome: "skipped",
      });
      return true;
    }
    throw error;
  }
}

export function createActivationNoticeStore(
  connectionString: string
): ActivationNoticeStore {
  const pool = guardPoolErrors(
    new Pool({
      connectionString,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 5000,
      max: 1,
    })
  );
  const markOwed = async (
    noticeId: string,
    organizationId: string,
    outcome:
      | { failureCode: string }
      | { sent: true }
      | { skippedReason: string }
  ): Promise<boolean> => {
    if (!NOTICE_ID.test(noticeId)) {
      return false;
    }
    // the columns are fixed text of this module; the code and the reason go as parameters
    let assignment = "sent_at = pg_catalog.now()";
    const values: string[] = [noticeId, organizationId];
    if ("failureCode" in outcome) {
      assignment = "failed_at = pg_catalog.now(), failure_code = $3";
      values.push(outcome.failureCode);
    } else if ("skippedReason" in outcome) {
      assignment = "skipped_reason = $3";
      values.push(outcome.skippedReason);
    }
    const result = await pool.query(
      `UPDATE public.activation_notices SET ${assignment}
        WHERE id = $1::uuid AND organization_id = $2 AND ${OWED}`,
      values
    );
    return (result.rowCount ?? 0) > 0;
  };
  return {
    async claim(noticeId, organizationId) {
      if (!NOTICE_ID.test(noticeId)) {
        return null;
      }
      const result = await pool.query<{
        first_attempted_at: Date | null;
        user_id: string;
      }>(
        `SELECT user_id, first_attempted_at FROM public.activation_notices
          WHERE id = $1::uuid AND organization_id = $2 AND ${OWED}`,
        [noticeId, organizationId]
      );
      const [row] = result.rows;
      return row
        ? { firstAttemptedAt: row.first_attempted_at, userId: row.user_id }
        : null;
    },
    close: () => pool.end(),
    isSuppressed(keys, now) {
      return addressSuppressed(
        (statement, values) =>
          pool.query<{ suppressed: boolean }>(statement, [...values]),
        keys,
        now
      );
    },
    async markAttempted(noticeId, organizationId) {
      if (!NOTICE_ID.test(noticeId)) {
        return false;
      }
      const result = await pool.query(
        `UPDATE public.activation_notices
            SET first_attempted_at = COALESCE(first_attempted_at, pg_catalog.clock_timestamp()),
                last_attempted_at = pg_catalog.clock_timestamp()
          WHERE id = $1::uuid AND organization_id = $2 AND ${OWED}`,
        [noticeId, organizationId]
      );
      return (result.rowCount ?? 0) > 0;
    },
    markFailed: (noticeId, organizationId, code) =>
      markOwed(noticeId, organizationId, { failureCode: code }),
    markSent: (noticeId, organizationId) =>
      markOwed(noticeId, organizationId, { sent: true }),
    markSkipped: (noticeId, organizationId, reason) =>
      markOwed(noticeId, organizationId, { skippedReason: reason }),
    async stillOwed(noticeId, organizationId, now) {
      if (!NOTICE_ID.test(noticeId)) {
        return null;
      }
      const result = await pool.query<{ answer: unknown }>(
        "SELECT public.activation_notice_still_owed(p_organization => $2::text, p_notice => $1::uuid, p_now => $3::timestamptz) AS answer",
        [noticeId, organizationId, now.toISOString()]
      );
      return parseActivationNoticeReread(result.rows[0]?.answer);
    },
  };
}
