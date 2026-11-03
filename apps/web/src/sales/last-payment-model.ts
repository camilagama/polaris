import type { PreferenceStorage } from "../lib/current-organization-model";
import {
  NO_PROFILE_CHOICE,
  SALE_METHOD_CARDS,
  type SaleFormState,
  type SaleMethod,
  type SalePreset,
} from "./sale-form-model";

/**
 * The method and the payment profile of the last sale this device recorded for the store, offered on the next sale
 * as the choice already made: at the counter they almost never change. Like the remembered prices, only
 * convenience: the server never reads them, a changed profile still asks to review the preview, and losing them
 * costs one more touch.
 */
export interface RememberedPayment {
  method: SaleMethod;
  /** Null is the sale made with "Sem perfil". */
  profile: { id: string; version: number } | null;
}

const KEY_PREFIX = "polaris.sale.lastPayment.v1:";
const METHODS = new Set<string>(SALE_METHOD_CARDS.map(([method]) => method));

export function lastPaymentKey(organizationId: string): string {
  return `${KEY_PREFIX}${organizationId}`;
}

function isProfile(value: unknown): value is { id: string; version: number } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { id, version } = value as Record<string, unknown>;
  return (
    typeof id === "string" &&
    id !== "" &&
    id !== NO_PROFILE_CHOICE &&
    typeof version === "number" &&
    Number.isInteger(version) &&
    version >= 0
  );
}

/** Reads what was remembered; anything unreadable is simply not remembered. */
export function readLastPayment(
  storage: PreferenceStorage | null,
  organizationId: string
): RememberedPayment | null {
  try {
    const text = storage?.getItem(lastPaymentKey(organizationId));
    if (!text) {
      return null;
    }
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const { method, profile } = parsed as Record<string, unknown>;
    if (typeof method !== "string" || !METHODS.has(method)) {
      return null;
    }
    if (profile !== null && !isProfile(profile)) {
      return null;
    }
    return { method: method as SaleMethod, profile };
  } catch {
    return null;
  }
}

export function writeLastPayment(
  storage: PreferenceStorage | null,
  organizationId: string,
  payment: RememberedPayment
): void {
  try {
    storage?.setItem(lastPaymentKey(organizationId), JSON.stringify(payment));
  } catch {
    // a full or blocked storage only costs the convenience
  }
}

/**
 * What a sale the device just recorded leaves to remember, from the form it was sent with; null when the form had
 * no method or profile settled (it never reaches here, the evaluation refuses it first).
 */
export function paymentOfSentForm(
  form: SaleFormState
): RememberedPayment | null {
  const { method } = form.payment;
  const { choice, seenVersion } = form.profile;
  if (method === "" || choice === "") {
    return null;
  }
  if (choice === NO_PROFILE_CHOICE) {
    return { method, profile: null };
  }
  return seenVersion === null
    ? null
    : { method, profile: { id: choice, version: seenVersion } };
}

/**
 * The choices a new sale starts with: the last sale's method and profile, or "Sem perfil" in a store that has no
 * active profile (null count: not read yet). The remembered profile keeps the version it was used with, so a profile
 * that changed since asks for "Revisei a prévia atualizada" again, and one that left the list is cleared with its
 * notice.
 */
export function salePresetFrom(
  remembered: RememberedPayment | null,
  activeProfileCount: number | null
): SalePreset {
  const method = remembered?.method ?? "";
  if (remembered?.profile) {
    return {
      method,
      profileChoice: remembered.profile.id,
      profileVersion: remembered.profile.version,
    };
  }
  const noProfile = remembered !== null || activeProfileCount === 0;
  return {
    method,
    profileChoice: noProfile ? NO_PROFILE_CHOICE : "",
    profileVersion: null,
  };
}
