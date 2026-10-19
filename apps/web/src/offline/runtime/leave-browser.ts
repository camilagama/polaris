import {
  browserStorage,
  clearOrganizationsCache,
} from "../../lib/current-organization-model";
import { clearPaymentProfileCaches } from "../../lib/payment-profile-cache";
import { clearPeriodSummaryCaches } from "../../lib/period-summary-cache";
import { markSigningOut } from "../../lib/sign-out";
import type { SignInPath } from "../../lib/sign-in-path";

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
