import type { PaymentProfileReadModel } from "@polaris/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredPeriodSummary } from "../../lib/period-summary-cache";
import type { LogoutWorkspace } from "../logout-guard";
import type { Outbox } from "../outbox/outbox";

const ORG = "0199c2d0-0000-7000-8000-00000000a001";
const OTHER = "0199c2d0-0000-7000-8000-00000000a002";
const AT = "2026-10-14T12:00:00.000Z";

/** A browser storage that lists its keys, with its window around it (`location.assign` is observed). */
function fakeWindow() {
  const stored = new Map<string, string>();
  const assign = vi.fn();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      key: (index: number) => [...stored.keys()][index] ?? null,
      get length() {
        return stored.size;
      },
      removeItem: (key: string) => stored.delete(key),
      setItem: (key: string, value: string) => stored.set(key, value),
    },
    location: { assign },
  });
  return { assign, stored };
}

const summaryOf = (
  from: string,
  to: string,
  generatedAt: string
): StoredPeriodSummary => ({
  cards: {
    items: 3,
    marginPercent: "52.69",
    netSales: "130.00",
    operatingResult: "38.50",
    salesCount: 2,
    ticket: "65.00",
  },
  chain: {
    anticipationFees: "0.00",
    cogs: "60.00",
    commercialSurcharges: "5.00",
    contributionMargin: "68.50",
    discounts: "10.00",
    estimatedOperatingResult: "38.50",
    grossProfit: "70.00",
    grossSales: "150.00",
    linkedExpenses: "2.00",
    netSales: "130.00",
    operatingExpenses: "30.00",
    processingFees: "4.50",
    returns: "10.00",
  },
  generatedAt,
  period: { from, to },
  quality: {
    anticipationFeesUnknown: 0,
    itemLines: 2,
    itemLinesWithUnknownCost: 0,
    level: "complete",
    linkedExpenses: 1,
    missing: [],
    operatingExpenses: 1,
    processingFeesUnknown: 0,
    salesCount: 2,
  },
});

const profile: PaymentProfileReadModel = {
  archivedAt: null,
  createdAt: AT,
  id: "0199c2d0-0000-7000-8000-000000000001",
  name: "Maquininha",
  organizationId: ORG,
  rules: [],
  status: "active",
  updatedAt: AT,
  version: 1,
};

/** Fresh modules for each case: `over` and `signingOut` are module state that never goes back. */
async function modules() {
  vi.resetModules();
  const [period, home, organizations, payments, leave, ended, signOut, flow] =
    await Promise.all([
      import("../../lib/period-summary-cache"),
      import("../../home/home-copy"),
      import("../../lib/current-organization-model"),
      import("../../lib/payment-profile-cache"),
      import("./leave-browser"),
      import("./session-ended"),
      import("../../lib/sign-out"),
      import("./logout-flow"),
    ]);
  return { ended, flow, home, leave, organizations, payments, period, signOut };
}

type Modules = Awaited<ReturnType<typeof modules>>;

/** What a session leaves behind: every copy of the session with the real writers, and what belongs to the device. */
function keepCopies(m: Modules, stored: Map<string, string>) {
  const storage = window.localStorage;
  const guard = { offlineRuntimeEnabled: true, signingOut: false };
  for (const organization of [ORG, OTHER]) {
    m.period.writePeriodSummaryCache(
      storage,
      organization,
      "2026-10",
      summaryOf("2026-10-01", "2026-10-31", AT),
      guard
    );
    m.period.writePeriodSummaryCache(
      storage,
      organization,
      "2026-09",
      summaryOf("2026-09-01", "2026-09-30", AT),
      guard
    );
    m.home.writeHomeCopy(storage, organization, {
      before: summaryOf("2026-09-01", "2026-09-30", AT),
      goal: { at: AT, view: { kind: "none" } },
      hadSale: true,
    });
    m.payments.writePaymentProfileCache(storage, organization, [profile]);
  }
  m.organizations.writeOrganizationsCache(storage, [
    { id: ORG, name: "Loja", role: "owner", timezone: "America/Sao_Paulo" },
  ] as never);
  // the device and the user's namespace are not copies of the session: their own rules clear them
  stored.set("polaris.offline.device", "device-1");
  stored.set("polaris.offline.session-user", "user-1");
  stored.set(`polaris.offline.lease.${ORG}`, "{}");
  stored.set("polaris.preferredOrganizationId", ORG);
}

const offlineKeys = (stored: Map<string, string>) =>
  [...stored.keys()].filter((key) => key.startsWith("polaris.offline.")).sort();

const COPY_KEY =
  /^polaris\.offline\.(periodSummary\.|home\.|organizations|paymentProfiles\.)/;

const copyKeys = (keys: string[]) => keys.filter((key) => COPY_KEY.test(key));

