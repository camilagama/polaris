import type { OfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import { describe, expect, it } from "vitest";
import { leaseStanding, leaseTimerDelay } from "./lease-standing";

const owner = { deviceId: "dev-1", organizationId: "org-1", userId: "user-1" };
const exp = Date.parse("2026-10-17T12:00:00.000Z") / 1000;
const claims: OfflineLeaseClaims = {
  caps: ["sale:create"],
  dev: "dev-1",
  epoch: 0,
  exp,
  iat: exp - 72 * 3600,
  jti: "grant-1",
  org: "org-1",
  sub: "user-1",
  v: 1,
} as OfflineLeaseClaims;

describe("leaseStanding", () => {
  it("is usable before the exp and expired from the exp on, to the millisecond", () => {
    expect(leaseStanding(claims, owner, exp * 1000 - 1)).toBe("usable");
    expect(leaseStanding(claims, owner, exp * 1000)).toBe("expired");
    expect(leaseStanding(claims, owner, exp * 1000 + 3_600_000)).toBe(
      "expired"
    );
  });

  it("an unreadable lease, or one of another user, organization or device, is never usable nor expired", () => {
    const now = exp * 1000 - 1;
    expect(leaseStanding(null, owner, now)).toBe("foreign");
    expect(leaseStanding({ ...claims, sub: "user-2" }, owner, now)).toBe(
      "foreign"
    );
    expect(leaseStanding({ ...claims, org: "org-2" }, owner, now)).toBe(
      "foreign"
    );
    expect(leaseStanding({ ...claims, dev: "dev-2" }, owner, now)).toBe(
      "foreign"
    );
    // somebody else's lease that also ended is still not this person's to report as "expired"
    expect(
      leaseStanding({ ...claims, sub: "user-2" }, owner, exp * 1000 + 1)
    ).toBe("foreign");
  });
});

describe("leaseTimerDelay", () => {
  it("waits until the exp, fires at once when it already passed, and never past what a browser timer holds", () => {
    expect(leaseTimerDelay(10_000, 4000)).toBe(6000);
    expect(leaseTimerDelay(10_000, 10_000)).toBe(0);
    expect(leaseTimerDelay(10_000, 20_000)).toBe(0);
    expect(leaseTimerDelay(60 * 24 * 3_600_000, 0)).toBe(2_147_483_647);
  });
});
