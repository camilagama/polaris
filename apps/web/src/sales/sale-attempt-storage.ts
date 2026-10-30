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
 * `readSaleAttemptState`.
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

function sentProfileOf(value: unknown): SaleAttempt["paymentProfile"] {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const { expectedVersion, id } = value as Record<string, unknown>;
  return typeof id === "string" &&
    id.length > 0 &&
    typeof expectedVersion === "number" &&
    Number.isInteger(expectedVersion)
    ? { expectedVersion, id }
    : undefined;
}

export interface SaleAttemptRead {
  attempt: SaleAttempt;
  /**
   * Sent and with no answer, made for the cart that came back from the tab: that cart may already be a sale on the
   * server, so it must go again exactly as it was sent.
   */
  outcomeUnknown: boolean;
  /** Sent with no answer and not settled since, in this cart or not: the sale may be on the server. */
  unsettled: boolean;
}

/**
 * `draftStartedAt` is set when the cart came back from the tab's draft (`sale-draft-storage.ts`): an attempt whose
 * outcome is unknown then lasts as long as that draft, since the same cart is still there and confirming it again must
 * reach the sale the server may already have. Only an attempt made after the draft started counts (an older one
 * belongs to another cart), and only an unsettled one: after a definite refusal, a retry hours later must not carry the
 * instant of the first click.
 */
export function readSaleAttemptState(
  storage: PreferenceStorage | null,
  organizationId: string,
  now: Date,
  draftStartedAt: string | null = null
): SaleAttemptRead | null {
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
    const ofThisCart =
      parsed.unsettled === true &&
      draftStartedAt !== null &&
      recordedAt >= new Date(draftStartedAt).getTime();
    if (
      !Number.isFinite(age) ||
      age < 0 ||
      (age > SALE_ATTEMPT_MAX_AGE_MS && !ofThisCart)
    ) {
      storage?.removeItem(attemptKey(organizationId));
      return null;
    }
    const { commandId, occurredAt, signature } = parsed;
    const paymentProfile = sentProfileOf(parsed.paymentProfile);
    return {
      attempt: {
        commandId,
        occurredAt,
        recordedAt: parsed.recordedAt,
        signature,
        ...(paymentProfile ? { paymentProfile } : {}),
      },
      outcomeUnknown: ofThisCart,
      unsettled: parsed.unsettled === true,
    };
  } catch {
    return null;
  }
}

export function readSaleAttempt(
  storage: PreferenceStorage | null,
  organizationId: string,
  now: Date,
  draftStartedAt: string | null = null
): SaleAttempt | null {
  return (
    readSaleAttemptState(storage, organizationId, now, draftStartedAt)
      ?.attempt ?? null
  );
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

type AttemptStorage = PreferenceStorage &
  Partial<Pick<Storage, "key" | "length">>;

function isUnsettledAttempt(text: string | null): boolean {
  try {
    const parsed: unknown = text === null ? null : JSON.parse(text);
    return isAttempt(parsed) && parsed.unsettled === true;
  } catch {
    return false;
  }
}

/**
 * Forgets the attempts of every store of this tab, but the one kept (the store just chosen): they go with the drafts
 * they were made for, on "Sair", a refused session and a change of store. `keepUnsettled` leaves the attempts sent with
 * no answer: on a change of store the sale may already be on the server, and the same cart typed again after coming
 * back must reach it with the same command ID (it still expires with `SALE_ATTEMPT_MAX_AGE_MS`).
 */
export function clearSaleAttempts(
  storage: AttemptStorage | null,
  keepOrganizationId: string | null = null,
  keepUnsettled = false
): void {
  try {
    if (!storage?.key || storage.length === undefined) {
      return;
    }
    const keep =
      keepOrganizationId === null ? null : attemptKey(keepOrganizationId);
    const found: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (
        key?.startsWith(KEY_PREFIX) &&
        key !== keep &&
        !(keepUnsettled && isUnsettledAttempt(storage.getItem(key)))
      ) {
        found.push(key);
      }
    }
    for (const key of found) {
      storage.removeItem(key);
    }
  } catch {
    // a blocked storage holds no attempt
  }
}

export function sessionStorageOrNull(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
