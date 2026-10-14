import { assert as fcAssert, integer, property } from "fast-check";
import { describe, expect, it } from "vitest";
import { OFFLINE_GRANT_MAX_LIFETIME_MS } from "./offline-grant";
import {
  assertOfflineLeaseCurrent,
  buildOfflineLeaseClaims,
  InvalidOfflineLeaseError,
  OFFLINE_LEASE_CLOCK_SKEW_MS,
  OfflineLeaseNotAvailableError,
  parseOfflineLeaseClaims,
  planOfflineLeaseWindow,
  serializeOfflineLeaseClaims,
} from "./offline-lease";

const issuedAt = new Date("2026-10-14T12:00:00.000Z");
const expiresAt = new Date(issuedAt.getTime() + 72 * 3_600_000);

const claims = () =>
  buildOfflineLeaseClaims({
    capabilities: ["sale:create", "catalog:read", "sale:create"],
    deviceId: "0198e5f0-0000-7000-8000-0000000000d1",
    epoch: 2,
    expiresAt,
    grantId: "0198e5f0-0000-7000-8000-0000000000a1",
    issuedAt,
    organizationId: "org-1",
    userId: "user-1",
  });

function reason(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidOfflineLeaseError);
    return (error as InvalidOfflineLeaseError).reason;
  }
  throw new Error("expected an InvalidOfflineLeaseError");
}

describe("offline lease claims", () => {
  it("snapshots capabilities sorted and without duplicates", () => {
    expect(claims().caps).toEqual(["catalog:read", "sale:create"]);
  });

  it("rejects a window longer than 72 hours or an empty one", () => {
    for (const delta of [1000, -issuedAt.getTime()]) {
      expect(() =>
        buildOfflineLeaseClaims({
          capabilities: [],
          deviceId: "0198e5f0-0000-7000-8000-0000000000d1",
          epoch: 0,
          expiresAt: new Date(
            delta > 0 ? expiresAt.getTime() + delta : issuedAt.getTime()
          ),
          grantId: "0198e5f0-0000-7000-8000-0000000000a1",
          issuedAt,
          organizationId: "org-1",
          userId: "user-1",
        })
      ).toThrow(InvalidOfflineLeaseError);
    }
  });

  it("serializes deterministically and parses back", () => {
    const json = serializeOfflineLeaseClaims(claims());
    expect(json).toBe(serializeOfflineLeaseClaims({ ...claims() }));
    expect(parseOfflineLeaseClaims(json)).toEqual(claims());
  });

  it("rejects claims with a wrong shape", () => {
    const base = JSON.parse(serializeOfflineLeaseClaims(claims()));
    for (const patch of [
      { v: 2 },
      { jti: "not-a-uuid" },
      { dev: 7 },
      { sub: "" },
      { epoch: -1 },
      { epoch: 1.5 },
      { exp: base.iat },
      { caps: "all" },
      { caps: [1] },
      { iat: "now" },
    ]) {
      expect(
        reason(() =>
          parseOfflineLeaseClaims(JSON.stringify({ ...base, ...patch }))
        )
      ).toBe("malformed");
    }
    expect(reason(() => parseOfflineLeaseClaims("{not json"))).toBe(
      "malformed"
    );
    expect(reason(() => parseOfflineLeaseClaims("[]"))).toBe("malformed");
  });
});

describe("offline lease validity", () => {
  it("is current until the expiry second and expired from it on", () => {
    expect(() =>
      assertOfflineLeaseCurrent(claims(), new Date(expiresAt.getTime() - 1))
    ).not.toThrow();
    expect(reason(() => assertOfflineLeaseCurrent(claims(), expiresAt))).toBe(
      "expired"
    );
  });

  it("rejects a lease issued too far ahead of the server clock", () => {
    const early = new Date(
      issuedAt.getTime() - OFFLINE_LEASE_CLOCK_SKEW_MS - 1000
    );
    expect(reason(() => assertOfflineLeaseCurrent(claims(), early))).toBe(
      "not_yet_valid"
    );
    expect(() =>
      assertOfflineLeaseCurrent(
        claims(),
        new Date(issuedAt.getTime() - OFFLINE_LEASE_CLOCK_SKEW_MS)
      )
    ).not.toThrow();
  });
});

describe("offline lease window", () => {
  const now = new Date("2026-10-14T12:00:00.750Z");

  it("is 72 hours, in whole seconds", () => {
    const window = planOfflineLeaseWindow({ now });
    expect(window.issuedAt.toISOString()).toBe("2026-10-14T12:00:00.000Z");
    expect(window.expiresAt.getTime() - window.issuedAt.getTime()).toBe(
      OFFLINE_GRANT_MAX_LIFETIME_MS
    );
  });

  it("is capped by the end of the entitlement and never empty", () => {
    const trialEnd = new Date(now.getTime() + 5 * 3_600_000);
    expect(
      planOfflineLeaseWindow({ entitlementEndsAt: trialEnd, now }).expiresAt
    ).toEqual(new Date(Math.floor(trialEnd.getTime() / 1000) * 1000));
    expect(() =>
      planOfflineLeaseWindow({ entitlementEndsAt: now, now })
    ).toThrow(OfflineLeaseNotAvailableError);
    expect(() =>
      planOfflineLeaseWindow({
        entitlementEndsAt: new Date(now.getTime() - 1000),
        now,
      })
    ).toThrow(OfflineLeaseNotAvailableError);
  });

  it("expires at min(now + 72h, entitlement end) (property)", () => {
    fcAssert(
      property(integer({ max: 100 * 3_600_000, min: -3_600_000 }), (offset) => {
        const entitlementEndsAt = new Date(now.getTime() + offset);
        const issued = Math.floor(now.getTime() / 1000) * 1000;
        const ends = Math.floor(entitlementEndsAt.getTime() / 1000) * 1000;
        const expected = Math.min(issued + OFFLINE_GRANT_MAX_LIFETIME_MS, ends);
        if (expected <= issued) {
          expect(() =>
            planOfflineLeaseWindow({ entitlementEndsAt, now })
          ).toThrow(OfflineLeaseNotAvailableError);
        } else {
          expect(
            planOfflineLeaseWindow({
              entitlementEndsAt,
              now,
            }).expiresAt.getTime()
          ).toBe(expected);
        }
      }),
      { numRuns: 300 }
    );
  });
});
