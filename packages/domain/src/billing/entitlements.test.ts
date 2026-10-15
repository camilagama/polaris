import { describe, expect, it } from "vitest";
import {
  assertFlag,
  assertWithinLimit,
  type BillingFacts,
  ENTITLEMENT_KEYS,
  EntitlementDeniedError,
  type EntitlementGrant,
  EntitlementLimitReachedError,
  IncompletePlanCatalogError,
  INITIAL_PLAN_CATALOG,
  type PlanEntitlementRow,
  planCatalogFromRows,
  planInForce,
  resolveEntitlements,
} from "./entitlements";

const now = new Date("2026-10-14T12:00:00.000Z");
const later = new Date("2026-10-21T12:00:00.000Z");
const earlier = new Date("2026-10-10T12:00:00.000Z");

const resolve = (facts: BillingFacts, grants: EntitlementGrant[] = []) =>
  resolveEntitlements({ catalog: INITIAL_PLAN_CATALOG, facts, grants, now });

describe("the initial plan catalog", () => {
  it("has the commercial hypotheses of PRODUCT.md, and every key in every plan", () => {
    expect(INITIAL_PLAN_CATALOG.free).toEqual({
      "goals.active.max": 1,
      "images.active.max": 50,
      "images.per_product.max": 1,
      "offline.write": false,
      public_catalog: false,
      "variants.active.max": 50,
    });
    expect(INITIAL_PLAN_CATALOG.pro).toEqual({
      "goals.active.max": 3,
      "images.active.max": 5000,
      "images.per_product.max": 10,
      "offline.write": true,
      public_catalog: true,
      "variants.active.max": 2000,
    });
    for (const plan of Object.values(INITIAL_PLAN_CATALOG)) {
      expect(Object.keys(plan).sort()).toEqual([...ENTITLEMENT_KEYS].sort());
    }
  });

  it("Pro is never below Free", () => {
    for (const key of ENTITLEMENT_KEYS) {
      expect(Number(INITIAL_PLAN_CATALOG.pro[key])).toBeGreaterThanOrEqual(
        Number(INITIAL_PLAN_CATALOG.free[key])
      );
    }
  });
});

describe("the plan in force", () => {
  const matrix: [BillingFacts["state"], Date | null, "free" | "pro", string][] =
    [
      ["free", null, "free", "free"],
      ["free_over_limit", null, "free", "free after a downgrade"],
      ["trial_setup", null, "free", "a trial being set up is not Pro yet"],
      ["trialing", later, "pro", "a running trial"],
      [
        "trialing",
        earlier,
        "free",
        "a trial that ended before the record was updated",
      ],
      ["trialing", null, "free", "Pro without an end date is never granted"],
      ["active", later, "pro", "a paid period"],
      ["active", earlier, "free", "a period that ran out"],
      ["grace", later, "pro", "grace keeps Pro until it ends"],
      ["grace", earlier, "free", "grace that ran out"],
    ];

  it.each(matrix)("%s until %s is %s (%s)", (state, accessEndsAt, plan) => {
    expect(planInForce({ accessEndsAt, state }, now)).toBe(plan);
  });

  it("access ends exactly at its end instant", () => {
    expect(planInForce({ accessEndsAt: now, state: "active" }, now)).toBe(
      "free"
    );
    expect(
      planInForce(
        { accessEndsAt: new Date(now.getTime() + 1), state: "active" },
        now
      )
    ).toBe("pro");
  });
});

describe("resolveEntitlements", () => {
  it("gives Pro values while Pro is in force and Free after", () => {
    const pro = resolve({ accessEndsAt: later, state: "active" });
    expect(pro).toMatchObject({
      accessEndsAt: later,
      overLimit: false,
      plan: "pro",
    });
    expect(pro.values["variants.active.max"]).toBe(2000);
    const free = resolve({ accessEndsAt: earlier, state: "active" });
    expect(free).toMatchObject({ accessEndsAt: null, plan: "free" });
    expect(free.values["offline.write"]).toBe(false);
  });

  it("marks the downgrade state, which restricts without deleting", () => {
    const downgraded = resolve({
      accessEndsAt: null,
      state: "free_over_limit",
    });
    expect(downgraded.overLimit).toBe(true);
    expect(downgraded.plan).toBe("free");
    expect(resolve({ accessEndsAt: null, state: "free" }).overLimit).toBe(
      false
    );
  });

  it("a temporary grant raises a limit or turns on a flag until it expires, and never lowers anything", () => {
    const grants: EntitlementGrant[] = [
      { expiresAt: later, key: "variants.active.max", value: 100 },
      { expiresAt: later, key: "public_catalog", value: true },
      { expiresAt: later, key: "goals.active.max", value: 0 },
      { expiresAt: earlier, key: "images.active.max", value: 999 },
    ];
    const effective = resolve({ accessEndsAt: null, state: "free" }, grants);
    expect(effective.values["variants.active.max"]).toBe(100);
    expect(effective.values.public_catalog).toBe(true);
    expect(effective.values["goals.active.max"]).toBe(1);
    expect(effective.values["images.active.max"]).toBe(50);
    expect([...effective.raisedByGrant].sort()).toEqual(
      ["public_catalog", "variants.active.max"].sort()
    );
  });

  it("a grant below what the plan already gives changes nothing", () => {
    const effective = resolve({ accessEndsAt: later, state: "active" }, [
      { expiresAt: later, key: "variants.active.max", value: 100 },
    ]);
    expect(effective.values["variants.active.max"]).toBe(2000);
    expect(effective.raisedByGrant).toEqual([]);
  });

  it("matrix: every state, end date and grant keeps every key, a consistent plan and never goes below the plan", () => {
    const grant: EntitlementGrant = {
      expiresAt: later,
      key: "offline.write",
      value: true,
    };
    const states: BillingFacts["state"][] = [
      "free",
      "trial_setup",
      "trialing",
      "active",
      "grace",
      "free_over_limit",
    ];
    for (const state of states) {
      for (const accessEndsAt of [null, earlier, later]) {
        for (const grants of [[], [grant]]) {
          const effective = resolve({ accessEndsAt, state }, grants);
          expect(Object.keys(effective.values).sort()).toEqual(
            [...ENTITLEMENT_KEYS].sort()
          );
          expect(effective.plan).toBe(
            planInForce({ accessEndsAt, state }, now)
          );
          for (const key of ENTITLEMENT_KEYS) {
            const planValue = INITIAL_PLAN_CATALOG[effective.plan][key];
            expect(Number(effective.values[key])).toBeGreaterThanOrEqual(
              Number(planValue)
            );
          }
        }
      }
    }
  });
});

