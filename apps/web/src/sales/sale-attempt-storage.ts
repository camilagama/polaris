import type { PreferenceStorage } from "../lib/current-organization-model";
import type { SaleAttempt } from "./sale-form-model";

/**
 * The unconfirmed sale attempt (command ID, commercial instant, payload
 * signature) survives a page reload, so retyping the same sale after a lost
 * response reuses the same command ID and the server replays the sale it
 * already stored instead of recording a second one. It lives in sessionStorage
 * (one tab) and expires quickly: an old attempt must never swallow a new,
 * identical sale.
 */
export const SALE_ATTEMPT_MAX_AGE_MS = 30 * 60 * 1000;

const KEY_PREFIX = "polaris.sale.attempt.v1:";

function attemptKey(organizationId: string): string {
  return `${KEY_PREFIX}${organizationId}`;
}

function isAttempt(value: unknown): value is SaleAttempt {
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
 * `draftStartedAt` is set when the cart of this attempt came back from the tab's draft (`sale-draft-storage.ts`):
 * the attempt then lasts as long as that draft, since retyping is not what happens, the same cart is still there.
 * Only an attempt made after the draft started counts; an older one belongs to another cart.
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
    return parsed;
  } catch {
    return null;
  }
}

/** Stores the attempt, or forgets it when null. Failure only loses the safety net. */
export function writeSaleAttempt(
  storage: PreferenceStorage | null,
  organizationId: string,
  attempt: SaleAttempt | null
): void {
  try {
    if (attempt === null) {
      storage?.removeItem(attemptKey(organizationId));
    } else {
      storage?.setItem(attemptKey(organizationId), JSON.stringify(attempt));
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
