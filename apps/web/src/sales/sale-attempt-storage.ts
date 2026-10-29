import type { PreferenceStorage } from "../lib/current-organization-model";
import type { SaleAttempt } from "./sale-form-model";

/**
 * The unconfirmed sale attempt (command ID, commercial instant, payload
 * signature) survives a page reload, so retyping the same sale after a lost
 * response reuses the same command ID and the server replays the sale it
 * already stored instead of recording a second one. It lives in sessionStorage
 * (one tab) and expires quickly: an old attempt must never swallow a new,
 * identical sale. The one exception is an attempt whose outcome is unknown
 * (sent, no answer) whose cart came back from the tab's draft: see
 * `readSaleAttempt`.
 */
export const SALE_ATTEMPT_MAX_AGE_MS = 30 * 60 * 1000;

const KEY_PREFIX = "polaris.sale.attempt.v1:";

function attemptKey(organizationId: string): string {
  return `${KEY_PREFIX}${organizationId}`;
}

type StoredAttempt = SaleAttempt & { unsettled?: boolean };

function isAttempt(value: unknown): value is StoredAttempt {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { commandId, occurredAt, recordedAt, signature } = value as Record<
    string,
    unknown
  >;
  return (
    typeof commandId === "string" &&
    typeof occurredAt === "string" &&
    typeof recordedAt === "string" &&
    typeof signature === "string" &&
    commandId.length > 0 &&
    signature.length > 0
  );
}

/**
 * `draftStartedAt` is set when the cart came back from the tab's draft (`sale-draft-storage.ts`): an attempt whose
 * outcome is unknown then lasts as long as that draft, since the same cart is still there and confirming it again must
 * reach the sale the server may already have. Only an attempt made after the draft started counts (an older one
 * belongs to another cart), and only an unsettled one: after a definite refusal, a retry hours later must not carry the
 * instant of the first click.
 */
export function readSaleAttempt(
  storage: PreferenceStorage | null,
  organizationId: string,
  now: Date,
  draftStartedAt: string | null = null
): SaleAttempt | null {
  try {
    const text = storage?.getItem(attemptKey(organizationId));
    if (!text) {
      return null;
    }
    const parsed: unknown = JSON.parse(text);
    if (!isAttempt(parsed)) {
      return null;
    }
    const recordedAt = new Date(parsed.recordedAt).getTime();
    const age = now.getTime() - recordedAt;
    const keptByDraft =
      parsed.unsettled === true &&
      draftStartedAt !== null &&
      recordedAt >= new Date(draftStartedAt).getTime();
    if (
      !Number.isFinite(age) ||
      age < 0 ||
      (age > SALE_ATTEMPT_MAX_AGE_MS && !keptByDraft)
    ) {
      storage?.removeItem(attemptKey(organizationId));
      return null;
    }
    const { commandId, occurredAt, signature } = parsed;
    return { commandId, occurredAt, recordedAt: parsed.recordedAt, signature };
  } catch {
    return null;
  }
}

/**
 * Stores the attempt, or forgets it when null. `unsettled` while it is sent or its outcome is unknown. Failure only
 * loses the safety net.
 */
export function writeSaleAttempt(
  storage: PreferenceStorage | null,
  organizationId: string,
  attempt: SaleAttempt | null,
  unsettled = false
): void {
  try {
    if (attempt === null) {
      storage?.removeItem(attemptKey(organizationId));
    } else {
      const stored: StoredAttempt = { ...attempt, unsettled };
      storage?.setItem(attemptKey(organizationId), JSON.stringify(stored));
    }
  } catch {
    // Storage can be full or blocked; the in-memory attempt still works.
  }
}

export function sessionStorageOrNull(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
