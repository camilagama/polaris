import {
  type Arbitrary,
  array,
  boolean,
  constant,
  constantFrom,
  integer,
  oneof,
  property,
  record,
  shuffledSubarray,
  tuple,
} from "fast-check";
import { describe, expect, it } from "vitest";
import { assertProperty } from "../testing/property";
import {
  assertFlag,
  assertWithinLimit,
  BILLING_STATES,
  type BillingFacts,
  type BillingState,
  ENTITLEMENT_KEYS,
  EntitlementDeniedError,
  type EntitlementGrant,
  type EntitlementKey,
  EntitlementLimitReachedError,
  FLAG_KEYS,
  IncompletePlanCatalogError,
  LIMIT_KEYS,
  type LimitKey,
  PLAN_IDS,
  type PlanCatalog,
  type PlanEntitlementRow,
  type PlanEntitlements,
  type PlanId,
  planCatalogFromRows,
  planInForce,
  resolveEntitlements,
} from "./entitlements";

/*
 * Invariants of plans and entitlements (docs/testing/property-invariants.md, ENT-1 to ENT-6). The
 * oracle is a small model written here: the plan in force is a table over the state, and each
 * entitlement is the larger of the plan's value and the active grants' values.
 */

const HOUR_MS = 3_600_000;
const NOW = new Date("2026-10-20T12:00:00.000Z");

const planEntitlements = record({
  "goals.active.max": integer({ max: 100, min: 0 }),
  "images.active.max": integer({ max: 10_000, min: 0 }),
  "images.per_product.max": integer({ max: 50, min: 0 }),
  "offline.write": boolean(),
  public_catalog: boolean(),
  "variants.active.max": integer({ max: 5000, min: 0 }),
}) as unknown as Arbitrary<PlanEntitlements>;

// A catalog that is not the real one, so the model cannot lean on the shape of the seed.
const catalog = record({
  free: planEntitlements,
  pro: planEntitlements,
}) as unknown as Arbitrary<PlanCatalog>;

const offsetFromNow = oneof(
  integer({ max: 200 * HOUR_MS, min: -200 * HOUR_MS }),
  constantFrom(-1, 0, 1)
);
const billingFacts = tuple(
  constantFrom(...BILLING_STATES),
  oneof(constant(null), offsetFromNow)
).map(
  ([state, offset]): BillingFacts => ({
    accessEndsAt: offset === null ? null : new Date(NOW.getTime() + offset),
    state,
  })
);

const grant = tuple(
  constantFrom(...ENTITLEMENT_KEYS),
  integer({ max: 12_000, min: 0 }),
  boolean(),
  offsetFromNow,
  oneof(constant(null), offsetFromNow)
).map(([key, limit, flag, expiresOffset, startsOffset]): EntitlementGrant => {
  const isLimit = (LIMIT_KEYS as readonly string[]).includes(key);
  return {
    expiresAt: new Date(NOW.getTime() + expiresOffset),
    key,
    ...(startsOffset === null
      ? {}
      : { startsAt: new Date(NOW.getTime() + startsOffset) }),
    value: isLimit ? limit : flag,
  };
});

/** The states that give Pro while their end date lies ahead, as a table. */
const GRANTS_PRO: Readonly<Record<BillingState, boolean>> = {
  active: true,
  free: false,
  free_over_limit: false,
  grace: true,
  trial_setup: false,
  trialing: true,
};

function modelPlan(facts: BillingFacts): PlanId {
  return GRANTS_PRO[facts.state] &&
    facts.accessEndsAt !== null &&
    NOW.getTime() < facts.accessEndsAt.getTime()
    ? "pro"
    : "free";
}

function activeGrants(grants: readonly EntitlementGrant[]): EntitlementGrant[] {
  return grants.filter(
    (candidate) =>
      NOW.getTime() < candidate.expiresAt.getTime() &&
      (candidate.startsAt === undefined ||
        NOW.getTime() >= candidate.startsAt.getTime())
  );
}

describe("the plan in force (ENT-1)", () => {
  it("ENT-1: Pro only while a Pro state has an end date still ahead; every other state and a lapsed date is Free", () => {
    assertProperty(
      property(billingFacts, (facts) => {
        expect(planInForce(facts, NOW)).toBe(modelPlan(facts));
      })
    );
  });
});

