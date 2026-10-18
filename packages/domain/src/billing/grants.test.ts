import { describe, expect, it } from "vitest";
import { INITIAL_PLAN_CATALOG, resolveEntitlements } from "./entitlements";
import {
  type GrantRequest,
  InvalidEntitlementGrantError,
  isRepeatOfGrant,
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

describe("a repeat of a grant command", () => {
  const HOUR = 3_600_000;
  const asked = normalizeGrant(
    request({ expiresAt: new Date(now.getTime() + 24 * HOUR), startsAt: now }),
    now
  );
  const stored = {
    expiresAt: asked.expiresAt,
    flagValue: asked.flagValue,
    grantedBy: asked.actor,
    key: asked.key,
    limitValue: asked.limitValue,
    organizationId: "org-1",
    reason: asked.reason,
    startsAt: asked.startsAt,
  };
  const repeat = { grant: asked, hours: 24, organizationId: "org-1" };

  it("is the same grant when everything matches, whatever the clock the repeat was given at", () => {
    expect(isRepeatOfGrant(stored, repeat)).toBe(true);
  });

  it("is not the same grant when the length differs: one hour and then 720 are two commands", () => {
    expect(isRepeatOfGrant(stored, { ...repeat, hours: 720 })).toBe(false);
    // and the length is exact, not close: a start a moment later is another length
    expect(
      isRepeatOfGrant(
        { ...stored, startsAt: new Date(stored.startsAt.getTime() + 1) },
        repeat
      )
    ).toBe(false);
  });

  it("is not the same grant when the organization, the key, the value, the reason or the giver differ", () => {
    for (const different of [
      { organizationId: "org-2" },
      { key: "images.active.max" },
      { limitValue: 300 },
      { flagValue: true },
      { reason: "Outro motivo" },
      { grantedBy: "admin:someone-else" },
    ]) {
      expect(isRepeatOfGrant({ ...stored, ...different }, repeat)).toBe(false);
    }
  });
});
