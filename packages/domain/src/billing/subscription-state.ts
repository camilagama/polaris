import {
  type BillingFacts,
  type BillingState,
  grantsPro,
} from "./entitlements";

/**
 * The state machine of an organization's subscription (plan PR76). It is pure
 * and provider-independent: the events are facts Polaris has already validated
 * and deduplicated (a webhook never moves state by itself), and no payment is
 * integrated here.
 *
 *   free ──start_trial──▶ trial_setup ──renewal_ready──▶ trialing
 *     ▲                       │ abandon                     │ payment_succeeded
 *     │                       ▼                             ▼
 *     │                     free        free ──subscribe──▶ active ◀─┐
 *     │                                                  │          │ payment_succeeded
 *     │  period_ended / grace_expired                    │ payment_failed
 *     └──────────── free | free_over_limit ◀── grace ◀───┘
 *
 * Leaving Pro always lands on `free`, or on `free_over_limit` when the
 * organization holds more than the free limits allow (the data is kept; only
 * new operations are restricted). Pro access always has an end date; a state
 * that grants it without one is invalid.
 *
 * The machine also defends access against stale or early facts: a payment
 * never moves the end of access backwards, a failure never shortens the period
 * already paid for, and the events that end access are refused before the end
 * date they would apply to.
 */
export const TRIAL_DAYS = 7;
export const GRACE_DAYS = 7;
/** The longest paid period (a year) plus a margin for the provider's own rounding. */
export const MAX_PERIOD_DAYS = 400;

export type BillingEvent =
  | { type: "abandon_trial_setup" }
  | { type: "grace_expired" }
  | { type: "payment_failed" }
  | {
      /** The provider-confirmed end of the period that was just paid for. */
      periodEndsAt: Date;
      type: "payment_succeeded";
    }
  | { type: "period_ended" }
  | { type: "renewal_ready" }
  | { type: "start_trial" }
  | {
      periodEndsAt: Date;
      type: "subscribe";
    }
  | { type: "trial_ended_without_payment" }
  | { type: "usage_changed" };

export interface TransitionContext {
  now: Date;
  /** True when the organization holds more than the free plan allows. */
  overFreeLimits: boolean;
  /** True once the organization has had a trial: it is offered once. */
  trialConsumed?: boolean;
}

export class InvalidBillingTransitionError extends Error {
  readonly code = "invalid_billing_transition";
  readonly state: BillingState;
  readonly event: BillingEvent["type"];

  constructor(state: BillingState, event: BillingEvent["type"]) {
    super("invalid_billing_transition");
    this.name = "InvalidBillingTransitionError";
    this.state = state;
    this.event = event;
  }
}

type RejectionCode =
  | "event_not_due"
  | "invalid_period_end"
  | "stale_period_end"
  | "trial_already_consumed";

/** A fact that fits the state but is wrong in itself: a bad, stale or early date, or a second trial. */
export class RejectedBillingEventError extends Error {
  readonly code: RejectionCode;
  readonly state: BillingState;
  readonly event: BillingEvent["type"];

  constructor(
    code: RejectionCode,
    state: BillingState,
    event: BillingEvent["type"]
  ) {
    super(code);
    this.name = "RejectedBillingEventError";
    this.code = code;
    this.state = state;
    this.event = event;
  }
}

const DAY = 86_400_000;

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY);
}

function freeState(context: TransitionContext): BillingFacts {
  return {
    accessEndsAt: null,
    state: context.overFreeLimits ? "free_over_limit" : "free",
  };
}

type Transition = (
  facts: BillingFacts,
  event: BillingEvent,
  context: TransitionContext
) => BillingFacts;

const FREE_STATES: readonly BillingState[] = ["free", "free_over_limit"];

/** The provider-confirmed end of a paid period: a real date, in the future, within a year or so. */
function checkedPeriodEnd(
  facts: BillingFacts,
  event: BillingEvent,
  context: TransitionContext
): Date {
  const reject = (code: RejectionCode) =>
    new RejectedBillingEventError(code, facts.state, event.type);
  if (event.type !== "subscribe" && event.type !== "payment_succeeded") {
    throw reject("invalid_period_end");
  }
  const end = event.periodEndsAt.getTime();
  if (
    !Number.isFinite(end) ||
    end <= context.now.getTime() ||
    end > addDays(context.now, MAX_PERIOD_DAYS).getTime()
  ) {
    throw reject("invalid_period_end");
  }
  // an old or duplicated payment never moves the end of access backwards
  if (
    facts.state === "active" &&
    facts.accessEndsAt !== null &&
    end <= facts.accessEndsAt.getTime()
  ) {
    throw reject("stale_period_end");
  }
  return new Date(end);
}

