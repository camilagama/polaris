/**
 * The shapes the page reads, as the routes of this cut answer them. Types only: nothing of a server package enters
 * the script. The diagnostics are the domain's own report and the funnel is its contract; the list, `whoami` and the
 * support cases are written here because their types live next to the database, and the refund window because the
 * page reads its codes as text (an unknown state or method is shown as unknown). `src/ui/ui-types.test.ts` fails if
 * a shape here and the server's drift apart.
 */

export type { ActivationFunnelResponse } from "@polaris/contracts/admin-activation-funnel";
export type { OrganizationDiagnostics } from "@polaris/domain/admin/organization-diagnostics";

export interface OrganizationSummary {
  accessEndsAt: string | null;
  billingState: string;
  createdAt: string;
  id: string;
  name: string;
  planInForce: string;
  status: string;
}

export interface OrganizationPage {
  next: string | null;
  organizations: OrganizationSummary[];
}

export interface WhoAmI {
  capabilities: string[];
  principal: { emailSnapshot: string | null; id: string; role: string };
}

/** One case of `GET /api/support-cases`, as the support repository lists it. */
export interface SupportCaseSummary {
  closedAt: string | null;
  id: string;
  kind: string;
  openedAt: string;
  organizationId: string;
  organizationName: string;
  reason: string;
  status: string;
}

export interface SupportCasePage {
  cases: SupportCaseSummary[];
  next: string | null;
}

/** What `POST /api/support-cases` answers with the case it opened. */
export interface OpenedSupportCase {
  id: string;
  kind: string;
  openedAt: string;
  organizationId: string;
  reason: string;
  status: string;
}

/** What `POST /api/support-cases/:caseId/refund-window` answers: the domain's view, computed on the database clock. */
export interface RefundWindowView {
  firstChargeAmount: string | null;
  firstChargeAt: string | null;
  method: string | null;
  now: string;
  refundable: boolean;
  refundRequestedAt: string | null;
  request: {
    at: string;
    completable: boolean;
    completableUntil: string;
  } | null;
  state: string;
  window: { open: boolean; until: string } | null;
}