// What stays by existing rule: the device, its lease and the remembered user belong to the device's own
// logout step (`device.forget`, `runtime.forgetDevice`) and to the user's namespace; leaving the page does not
// touch them, so the next session of the same person can still open offline.
const KEPT_BY_RULE = [
  "polaris.offline.device",
  `polaris.offline.lease.${ORG}`,
  "polaris.offline.session-user",
];

/** A workspace with nothing queued, so the logout goes straight on. */
function emptyWorkspace(): LogoutWorkspace {
  return {
    label: "Loja",
    outbox: {
      snapshot: () =>
        Promise.resolve({
          blockedBy: null,
          commands: [],
          pending: 0,
          rejected: 0,
          sending: 0,
        }),
    } as unknown as Outbox,
    purge: () => Promise.resolve(),
    trySync: () => Promise.resolve(),
  };
}

describe("lists every polaris.offline.* key after each way out of the session", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("antes de sair, as cópias reais estão todas no aparelho", async () => {
    const { stored } = fakeWindow();
    keepCopies(await modules(), stored);

    expect(offlineKeys(stored)).toEqual(
      [
        ...KEPT_BY_RULE,
        "polaris.offline.organizations",
        `polaris.offline.home.${ORG}`,
        `polaris.offline.home.${OTHER}`,
        `polaris.offline.paymentProfiles.${ORG}`,
        `polaris.offline.paymentProfiles.${OTHER}`,
        `polaris.offline.periodSummary.${ORG}.2026-09`,
        `polaris.offline.periodSummary.${ORG}.2026-10`,
        `polaris.offline.periodSummary.${OTHER}.2026-09`,
        `polaris.offline.periodSummary.${OTHER}.2026-10`,
      ].sort()
    );
  });

  it("'Sair' (leaveAfterSignOut) apaga resumos, Início, organizações e perfis de pagamento", async () => {
    const { assign, stored } = fakeWindow();
    const m = await modules();
    keepCopies(m, stored);

    m.leave.leaveAfterSignOut("/");

    expect(assign).toHaveBeenCalledWith("/");
    expect(copyKeys(offlineKeys(stored))).toEqual([]);
    expect(offlineKeys(stored)).toEqual(KEPT_BY_RULE);
  });

  it("a recusa UNAUTHORIZED (endSessionHere) apaga as mesmas cópias", async () => {
    const { stored } = fakeWindow();
    const m = await modules();
    keepCopies(m, stored);

    m.ended.endSessionHere();

    expect(copyKeys(offlineKeys(stored))).toEqual([]);
    expect(offlineKeys(stored)).toEqual(KEPT_BY_RULE);
    expect(m.ended.isSessionOver()).toBe(true);
  });

  it("a limpeza do logout (startLogout terminando em leaveAfterSignOut) apaga as mesmas cópias", async () => {
    const { assign, stored } = fakeWindow();
    const m = await modules();
    keepCopies(m, stored);
    const forget = vi.fn();

    const result = await m.flow.startLogout({
      device: {
        forget,
        id: null,
        isOnline: () => false,
        revoke: () => Promise.reject(new Error("not called")),
      },
      leave: () => m.leave.leaveAfterSignOut("/"),
      signOut: () => Promise.resolve(),
      workspaces: [emptyWorkspace()],
    });

    expect(result).toEqual({ status: "signed_out" });
    expect(forget).toHaveBeenCalledOnce();
    expect(assign).toHaveBeenCalledWith("/");
    expect(copyKeys(offlineKeys(stored))).toEqual([]);
    // `forget` is a fake here (the real one is the runtime's, which clears these): the keys stay in this test only
    expect(offlineKeys(stored)).toEqual(KEPT_BY_RULE);
  });

  it("depois de 'Sair' marcado, uma leitura que ainda volta não grava o resumo de novo", async () => {
    const { stored } = fakeWindow();
    const m = await modules();
    m.signOut.markSigningOut();

    m.period.writePeriodSummaryCache(
      window.localStorage,
      ORG,
      "2026-10",
      summaryOf("2026-10-01", "2026-10-31", AT),
      { offlineRuntimeEnabled: true, signingOut: m.signOut.isSigningOut() }
    );

    expect(m.signOut.isSigningOut()).toBe(true);
    expect(offlineKeys(stored)).toEqual([]);
  });

  it("depois de leaveAfterSignOut o aparelho sabe que está saindo", async () => {
    const { stored } = fakeWindow();
    const m = await modules();
    keepCopies(m, stored);
    m.leave.leaveAfterSignOut("/");

    m.period.writePeriodSummaryCache(
      window.localStorage,
      ORG,
      "2026-10",
      summaryOf("2026-10-01", "2026-10-31", AT),
      { offlineRuntimeEnabled: true, signingOut: m.signOut.isSigningOut() }
    );

    expect(copyKeys(offlineKeys(stored))).toEqual([]);
  });
});