/** An event that ends access is refused until the access it ends has run out. */
function requireDue(
  facts: BillingFacts,
  event: BillingEvent,
  context: TransitionContext
): void {
  if (
    facts.accessEndsAt === null ||
    context.now.getTime() < facts.accessEndsAt.getTime()
  ) {
    throw new RejectedBillingEventError(
      "event_not_due",
      facts.state,
      event.type
    );
  }
}

const TRANSITIONS: Record<
  BillingEvent["type"],
  { from: readonly BillingState[]; to: Transition }
> = {
  // the trial is the person's choice, offered once, and needs a renewal method first
  start_trial: {
    from: FREE_STATES,
    to: (facts, event, context) => {
      if (context.trialConsumed) {
        throw new RejectedBillingEventError(
          "trial_already_consumed",
          facts.state,
          event.type
        );
      }
      return { accessEndsAt: null, state: "trial_setup" };
    },
  },
  abandon_trial_setup: {
    from: ["trial_setup"],
    to: (_facts, _event, context) => freeState(context),
  },
  renewal_ready: {
    from: ["trial_setup"],
    to: (_facts, _event, context) => ({
      accessEndsAt: addDays(context.now, TRIAL_DAYS),
      state: "trialing",
    }),
  },
  trial_ended_without_payment: {
    from: ["trialing"],
    to: (facts, event, context) => {
      requireDue(facts, event, context);
      return freeState(context);
    },
  },
  // paying directly, with or without a trial
  subscribe: {
    from: [...FREE_STATES, "trial_setup"],
    to: (facts, event, context) => ({
      accessEndsAt: checkedPeriodEnd(facts, event, context),
      state: "active",
    }),
  },
  // a trial converting, a renewal, or a recovery from grace
  payment_succeeded: {
    from: ["trialing", "active", "grace"],
    to: (facts, event, context) => ({
      accessEndsAt: checkedPeriodEnd(facts, event, context),
      state: "active",
    }),
  },
  // grace starts when the paid period ends; an early failure never shortens it
  payment_failed: {
    from: ["active"],
    to: (facts, _event, context) => {
      const base = Math.max(
        context.now.getTime(),
        facts.accessEndsAt?.getTime() ?? 0
      );
      return {
        accessEndsAt: addDays(new Date(base), GRACE_DAYS),
        state: "grace",
      };
    },
  },
  grace_expired: {
    from: ["grace"],
    to: (facts, event, context) => {
      requireDue(facts, event, context);
      return freeState(context);
    },
  },
  // a subscription that was cancelled and ran to the end of what was paid
  period_ended: {
    from: ["active"],
    to: (facts, event, context) => {
      requireDue(facts, event, context);
      return freeState(context);
    },
  },
  // only the free states follow the usage; Pro states are not about limits
  usage_changed: {
    from: FREE_STATES,
    to: (_facts, _event, context) => freeState(context),
  },
};

/**
 * Applies an event to the billing facts. An event that does not apply to the
 * current state is refused (a duplicate or out-of-order event must have been
 * handled before it gets here), never silently ignored.
 */
export function applyBillingEvent(
  facts: BillingFacts,
  event: BillingEvent,
  context: TransitionContext
): BillingFacts {
  const transition = TRANSITIONS[event.type];
  if (!transition.from.includes(facts.state)) {
    throw new InvalidBillingTransitionError(facts.state, event.type);
  }
  return transition.to(facts, event, context);
}

/** The structural invariants every reachable billing record keeps. */
export function isCoherentBillingFacts(facts: BillingFacts): boolean {
  if (grantsPro(facts.state)) {
    return (
      facts.accessEndsAt !== null &&
      Number.isFinite(facts.accessEndsAt.getTime())
    );
  }
  return facts.accessEndsAt === null;
}
