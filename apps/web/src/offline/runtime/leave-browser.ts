import { clearFirstSteps } from "../../app-shell/first-steps";
import {
  browserStorage,
  clearOrganizationsCache,
} from "../../lib/current-organization-model";
import { clearOrganizationsClosedHere } from "../../lib/organization-closed";
import { clearPaymentProfileCaches } from "../../lib/payment-profile-cache";
import { clearPeriodSummaryCaches } from "../../lib/period-summary-cache";
import { writeSessionMarker } from "../../lib/session-marker";
import { clearClosedStores } from "../../organization/closed-stores-memory";
import { markSigningOut } from "../../lib/sign-out";
import {
  clearSaleAttempts,
  sessionStorageOrNull,
} from "../../sales/sale-attempt-storage";
import { clearSaleDrafts } from "../../sales/sale-draft-storage";
import { clearPlanNotice } from "../../subscription/plan-notice";
import type { SignInPath } from "../../lib/sign-in-path";

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
  clearClosedStores(browserStorage());
  clearOrganizationsClosedHere();
  clearPaymentProfileCaches(browserStorage());
  clearPeriodSummaryCaches(browserStorage());
  clearPlanNotice();
  clearFirstSteps();
  clearSaleDrafts(sessionStorageOrNull());
  clearSaleAttempts(sessionStorageOrNull());
}

/** Leaves the page, forgetting what the session left in this browser. */
export type LeavePath = "/" | SignInPath;

export function leaveTo(path: LeavePath): void {
  forgetSessionCaches();
  window.location.assign(path);
}

/**
 * Leaves after the person chose "Sair" and the session was ended on purpose: the next opening without a session
 * says "Você saiu", not "Sua sessão acabou" (U-01).
 */
export function leaveAfterSignOut(path: LeavePath): void {
  writeSessionMarker("saiu");
  leaveTo(path);
}
