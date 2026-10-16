import { describe, expect, it } from "vitest";
import { INITIAL_PLAN_CATALOG, resolveEntitlements } from "./entitlements";
import {
  type GrantRequest,
  InvalidEntitlementGrantError,
  isValidGrantActor,
  MAX_GRANT_DAYS,
  MAX_GRANT_LIMIT,
  normalizeGrant,
} from "./grants";

const DAY = 86_400_000;
const now = new Date("2026-10-16T12:00:00.000Z");
const days = (count: number, from = now) =>
  new Date(from.getTime() + count * DAY);

const request = (overrides: Partial<GrantRequest> = {}): GrantRequest => ({
  actor: "admin:junior",
  expiresAt: days(30),
  key: "variants.active.max",
  reason: "Parceria com a loja X",
  value: 200,
  ...overrides,
});

const refused = (overrides: Partial<GrantRequest>) => {
  try {
    normalizeGrant(request(overrides), now);
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(InvalidEntitlementGrantError);
    return (error as InvalidEntitlementGrantError).code;
  }
  throw new Error("expected the grant to be refused");
};

describe("what a grant must say", () => {
  it("keeps who, why, from when and until when, and starts now unless told otherwise", () => {
    expect(normalizeGrant(request({ reason: "  apoio  " }), now)).toEqual({
      actor: "admin:junior",
      expiresAt: days(30),
      flagValue: null,
      key: "variants.active.max",
      limitValue: 200,
      reason: "apoio",
      startsAt: now,
    });
    const later = days(5);
    expect(normalizeGrant(request({ startsAt: later }), now).startsAt).toEqual(
      later
    );
  });

  it("turns a capability on and never off", () => {
    expect(
      normalizeGrant(request({ key: "offline.write", value: true }), now)
    ).toMatchObject({ flagValue: true, limitValue: null });
    expect(refused({ key: "offline.write", value: false })).toBe(
      "invalid_value"
    );
    expect(refused({ key: "public_catalog", value: 3 })).toBe("invalid_value");
  });

  it("sets a limit to a whole number a plan could not be mistaken for", () => {
    for (const value of [0, -1, 1.5, Number.NaN, MAX_GRANT_LIMIT + 1, true]) {
      expect(refused({ value })).toBe("invalid_value");
    }
    expect(
      normalizeGrant(request({ value: MAX_GRANT_LIMIT }), now).limitValue
    ).toBe(MAX_GRANT_LIMIT);
  });

  it("refuses an unknown entitlement, an empty or long reason, and an actor that is not an identifier", () => {
    expect(refused({ key: "everything" })).toBe("invalid_key");
    expect(refused({ reason: "   " })).toBe("invalid_reason");
    expect(refused({ reason: "x".repeat(301) })).toBe("invalid_reason");
    expect(refused({ reason: "ok\u0000" })).toBe("invalid_reason");
    for (const actor of [
      "",
      "  ",
      "João da Silva",
      "a b",
      ":x",
      "x".repeat(129),
    ]) {
      expect(refused({ actor })).toBe("invalid_actor");
    }
    expect(isValidGrantActor("system:billing-sweep")).toBe(true);
    // never an e-mail address: the actor lands in the ledger
    expect(isValidGrantActor("admin@summit")).toBe(false);
    expect(refused({ actor: "ana@exemplo.com" })).toBe("invalid_actor");
  });

  it("always ends, in the future, after it starts, and within the longest grant", () => {
    expect(refused({ expiresAt: now })).toBe("invalid_period");
    expect(refused({ expiresAt: days(-1) })).toBe("invalid_period");
    expect(refused({ expiresAt: new Date(Number.NaN) })).toBe("invalid_period");
    expect(refused({ expiresAt: days(10), startsAt: days(10) })).toBe(
      "invalid_period"
    );
    expect(refused({ expiresAt: days(10), startsAt: days(20) })).toBe(
      "invalid_period"
    );
    expect(refused({ expiresAt: days(MAX_GRANT_DAYS + 1) })).toBe(
      "grant_too_long"
    );
    // a slip (seconds) is not a grant, and neither is one that starts years from now
    expect(refused({ expiresAt: new Date(now.getTime() + 30_000) })).toBe(
      "invalid_period"
    );
    expect(
      refused({
        expiresAt: days(MAX_GRANT_DAYS + 30),
        startsAt: days(MAX_GRANT_DAYS + 1),
      })
    ).toBe("invalid_period");
    // a grant that began a while ago and still has time left is fine, within the longest
    expect(
      normalizeGrant(request({ expiresAt: days(10), startsAt: days(-30) }), now)
        .startsAt
    ).toEqual(days(-30));
    expect(
      normalizeGrant(request({ expiresAt: days(MAX_GRANT_DAYS) }), now)
        .expiresAt
    ).toEqual(days(MAX_GRANT_DAYS));
  });
});

describe("a grant in the entitlements of an organization", () => {
  const free = { accessEndsAt: null, state: "free" as const };
  const resolve = (startsAt: Date, expiresAt: Date, at = now) =>
    resolveEntitlements({
      catalog: INITIAL_PLAN_CATALOG,
      facts: free,
      grants: [{ expiresAt, key: "variants.active.max", startsAt, value: 200 }],
      now: at,
    });

  it("counts only between its start and its end", () => {
    expect(resolve(days(-1), days(5)).values["variants.active.max"]).toBe(200);
    // not started yet: nothing changes
    const notYet = resolve(days(2), days(5));
    expect(notYet.values["variants.active.max"]).toBe(50);
    expect(notYet.raisedByGrant).toEqual([]);
    // from its start on, and not past its end
    expect(
      resolve(days(2), days(5), days(2)).values["variants.active.max"]
    ).toBe(200);
    expect(
      resolve(days(2), days(5), days(5)).values["variants.active.max"]
    ).toBe(50);
  });

  it("is still a Free plan: a grant is never a subscription", () => {
    const granted = resolve(days(-1), days(5));
    expect(granted.plan).toBe("free");
    expect(granted.state).toBe("free");
    expect(granted.accessEndsAt).toBeNull();
    expect(granted.raisedByGrant).toEqual(["variants.active.max"]);
  });
});
