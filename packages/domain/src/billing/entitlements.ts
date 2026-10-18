/**
 * Plans and entitlements (plan PR72 and PR73). The commercial values (which
 * limits each plan has) are data in the database, adjustable without a deploy;
 * this module is the shape of that data and the pure rule that turns a plan, a
 * subscription state and temporary grants into what an organization may do
 * right now. Nothing here reads a clock or a database.
 *
 * Principles (docs/business-rules/billing-and-entitlements.md): the provider
 * reports facts but never grants access; Polaris derives entitlements from its
 * own records; a downgrade keeps the data and only restricts new operations.
 */
export const PLAN_IDS = ["free", "pro"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

/** Numeric limits: the most the organization may have (or have per product). */
export const LIMIT_KEYS = [
  "goals.active.max",
  "images.active.max",
  "images.per_product.max",
  "variants.active.max",
] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];

/** Yes/no capabilities of the plan. */
export const FLAG_KEYS = ["offline.write", "public_catalog"] as const;
export type FlagKey = (typeof FLAG_KEYS)[number];

export type EntitlementKey = FlagKey | LimitKey;
export const ENTITLEMENT_KEYS: readonly EntitlementKey[] = [
  ...LIMIT_KEYS,
  ...FLAG_KEYS,
];

export type PlanEntitlements = Readonly<
  Record<LimitKey, number> & Record<FlagKey, boolean>
>;

/** Every plan with all of its entitlements. */
export type PlanCatalog = Readonly<Record<PlanId, PlanEntitlements>>;

/**
 * The initial commercial hypotheses (PRODUCT.md), used to seed the catalog and
 * as the fixture of the tests. The database is the live source: the gate
 * checks the seed against this constant so they cannot drift apart unnoticed.
 */
export const INITIAL_PLAN_CATALOG: PlanCatalog = Object.freeze({
  free: Object.freeze({
    "goals.active.max": 1,
    "images.active.max": 50,
    "images.per_product.max": 1,
    "offline.write": false,
    public_catalog: false,
    "variants.active.max": 50,
  }),
  pro: Object.freeze({
    "goals.active.max": 3,
    "images.active.max": 5000,
    "images.per_product.max": 10,
    "offline.write": true,
    public_catalog: true,
    "variants.active.max": 2000,
  }),
});

export interface PlanEntitlementRow {
  flagValue: boolean | null;
  key: string;
  limitValue: number | null;
  planId: string;
}

export class IncompletePlanCatalogError extends Error {
  readonly code = "plan_catalog_incomplete";

  constructor(detail: string) {
    super(`plan_catalog_incomplete: ${detail}`);
    this.name = "IncompletePlanCatalogError";
  }
}

/**
 * Builds the catalog from stored rows and refuses anything but a complete one:
 * every plan must have every key with a value of the right kind. A missing
 * limit would otherwise read as no limit at all, so a damaged catalog fails
 * closed instead of granting more.
 */
export function planCatalogFromRows(
  rows: readonly PlanEntitlementRow[]
): PlanCatalog {
  const plans = new Map<string, Record<string, boolean | number>>();
  for (const row of rows) {
    if (!(isPlanId(row.planId) && isEntitlementKey(row.key))) {
      throw new IncompletePlanCatalogError("unrecognized row");
    }
    const value = isLimitKey(row.key) ? row.limitValue : row.flagValue;
    if (value === null) {
      throw new IncompletePlanCatalogError(`no value for ${row.key}`);
    }
    const plan = plans.get(row.planId) ?? {};
    plan[row.key] = value;
    plans.set(row.planId, plan);
  }
  const catalog: Partial<Record<PlanId, PlanEntitlements>> = {};
  for (const planId of PLAN_IDS) {
    const plan = plans.get(planId);
    for (const key of ENTITLEMENT_KEYS) {
      if (plan?.[key] === undefined) {
        throw new IncompletePlanCatalogError(`${planId} lacks ${key}`);
      }
    }
    catalog[planId] = Object.freeze({ ...plan }) as unknown as PlanEntitlements;
  }
  return catalog as PlanCatalog;
}

function isPlanId(value: string): value is PlanId {
  return (PLAN_IDS as readonly string[]).includes(value);
}

export function isEntitlementKey(value: string): value is EntitlementKey {
  return (ENTITLEMENT_KEYS as readonly string[]).includes(value);
}

export function isLimitKey(key: EntitlementKey): key is LimitKey {
  return (LIMIT_KEYS as readonly string[]).includes(key);
}

/**
 * A temporary grant (support, a promotion): it raises one entitlement until it
 * expires and never lowers it. A grant has an end by design: a permanent
 * change is a plan change.
 */
export interface EntitlementGrant {
  expiresAt: Date;
  key: EntitlementKey;
  /** From when it counts; a grant that has not started yet changes nothing. */
  startsAt?: Date;
  /** A limit for a limit key, true for a flag. */
  value: boolean | number;
}