describe("assertions", () => {
  const free = resolve({ accessEndsAt: null, state: "free" });
  const pro = resolve({ accessEndsAt: later, state: "active" });

  it("refuses a flag the plan does not have, with the key", () => {
    expect(() => assertFlag(pro, "offline.write")).not.toThrow();
    expect(() => assertFlag(free, "offline.write")).toThrow(
      EntitlementDeniedError
    );
    try {
      assertFlag(free, "public_catalog");
      expect.unreachable();
    } catch (error) {
      expect((error as EntitlementDeniedError).key).toBe("public_catalog");
    }
  });

  it("allows additions up to the limit and refuses the one past it, even already over it", () => {
    expect(() =>
      assertWithinLimit(free, "variants.active.max", 49)
    ).not.toThrow();
    expect(() => assertWithinLimit(free, "variants.active.max", 50)).toThrow(
      EntitlementLimitReachedError
    );
    // already over the limit after a downgrade: nothing more may be added
    expect(() => assertWithinLimit(free, "variants.active.max", 80)).toThrow(
      EntitlementLimitReachedError
    );
    expect(() =>
      assertWithinLimit(free, "variants.active.max", 45, 5)
    ).not.toThrow();
    // adding nothing is allowed even when already over the limit
    expect(() =>
      assertWithinLimit(free, "variants.active.max", 80, 0)
    ).not.toThrow();
    expect(() => assertWithinLimit(free, "variants.active.max", 45, 6)).toThrow(
      EntitlementLimitReachedError
    );
  });
});

describe("planCatalogFromRows", () => {
  const rows = (): PlanEntitlementRow[] =>
    (["free", "pro"] as const).flatMap((planId) =>
      ENTITLEMENT_KEYS.map((key) => {
        const value = INITIAL_PLAN_CATALOG[planId][key];
        return {
          flagValue: typeof value === "boolean" ? value : null,
          key,
          limitValue: typeof value === "number" ? value : null,
          planId,
        };
      })
    );

  it("rebuilds the initial catalog from its rows", () => {
    expect(planCatalogFromRows(rows())).toEqual(INITIAL_PLAN_CATALOG);
  });

  it("fails closed on a missing key, a missing plan, a missing value or an unknown row", () => {
    expect(() =>
      planCatalogFromRows(
        rows().filter(
          (row) => !(row.planId === "pro" && row.key === "variants.active.max")
        )
      )
    ).toThrow(IncompletePlanCatalogError);
    expect(() =>
      planCatalogFromRows(rows().filter((row) => row.planId !== "pro"))
    ).toThrow(IncompletePlanCatalogError);
    expect(() =>
      planCatalogFromRows(
        rows().map((row) =>
          row.key === "images.active.max" ? { ...row, limitValue: null } : row
        )
      )
    ).toThrow(IncompletePlanCatalogError);
    expect(() =>
      planCatalogFromRows([
        ...rows(),
        {
          flagValue: true,
          key: "unknown.key",
          limitValue: null,
          planId: "pro",
        },
      ])
    ).toThrow(IncompletePlanCatalogError);
    expect(() => planCatalogFromRows([])).toThrow(IncompletePlanCatalogError);
  });
});

describe("safety of the resolved values", () => {
  it("a limit that is not a number refuses the addition instead of allowing it", () => {
    const broken = {
      ...resolve({ accessEndsAt: null, state: "free" }),
      values: {
        ...INITIAL_PLAN_CATALOG.free,
        "variants.active.max": undefined as unknown as number,
      },
    };
    expect(() => assertWithinLimit(broken, "variants.active.max", 0)).toThrow(
      EntitlementLimitReachedError
    );
  });

  it("the end date handed out is a copy of the record's", () => {
    const record = new Date(later);
    const effective = resolve({ accessEndsAt: record, state: "active" });
    effective.accessEndsAt?.setTime(0);
    expect(record.getTime()).toBe(later.getTime());
  });
});