describe("resolved entitlements (ENT-2 to ENT-4)", () => {
  it("ENT-2: every key is the larger of the plan's value and the active grants' values (a flag: on if either is), and a grant never lowers anything", () => {
    assertProperty(
      property(
        catalog,
        billingFacts,
        array(grant, { maxLength: 8 }),
        (plans, facts, grants) => {
          const resolved = resolveEntitlements({
            catalog: plans,
            facts,
            grants,
            now: NOW,
          });
          const plan = modelPlan(facts);
          const base = plans[plan] as Record<EntitlementKey, boolean | number>;
          const live = activeGrants(grants);
          const raised: EntitlementKey[] = [];
          for (const key of ENTITLEMENT_KEYS) {
            const fromGrants = live
              .filter((candidate) => candidate.key === key)
              .map((candidate) => candidate.value);
            const planValue = base[key];
            const expected =
              typeof planValue === "number"
                ? Math.max(
                    planValue,
                    ...fromGrants.filter(
                      (value): value is number => typeof value === "number"
                    )
                  )
                : planValue || fromGrants.includes(true);
            expect(
              (resolved.values as Record<string, boolean | number>)[key]
            ).toBe(expected);
            if (expected !== planValue) {
              raised.push(key);
            }
          }
          expect(resolved.plan).toBe(plan);
          expect(new Set(resolved.raisedByGrant)).toEqual(new Set(raised));
          expect(resolved.state).toBe(facts.state);
          expect(resolved.overLimit).toBe(
            facts.state === "free_over_limit" && plan === "free"
          );
          expect(resolved.accessEndsAt?.getTime() ?? null).toBe(
            plan === "pro" ? (facts.accessEndsAt?.getTime() ?? null) : null
          );
        }
      )
    );
  });

  it("ENT-3: the order of the grants does not change what is resolved", () => {
    assertProperty(
      property(
        catalog,
        billingFacts,
        array(grant, { maxLength: 8 }).chain((grants) =>
          shuffledSubarray(grants, {
            maxLength: grants.length,
            minLength: grants.length,
          }).map((shuffled) => ({ grants, shuffled }))
        ),
        (plans, facts, { grants, shuffled }) => {
          const first = resolveEntitlements({
            catalog: plans,
            facts,
            grants,
            now: NOW,
          });
          const second = resolveEntitlements({
            catalog: plans,
            facts,
            grants: shuffled,
            now: NOW,
          });
          expect(second.values).toEqual(first.values);
          expect(new Set(second.raisedByGrant)).toEqual(
            new Set(first.raisedByGrant)
          );
        }
      )
    );
  });

  it("ENT-4: resolving changes neither the catalog nor the grants, hands out its own copy of the end date, and with no grants gives exactly the plan", () => {
    assertProperty(
      property(
        catalog,
        billingFacts,
        array(grant, { maxLength: 6 }),
        (plans, facts, grants) => {
          const before = JSON.stringify({ grants, plans });
          const resolved = resolveEntitlements({
            catalog: plans,
            facts,
            grants,
            now: NOW,
          });
          expect(JSON.stringify({ grants, plans })).toBe(before);
          // a copy of the end date, never the record's own object
          if (resolved.accessEndsAt && facts.accessEndsAt) {
            expect(resolved.accessEndsAt).not.toBe(facts.accessEndsAt);
          }
          // with no grants, the resolved values are exactly the plan's
          const bare = resolveEntitlements({ catalog: plans, facts, now: NOW });
          expect(bare.values).toEqual(plans[modelPlan(facts)]);
          expect(bare.raisedByGrant).toEqual([]);
        }
      )
    );
  });
});

describe("limits and flags (ENT-5)", () => {
  it("ENT-5: an addition is refused exactly when it would pass the limit (a flag exactly when it is not on), and taking away or adding nothing is never refused", () => {
    assertProperty(
      property(
        catalog,
        billingFacts,
        constantFrom(...LIMIT_KEYS),
        constantFrom(...FLAG_KEYS),
        integer({ max: 6000, min: 0 }),
        constantFrom(-2, -1, 0, 1, 2),
        integer({ max: 20, min: -5 }),
        (plans, facts, limitKey, flagKey, anyCurrent, edge, adding) => {
          const resolved = resolveEntitlements({
            catalog: plans,
            facts,
            now: NOW,
          });
          const limit = resolved.values[limitKey as LimitKey];
          // half the cases sit right at the limit (one either side), where an off-by-one would show
          const current =
            anyCurrent % 2 === 0
              ? anyCurrent
              : Math.max(0, limit - Math.max(adding, 1) + edge);
          const run = () =>
            assertWithinLimit(resolved, limitKey as LimitKey, current, adding);
          if (adding > 0 && current + adding > limit) {
            expect(run).toThrow(EntitlementLimitReachedError);
          } else {
            expect(run).not.toThrow();
          }
          const flag = resolved.values[flagKey];
          const runFlag = () => assertFlag(resolved, flagKey);
          if (flag === true) {
            expect(runFlag).not.toThrow();
          } else {
            expect(runFlag).toThrow(EntitlementDeniedError);
          }
        }
      )
    );
  });
});

describe("the stored catalog (ENT-6)", () => {
  function rowsOf(plans: PlanCatalog): PlanEntitlementRow[] {
    return PLAN_IDS.flatMap((planId) =>
      ENTITLEMENT_KEYS.map((key) => {
        const value = (plans[planId] as Record<string, boolean | number>)[key];
        return {
          flagValue: typeof value === "boolean" ? value : null,
          key,
          limitValue: typeof value === "number" ? value : null,
          planId,
        };
      })
    );
  }

  it("ENT-6: any catalog survives being stored as rows in any order, and a catalog with one value missing is refused instead of read as no limit", () => {
    assertProperty(
      property(catalog, integer({ max: 1000, min: 0 }), (plans, pick) => {
        const rows = rowsOf(plans);
        expect(planCatalogFromRows(rows)).toEqual(plans);
        expect(planCatalogFromRows([...rows].reverse())).toEqual(plans);
        const index = pick % rows.length;
        const without = rows.filter((_, position) => position !== index);
        expect(() => planCatalogFromRows(without)).toThrow(
          IncompletePlanCatalogError
        );
        const emptied = rows.map((row, position) =>
          position === index
            ? { ...row, flagValue: null, limitValue: null }
            : row
        );
        expect(() => planCatalogFromRows(emptied)).toThrow(
          IncompletePlanCatalogError
        );
      })
    );
  });
});
