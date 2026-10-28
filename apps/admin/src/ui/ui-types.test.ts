import type { AdminOrganizationPage } from "@polaris/db/admin-diagnostics-repository";
import type {
  openSupportCase,
  SupportCasePage as ServerCasePage,
} from "@polaris/db/admin-support-repository";
import type { PlatformCapability } from "@polaris/domain/admin/platform-capabilities";
import type { RefundWindowView as ServerRefundWindow } from "@polaris/domain/admin/refund-window";
import { describe, expect, it } from "vitest";
import type {
  OpenedSupportCase,
  OrganizationPage,
  RefundWindowView,
  SupportCasePage,
  WhoAmI,
} from "../../ui/types";

/**
 * The page writes the shapes of the store list, `whoami`, the support cases and the refund window itself (its script imports nothing of the database).
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
const capabilitiesRead: readonly PlatformCapability[] extends readonly string[]
  ? true
  : false = true;

describe("the page's types", () => {
  it("match the server's answers (checked by the compiler)", () => {
    expect([
      listMatches,
      whoamiMatches,
      casesMatch,
      openedMatches,
      refundWindowRead,
      refundWindowKeys,
      capabilitiesRead,
    ]).toEqual([true, true, true, true, true, true, true]);
  });
});
