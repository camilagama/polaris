import { type BillingState, grantsPro, type PlanId } from "./entitlements";

/**
 * Free Over Limit (plan PR82). An organization that leaves Pro holding more
 * variants than Free allows keeps all of them, visible, with their history, but
 * only the limit's worth stay *operational*: the rest cannot receive new
 * commercial activity (a sale, a stock receipt). Which ones stay is the
 * organization's choice, kept apart from the variants themselves (a variant has
 * no "locked" property: the selection is the record), and it is frozen once a
 * short adaptation window has passed, so that unlocking one to sell it and
 * locking it again to unlock another never works around the plan.
 *
 * Pure rules only: nothing here reads a clock or a database.
 */

/** How long the organization may adapt (choose what stays) after leaving Pro. */
export const ADAPTATION_DAYS = 7;

const DAY = 86_400_000;

/**
 * - `unrestricted`: Pro, or within the limit: every variant is operational.
 * - `adapting`: over the limit inside the window: every variant is still
 *   operational and the choice may be replaced freely.
 * - `frozen`: over the limit after the window: only the selection is
 *   operational, and it can only grow (up to the limit).
 */
export type OperationalPhase = "adapting" | "frozen" | "unrestricted";

export interface EpisodeFacts {
  /** When Pro access ends (or ended), for the states that grant it. */
  accessEndsAt: Date | null;
  /** When the free episode began, as the billing record stored it. */
  overLimitSince: Date | null;
  state: BillingState;
}

/**
 * When the current "left Pro" episode began: the end of the Pro access (a lapse
 * not yet swept into the record counts from the same moment the sweep will
 * store), or what the record says once it is free. Null when nothing says: the
 * adaptation window is then treated as over, never as open.
 */
export function episodeStart(facts: EpisodeFacts): Date | null {
  return grantsPro(facts.state) ? facts.accessEndsAt : facts.overLimitSince;
}

/**
 * What the record's `over_limit_since` must become when the state changes: null
 * once the organization has Pro access again, `"keep"` while the episode goes on
 * (still over the limits, or setting up a trial: opening a trial checkout and
 * abandoning it must not restart the adaptation window), and the moment Pro
 * access ended when the organization has just left it (the end of a lapsed
 * access, or now when access was removed early or it was already free).
 */
export function episodeStartAfter(input: {
  before: { accessEndsAt: Date | null; state: BillingState };
  nextState: BillingState;
  now: Date;
}): Date | "keep" | null {
  if (
    input.nextState !== "free_over_limit" &&
    input.nextState !== "trial_setup"
  ) {
    return null;
  }
  if (
    input.before.state === "free_over_limit" ||
    input.before.state === "trial_setup"
  ) {
    return "keep";
  }
  if (input.nextState === "trial_setup") {
    // a free organization that is not over the limits has no episode to keep
    return null;
  }
  if (grantsPro(input.before.state) && input.before.accessEndsAt) {
    return input.before.accessEndsAt.getTime() < input.now.getTime()
      ? input.before.accessEndsAt
      : input.now;
  }
  return input.now;
}

export interface OperationalContext {
  /** The variants limit in force (plan and grants). */
  limit: number;
  /** Variants of products that were not deleted (archived ones count). */
  liveVariants: number;
  now: Date;
  plan: PlanId;
  /** From `episodeStart`. */
  since: Date | null;
}

export interface OperationalState {
  phase: OperationalPhase;
  /** The end of the adaptation window; null when there is none (unrestricted, or no start recorded). */
  windowEndsAt: Date | null;
}

export function operationalState(
  context: OperationalContext
): OperationalState {
  if (context.plan !== "free" || context.liveVariants <= context.limit) {
    return { phase: "unrestricted", windowEndsAt: null };
  }
  if (context.since === null) {
    return { phase: "frozen", windowEndsAt: null };
  }
  const windowEndsAt = new Date(
    context.since.getTime() + ADAPTATION_DAYS * DAY
  );
  return {
    phase:
      context.now.getTime() < windowEndsAt.getTime() ? "adapting" : "frozen",
    windowEndsAt,
  };
}

