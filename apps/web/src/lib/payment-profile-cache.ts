import {
  type PaymentProfileReadModel,
  paymentProfileReadModelSchema,
} from "@polaris/contracts";
import type { PreferenceStorage } from "./current-organization-model";

/**
 * The active payment profiles of an organization as of the last time the sale
 * screen read them with a connection, kept so a sale made without one can still
 * be priced with the person's profile (fees and term). It is a convenience for
 * drawing the screen, never proof of anything: the sale names the profile by id
 * and by the version the person saw, and the server refuses it when that is not
 * the current version. The copy goes away with the session (sign-out or an
 * "unauthorized" answer), like the cached organizations (ADR 0047).
 */
const KEY_PREFIX = "polaris.offline.paymentProfiles.";

const keyOf = (organizationId: string) => `${KEY_PREFIX}${organizationId}`;

export function writePaymentProfileCache(
  storage: PreferenceStorage | null,
  organizationId: string,
  profiles: readonly PaymentProfileReadModel[]
): void {
  try {
    storage?.setItem(keyOf(organizationId), JSON.stringify(profiles));
  } catch {
    // Without it the sale screen only loses the profiles offline.
  }
}

/** The cached active profiles, or none when missing, corrupt or not the contract's shape. */
export function readPaymentProfileCache(
  storage: PreferenceStorage | null,
  organizationId: string
): PaymentProfileReadModel[] {
  try {
    const parsed: unknown = JSON.parse(
      storage?.getItem(keyOf(organizationId)) ?? "[]"
    );
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((item) => {
      const checked = paymentProfileReadModelSchema.safeParse(item);
      return checked.success && checked.data.status === "active"
        ? [checked.data]
        : [];
    });
  } catch {
    return [];
  }
}

/** Forgets the profiles of every organization (the session ended). */
export function clearPaymentProfileCaches(
  preference: PreferenceStorage | null
): void {
  try {
    // the browser storage also lists its keys; a narrower fake may not
    const storage = preference as
      | (PreferenceStorage & Partial<Pick<Storage, "key" | "length">>)
      | null;
    if (
      !storage ||
      typeof storage.key !== "function" ||
      typeof storage.length !== "number"
    ) {
      return;
    }
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(KEY_PREFIX)) {
        keys.push(key);
      }
    }
    for (const key of keys) {
      storage.removeItem(key);
    }
  } catch {
    // Nothing to clean when storage is unavailable.
  }
}
