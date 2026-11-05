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
  openSupportCase,
  SupportCaseDetail as ServerCaseDetail,
  SupportCasePage as ServerCasePage,
} from "@polaris/db/admin-support-repository";
import type { PlatformCapability } from "@polaris/domain/admin/platform-capabilities";
import { ENTITLEMENT_KEYS } from "@polaris/domain/billing/entitlements";
import {
  MAX_GRANT_DAYS,
  MAX_GRANT_REASON_LENGTH,
} from "@polaris/domain/billing/grants";
import type { RefundWindowView as ServerRefundWindow } from "@polaris/domain/admin/refund-window";
import type { SupportDependencies } from "../support-routes";
import { describe, expect, it } from "vitest";
import { entitlementText } from "../../ui/format";
import { MAX_HOURS, MAX_REASON_LENGTH } from "../../ui/grant-limits";
import type {
  AccessLogEntry,
  AccessLogPage,
  ClosedSupportCase,
  DeadEventSummary,
  EndedEntitlement,
  GrantedEntitlement,
  OpenedSupportCase,
  OperationalIncidentDetail,
  OperationalIncidentPage,
  OrganizationPage,
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
// the page reads three fields of what giving a grant answers and both of what ending one answers
const grantedRead: Same<
  Pick<
    Awaited<ReturnType<SupportDependencies["grantEntitlement"]>>,
    "created" | "id" | "outcomeRecorded"
  >,
  GrantedEntitlement
> = true;
const endedMatches: Same<
  Awaited<ReturnType<SupportDependencies["revokeEntitlement"]>>,
  EndedEntitlement
> = true;
const accessEntryMatches: Same<AccessLogEntryView, AccessLogEntry> = true;
const accessPageMatches: Extract<
  AccessLogReadResult,
  { result: "ok" }
> extends { entries: AccessLogPage["entries"]; next: AccessLogPage["next"] }
  ? true
  : false = true;
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
      grantedRead,
      endedMatches,
      accessEntryMatches,
      accessPageMatches,
    ]).toEqual(new Array(17).fill(true));
  });
});

describe("the grant form's limits", () => {
  it("name every key of the catalog in words, and are the server's own limits", () => {
    for (const key of ENTITLEMENT_KEYS) {
      expect(entitlementText(key)).not.toContain("desconhecido");
    }
    expect(MAX_REASON_LENGTH).toBe(MAX_GRANT_REASON_LENGTH);
    expect(MAX_HOURS).toBe(MAX_GRANT_DAYS * 24);
  });
});