export type SelectionRefusalCode =
  /** There is nothing to choose: the plan allows everything the organization holds. */
  | "nothing_to_select"
  /** Chosen variants outnumber the limit. */
  | "selection_too_large"
  /** After the adaptation window the choice cannot drop a variant it already holds. */
  | "selection_frozen"
  /** A chosen variant does not exist or belongs to a deleted product. */
  | "variant_unavailable";

export class OperationalSelectionError extends Error {
  readonly code: SelectionRefusalCode;

  constructor(code: SelectionRefusalCode) {
    super(code);
    this.name = "OperationalSelectionError";
    this.code = code;
  }
}

/** A sale or stock receipt that touches a variant the plan no longer keeps operational. */
export class EntitlementVariantLockedError extends Error {
  readonly code = "entitlement_variant_locked";
  readonly variantId: string;

  constructor(variantId: string, options?: ErrorOptions) {
    super("entitlement_variant_locked", options);
    this.name = "EntitlementVariantLockedError";
    this.variantId = variantId;
  }
}

export interface SelectionChangeInput {
  /** The variants currently selected (live or not). */
  current: ReadonlySet<string>;
  limit: number;
  /** Variants that exist and belong to products that were not deleted. */
  live: ReadonlySet<string>;
  phase: OperationalPhase;
  /** The complete selection the organization wants. */
  requested: readonly string[];
}

export interface SelectionChange {
  add: string[];
  remove: string[];
}

/**
 * What to write so that the selection becomes `requested`. While adapting the
 * choice is replaced; once frozen it can only grow, so a request that leaves out
 * a variant it already holds is refused. A variant that was deleted since it was
 * chosen no longer counts and is dropped quietly.
 */
export function planSelectionChange(
  input: SelectionChangeInput
): SelectionChange {
  if (input.phase === "unrestricted") {
    throw new OperationalSelectionError("nothing_to_select");
  }
  const requested = new Set(input.requested);
  for (const id of requested) {
    if (!input.live.has(id)) {
      throw new OperationalSelectionError("variant_unavailable");
    }
  }
  if (requested.size > input.limit) {
    throw new OperationalSelectionError("selection_too_large");
  }
  const heldLive = [...input.current].filter((id) => input.live.has(id));
  if (input.phase === "frozen" && heldLive.some((id) => !requested.has(id))) {
    throw new OperationalSelectionError("selection_frozen");
  }
  return {
    add: [...requested].filter((id) => !input.current.has(id)),
    remove: [...input.current].filter((id) => !requested.has(id)),
  };
}

export interface DefaultCandidate {
  /** The product is archived: it cannot be sold, so its variants rank after every other one. */
  archived: boolean;
  createdAt: Date;
  /** The latest confirmed sale of the variant, if any. */
  lastSoldAt: Date | null;
  variantId: string;
}

/**
 * What stays operational for an organization that chose nothing in the window:
 * the variants sold most recently, then the oldest, so a shop keeps selling what
 * it was selling (variants of archived products come last: they cannot be sold).
 * Deterministic: the same candidates always give the same set.
 */
export function defaultSelection(
  candidates: readonly DefaultCandidate[],
  limit: number
): string[] {
  return [...candidates]
    .sort((left, right) => {
      const leftSold = left.lastSoldAt?.getTime() ?? Number.NEGATIVE_INFINITY;
      const rightSold = right.lastSoldAt?.getTime() ?? Number.NEGATIVE_INFINITY;
      return (
        Number(left.archived) - Number(right.archived) ||
        rightSold - leftSold ||
        left.createdAt.getTime() - right.createdAt.getTime() ||
        left.variantId.localeCompare(right.variantId)
      );
    })
    .slice(0, Math.max(0, limit))
    .map((candidate) => candidate.variantId);
}
