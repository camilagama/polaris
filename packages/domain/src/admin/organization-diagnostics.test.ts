import { describe, expect, it } from "vitest";
import {
  buildOrganizationDiagnostics,
  type RawDiagnostics,
} from "./organization-diagnostics";

const now = "2026-10-16T12:00:00.000Z";
const catalog = [
  { flagValue: null, key: "goals.active.max", limitValue: 1, planId: "free" },
  { flagValue: null, key: "images.active.max", limitValue: 50, planId: "free" },
  {
    flagValue: null,
    key: "images.per_product.max",
    limitValue: 1,
    planId: "free",
  },
  { flagValue: false, key: "offline.write", limitValue: null, planId: "free" },
  { flagValue: false, key: "public_catalog", limitValue: null, planId: "free" },
  {
    flagValue: null,
    key: "variants.active.max",
    limitValue: 50,
    planId: "free",
  },
  { flagValue: null, key: "goals.active.max", limitValue: 3, planId: "pro" },
  {
    flagValue: null,
    key: "images.active.max",
    limitValue: 5000,
    planId: "pro",
  },
  {
    flagValue: null,
    key: "images.per_product.max",
    limitValue: 10,
    planId: "pro",
  },
  { flagValue: true, key: "offline.write", limitValue: null, planId: "pro" },
  { flagValue: true, key: "public_catalog", limitValue: null, planId: "pro" },
  {
    flagValue: null,
    key: "variants.active.max",
    limitValue: 2000,
    planId: "pro",
  },
];

function raw(overrides: Partial<RawDiagnostics> = {}): RawDiagnostics {
  return {
    billing: null,
    billingEvents: {
      byStatus: {},
      lastReceivedAt: null,
      maxAttempts: 0,
      oldestUnprocessedAt: null,
    },
    grants: [],
    now,
    offline: { activeGrants: 0, devices: 0, lastSeenAt: null },
    organization: {
      authorizationEpoch: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      currency: "BRL",
      id: "org-1",
      members: 1,
      name: "Loja",
      status: "active",
      timezone: "America/Sao_Paulo",
    },
    planCatalog: catalog,
    sync: { last7Days: {}, lastReceivedAt: null, rejectedByCode: {} },
    usage: {
      activeGoals: 0,
      archivedProducts: 0,
      maxImagesPerProduct: 0,
      images: 0,
      products: 0,
      variants: 0,
    },
    ...overrides,
  };
}

const active = {
  accessEndsAt: "2026-11-16T12:00:00.000Z",
  cancelAtPeriodEnd: false,
  cycleMonths: 1,
  lastFactAt: null,
  overLimitSince: null,
  pendingCycleMonths: null,
  provider: "asaas",
  revokedReason: null,
  revokedThrough: null,
  state: "active",
  trialStartedAt: null,
  version: 3,
};

describe("the organization report", () => {
  it("is Free with its limits and nothing to look at for a fresh organization", () => {
    const report = buildOrganizationDiagnostics(raw());
    expect(report.entitlements).toMatchObject({
      flags: { "offline.write": false, public_catalog: false },
      overLimit: false,
      plan: "free",
      state: "free",
    });
    expect(report.quotas).toEqual([
      { key: "goals.active.max", limit: 1, status: "ok", used: 0 },
      { key: "images.active.max", limit: 50, status: "ok", used: 0 },
      { key: "images.per_product.max", limit: 1, status: "ok", used: 0 },
      { key: "variants.active.max", limit: 50, status: "ok", used: 0 },
    ]);
    expect(report.attention).toEqual([]);
  });

  it("is Pro while the paid period runs, and Free the moment it has ended even if the record was not updated", () => {
    expect(
      buildOrganizationDiagnostics(raw({ billing: active })).entitlements.plan
    ).toBe("pro");
    expect(
      buildOrganizationDiagnostics(
        raw({
          billing: { ...active, accessEndsAt: "2026-10-16T11:59:59.000Z" },
        })
      ).entitlements.plan
    ).toBe("free");
  });

  it("measures usage against the limit in force and says where it is at or over it", () => {
    const report = buildOrganizationDiagnostics(
      raw({
        usage: {
          activeGoals: 1,
          archivedProducts: 2,
          maxImagesPerProduct: 3,
          images: 10,
          products: 20,
          variants: 55,
        },
      })
    );
    const status = Object.fromEntries(
      report.quotas.map((line) => [line.key, line.status])
    );
    expect(status).toEqual({
      "goals.active.max": "at_limit",
      "images.active.max": "ok",
      "images.per_product.max": "over",
      "variants.active.max": "over",
    });
  });

  it("counts a grant in force, ignores one revoked before it started, and says what it raised", () => {
    const grant = {
      expiresAt: "2026-11-01T00:00:00.000Z",
      flagValue: null,
      key: "variants.active.max",
      limitValue: 100,
      revokedAt: null,
      startsAt: "2026-10-01T00:00:00.000Z",
    };
    const raised = buildOrganizationDiagnostics(raw({ grants: [grant] }));
    expect(raised.entitlements.raisedByGrant).toEqual(["variants.active.max"]);
    expect(
      raised.quotas.find((line) => line.key === "variants.active.max")?.limit
    ).toBe(100);
    const revoked = buildOrganizationDiagnostics(
      raw({
        grants: [
          {
            ...grant,
            revokedAt: "2026-09-30T00:00:00.000Z",
          },
        ],
      })
    );
    expect(revoked.entitlements.raisedByGrant).toEqual([]);
  });

  it("flags what an operator should look at", () => {
    const report = buildOrganizationDiagnostics(
      raw({
        billing: { ...active, state: "free_over_limit", accessEndsAt: null },
        billingEvents: {
          byStatus: { failed: 1, received: 2 },
          lastReceivedAt: now,
          maxAttempts: 4,
          oldestUnprocessedAt: "2026-10-16T10:00:00.000Z",
        },
        grants: [
          {
            expiresAt: "2026-10-18T00:00:00.000Z",
            flagValue: true,
            key: "public_catalog",
            limitValue: null,
            revokedAt: null,
            startsAt: "2026-10-01T00:00:00.000Z",
          },
        ],
        organization: { ...raw().organization, status: "suspended" },
        sync: {
          last7Days: { accepted: 5, rejected: 2 },
          lastReceivedAt: now,
          rejectedByCode: { insufficient_stock: 2 },
        },
      })
    );
    expect(report.attention.map((item) => item.code).sort()).toEqual([
      "billing_events_failed",
      "billing_events_stuck",
      "grant_ending_soon",
      "organization_not_active",
      "over_free_limit",
      "sync_rejections",
    ]);
  });

  it("treats a billing state it does not know as Free and says so", () => {
    const report = buildOrganizationDiagnostics(
      raw({ billing: { ...active, state: "mystery" } })
    );
    expect(report.entitlements.plan).toBe("free");
    expect(report.attention.map((item) => item.code)).toContain(
      "billing_state_unknown"
    );
  });

  it("refuses a damaged plan catalog instead of guessing the limits", () => {
    expect(() =>
      buildOrganizationDiagnostics(raw({ planCatalog: catalog.slice(0, 5) }))
    ).toThrow("plan_catalog_incomplete");
  });
});