/** What the organization's billing record says (never what the provider just reported). */
export interface BillingFacts {
  /** When Pro access ends unless renewed (trial end, period end or grace end); null for free states. */
  accessEndsAt: Date | null;
  state: BillingState;
}

export const BILLING_STATES = [
  "free",
  "trial_setup",
  "trialing",
  "active",
  "grace",
  "free_over_limit",
] as const;
export type BillingState = (typeof BILLING_STATES)[number];

/** True while the state grants Pro (for as long as its end date lies ahead). */
export function grantsPro(state: BillingState): boolean {
  return state === "trialing" || state === "active" || state === "grace";
}

export interface EffectiveEntitlements {
  /** When the effective Pro access ends; null when it does not (free) . */
  accessEndsAt: Date | null;
  /** The entitlements in force now, plan and grants combined. */
  values: PlanEntitlements;
  /** The plan the organization is on right now. */
  plan: PlanId;
  /**
   * True after a downgrade while the organization still holds more than the
   * free limits allow: nothing is deleted, but new operations that would add
   * to what is over the limit are refused.
   */
  overLimit: boolean;
  /** Which entitlements a grant raised above the plan's value. */
  raisedByGrant: readonly EntitlementKey[];
  state: BillingState;
}

export interface ResolveEntitlementsInput {
  catalog: PlanCatalog;
  facts: BillingFacts;
  grants?: readonly EntitlementGrant[];
  now: Date;
}

/** The plan in force for a state at a moment: Pro only while its end date has not passed. */
export function planInForce(facts: BillingFacts, now: Date): PlanId {
  if (
    grantsPro(facts.state) &&
    facts.accessEndsAt !== null &&
    now.getTime() < facts.accessEndsAt.getTime()
  ) {
    return "pro";
  }
  return "free";
}

/**
 * The effective entitlements: the plan in force at `now` (a trial, period or
 * grace that has run out counts as free even if the record was not updated
 * yet), raised by any unexpired grant. A grant can only raise: the largest
 * limit wins and a flag turns on, never off.
 */
export function resolveEntitlements(
  input: ResolveEntitlementsInput
): EffectiveEntitlements {
  const plan = planInForce(input.facts, input.now);
  const values: Record<string, boolean | number> = {
    ...input.catalog[plan],
  };
  const raised: EntitlementKey[] = [];
  for (const grant of input.grants ?? []) {
    if (
      input.now.getTime() >= grant.expiresAt.getTime() ||
      (grant.startsAt !== undefined &&
        input.now.getTime() < grant.startsAt.getTime())
    ) {
      continue;
    }
    const current = values[grant.key];
    if (isLimitKey(grant.key)) {
      if (
        typeof grant.value === "number" &&
        typeof current === "number" &&
        grant.value > current
      ) {
        values[grant.key] = grant.value;
        raised.push(grant.key);
      }
    } else if (grant.value === true && current === false) {
      values[grant.key] = true;
      raised.push(grant.key);
    }
  }
  return {
    accessEndsAt:
      plan === "pro" && input.facts.accessEndsAt
        ? new Date(input.facts.accessEndsAt.getTime())
        : null,
    overLimit: input.facts.state === "free_over_limit" && plan === "free",
    plan,
    raisedByGrant: raised,
    state: input.facts.state,
    values: values as unknown as PlanEntitlements,
  };
}

export class EntitlementDeniedError extends Error {
  readonly code = "entitlement_denied";
  readonly key: EntitlementKey;

  constructor(key: EntitlementKey, options?: ErrorOptions) {
    super("entitlement_denied", options);
    this.name = "EntitlementDeniedError";
    this.key = key;
  }
}

/** A flag the plan does not have: the operation is refused (not hidden in the UI only). */
export function assertFlag(
  entitlements: EffectiveEntitlements,
  key: FlagKey
): void {
  if (entitlements.values[key] !== true) {
    throw new EntitlementDeniedError(key);
  }
}

export class EntitlementLimitReachedError extends Error {
  readonly code = "entitlement_limit_reached";
  readonly key: LimitKey;
  readonly limit: number;

  constructor(key: LimitKey, limit: number, options?: ErrorOptions) {
    super("entitlement_limit_reached", options);
    this.name = "EntitlementLimitReachedError";
    this.key = key;
    this.limit = limit;
  }
}

/**
 * Whether adding `adding` more to `current` stays within the limit. Existing
 * content above the limit is never touched: only additions are refused.
 */
export function assertWithinLimit(
  entitlements: EffectiveEntitlements,
  key: LimitKey,
  current: number,
  adding = 1
): void {
  // taking nothing away or adding nothing is not an addition, even over the limit
  if (adding <= 0) {
    return;
  }
  const limit = entitlements.values[key];
  // a limit that is not a number is a broken catalog: refuse, never allow
  if (!Number.isFinite(limit) || current + adding > limit) {
    throw new EntitlementLimitReachedError(key, limit);
  }
}
