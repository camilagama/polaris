import type {
  AccessLogEntryView,
  AccessLogReadResult,
} from "@polaris/db/admin-access-log-repository";
import type { AdminOrganizationPage } from "@polaris/db/admin-diagnostics-repository";
import type {
  DeadEventSummary as ServerDeadEvent,
  IncidentRetryResult,
  OperationalIncidentDetail as ServerIncidentDetail,
  OperationalIncidentPage as ServerIncidentPage,
} from "@polaris/db/admin-incident-repository";
import type {
  openPrivacyCase,
  openSupportCase,
  PrivacyCaseDetail as ServerPrivacyDetail,
  PrivacyCasePage as ServerPrivacyPage,
  PrivacyStepResult,
  SupportCaseDetail as ServerCaseDetail,
  SupportCasePage as ServerCasePage,
} from "@polaris/db/admin-support-repository";
import type { PlatformCapability } from "@polaris/domain/admin/platform-capabilities";
import type { RefundWindowView as ServerRefundWindow } from "@polaris/domain/admin/refund-window";
import type { SupportDependencies } from "../support-routes";
import { describe, expect, it } from "vitest";
import type {
  AccessLogEntry,
  AccessLogPage,
  ClosedSupportCase,
  DeadEventSummary,
  OpenedSupportCase,
  OperationalIncidentDetail,
  OperationalIncidentPage,
  OpenedPrivacyCase,
  OrganizationPage,
  PrivacyCaseDetail,
  PrivacyCasePage,
  PrivacyStepAnswer,
  RefundWindowView,
  SupportCaseDetail,
  RetryResult,
  SupportCasePage,
  WhoAmI,
} from "../../ui/types";

/**
 * The page writes the shapes of the store list, `whoami`, the support cases (list, detail and close) and the refund window itself (its script imports nothing of the database).
 * This file fails to compile when the server's answer and the page's reading of it drift apart, in either direction.
 */

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const listMatches: Same<AdminOrganizationPage, OrganizationPage> = true;
// what /api/whoami answers (app.ts), as the page reads it
const whoamiMatches: Same<
  {
    capabilities: readonly PlatformCapability[];
    principal: { emailSnapshot: string | null; id: string; role: string };
  },
  Omit<WhoAmI, "capabilities"> & { capabilities: readonly PlatformCapability[] }
> = true;
const casesMatch: Same<ServerCasePage, SupportCasePage> = true;
const detailMatches: Same<ServerCaseDetail, SupportCaseDetail> = true;
const closedMatches: Same<
  NonNullable<Awaited<ReturnType<SupportDependencies["close"]>>>,
  ClosedSupportCase
> = true;
const openedMatches: Same<
  NonNullable<Awaited<ReturnType<typeof openSupportCase>>>,
  OpenedSupportCase
> = true;
// the page reads the window's codes as text (a new state is shown as unknown), with the same keys
const refundWindowRead: ServerRefundWindow extends RefundWindowView
  ? true
  : false = true;
const refundWindowKeys: Same<keyof ServerRefundWindow, keyof RefundWindowView> =
  true;
const incidentsMatch: Same<ServerIncidentPage, OperationalIncidentPage> = true;
const incidentMatches: Same<ServerIncidentDetail, OperationalIncidentDetail> =
  true;
const deadEventMatches: Same<ServerDeadEvent, DeadEventSummary> = true;
// the page says each of the retry's results by its own sentence: a sixth one in the server fails here
const retryResultsRead: Same<IncidentRetryResult, RetryResult> = true;
const accessEntryMatches: Same<AccessLogEntryView, AccessLogEntry> = true;
const accessPageMatches: Extract<
  AccessLogReadResult,
  { result: "ok" }
> extends { entries: AccessLogPage["entries"]; next: AccessLogPage["next"] }
  ? true
  : false = true;
const privacyPageMatches: Same<ServerPrivacyPage, PrivacyCasePage> = true;
const privacyDetailMatches: Same<ServerPrivacyDetail, PrivacyCaseDetail> = true;
const privacyOpenedMatches: Same<
  NonNullable<Awaited<ReturnType<typeof openPrivacyCase>>>,
  OpenedPrivacyCase
> = true;
const privacyStepMatches: Same<PrivacyStepResult, PrivacyStepAnswer> = true;
const capabilitiesRead: readonly PlatformCapability[] extends readonly string[]
  ? true
  : false = true;

describe("the page's types", () => {
  it("match the server's answers (checked by the compiler)", () => {
    expect([
      listMatches,
      whoamiMatches,
      casesMatch,
      detailMatches,
      closedMatches,
      openedMatches,
      refundWindowRead,
      refundWindowKeys,
      capabilitiesRead,
      incidentsMatch,
      incidentMatches,
      deadEventMatches,
      retryResultsRead,
      accessEntryMatches,
      accessPageMatches,
      privacyPageMatches,
      privacyDetailMatches,
      privacyOpenedMatches,
      privacyStepMatches,
    ]).toEqual(new Array(19).fill(true));
  });
});
