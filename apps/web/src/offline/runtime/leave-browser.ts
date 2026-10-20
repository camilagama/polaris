import {
  browserStorage,
  clearOrganizationsCache,
} from "../../lib/current-organization-model";
import { clearPaymentProfileCaches } from "../../lib/payment-profile-cache";
import { clearPeriodSummaryCaches } from "../../lib/period-summary-cache";
import type { SignInPath } from "../../lib/sign-in-path";
import { markSigningOut } from "../../lib/sign-out";

/**
 * The session is over: the next person to open this browser must not be offered
 * these organizations. The queue is not touched (it belongs to the user's own
 * namespace and stays for their next session).
 */
export function forgetSessionCaches(): void {
  markSigningOut();
  clearSessionCaches();
}

/**
 * Drops the copies a session left in the browser without marking the page as leaving: a refusal of one
 * call does not say the person will not come back, and a screen that is signed in again (in another tab)
 * has to be able to keep its copies anew.
 */
export function clearSessionCaches(): void {
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
