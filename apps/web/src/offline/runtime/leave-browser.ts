import {
  browserStorage,
  clearOrganizationsCache,
} from "../../lib/current-organization-model";
import { clearPaymentProfileCaches } from "../../lib/payment-profile-cache";
import { clearPeriodSummaryCaches } from "../../lib/period-summary-cache";
import { markSigningOut } from "../../lib/sign-out";

/** Why the sign-in screen is opened: the login is only old, or the session is already gone. */
export type SignInReason = "recente" | "sessao";

/** Where the sign-in screen sends the person back to after the login. */
const DEVICES_PATH = "/devices" as const;

export type SignInPath =
  `/entrar?motivo=${SignInReason}&voltar=${typeof DEVICES_PATH}`;

export function signInPath(reason: SignInReason): SignInPath {
  return `/entrar?motivo=${reason}&voltar=${DEVICES_PATH}`;
}

/**
 * The session is over: the next person to open this browser must not be offered
 * these organizations. The queue is not touched (it belongs to the user's own
 * namespace and stays for their next session).
 */
export function forgetSessionCaches(): void {
  markSigningOut();
  clearOrganizationsCache(browserStorage());
  clearPaymentProfileCaches(browserStorage());
  clearPeriodSummaryCaches(browserStorage());
}

/** Leaves the page, forgetting what the session left in this browser. */
export type LeavePath = "/" | SignInPath;

export function leaveTo(path: LeavePath): void {
  forgetSessionCaches();
  window.location.assign(path);
}
