import { isValidCalendarDate } from "../inventory/calendar-date";
import { Money } from "../money/money";
import type { PeriodResult } from "../economics/sale-economics";
import {
  EARLIEST_EXPENSE_COMPETENCE,
  MAX_EXPENSE_COMPETENCE_DAYS_AHEAD,
} from "../expenses/expense";

/**
 * Goals (plan PR70): a target for a period, measured by net sales, by the
 * estimated operating result or by the number of sales. Progress is always
 * derived from the same period result the dashboard shows (the economics
 * engine), never stored as a running total.
 *
 * Lifecycle: an active goal becomes `completed` the first time its progress
 * reaches the target (and stays completed: a later dip, such as a return, never
 * reopens it), `missed` when its period ends without reaching it, or
 * `cancelled` by the person. Completed, missed and cancelled goals are final
 * and read-only. Changing the target of an active goal is allowed and every
 * change is kept (previous and new value).
 */
export const GOAL_KINDS = [
  "net_sales",
  "operating_result",
  "sale_count",
] as const;
export type GoalKind = (typeof GOAL_KINDS)[number];

export const GOAL_STATUSES = [
  "active",
  "cancelled",
  "completed",
  "missed",
] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const MAX_GOAL_NAME_LENGTH = 100;
/** Active goals per organization: each one is measured by reading its whole period. */
export const MAX_ACTIVE_GOALS = 20;
export const MAX_GOAL_PERIOD_DAYS = 366;
export const MAX_SALE_COUNT_TARGET = 1_000_000;

export class InvalidGoalError extends Error {
  readonly code = "invalid_goal";

  constructor(options?: ErrorOptions) {
    super("invalid_goal", options);
    this.name = "InvalidGoalError";
  }
}

/** The organization already has the most active goals it can measure. */
export class GoalLimitReachedError extends Error {
  readonly code = "goal_limit_reached";

  constructor() {
    super("goal_limit_reached");
    this.name = "GoalLimitReachedError";
  }
}

/** The goal's period has ended: it is settled by the next read, not edited. */
export class GoalPeriodEndedError extends Error {
  readonly code = "goal_period_ended";

  constructor() {
    super("goal_period_ended");
    this.name = "GoalPeriodEndedError";
  }
}

export class GoalNotFoundError extends Error {
  readonly code = "goal_not_found";

  constructor() {
    super("goal_not_found");
    this.name = "GoalNotFoundError";
  }
}

export class GoalVersionConflictError extends Error {
  readonly code = "goal_version_conflict";

  constructor() {
    super("goal_version_conflict");
    this.name = "GoalVersionConflictError";
  }
}

/** The goal is not active: it is final and cannot be changed. */
export class GoalNotActiveError extends Error {
  readonly code = "goal_not_active";

  constructor() {
    super("goal_not_active");
    this.name = "GoalNotActiveError";
  }
}

/**
 * The goal is paused by the plan: the organization has more active goals than
 * its plan allows (after a downgrade), so the ones beyond the limit can only be
 * cancelled. Nothing is deleted and the goal returns when the plan allows it.
 */
export class GoalPausedByPlanError extends Error {
  readonly code = "goal_paused_by_plan";

  constructor() {
    super("goal_paused_by_plan");
    this.name = "GoalPausedByPlanError";
  }
}

/**
 * The active goals the plan pauses: of the goals that are still running (their
 * period has not ended: an ended one is settled by the read itself and takes no
 * place), the ones that have started come first, oldest first, and the first
 * `limit` of them keep running; the rest are paused. Derived on every read from
 * the limit in force, never stored, so an upgrade or a cancellation un-pauses on
 * its own. A limit that is not a finite number pauses everything (fails closed).
 */
export function pausedGoalIds(
  active: readonly {
    createdAt: Date;
    endsOn: string;
    id: string;
    startsOn: string;
  }[],
  limit: number,
  today: string
): string[] {
  const keep = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  return active
    .filter((goal) => goal.endsOn >= today)
    .sort((left, right) => {
      const leftWaiting = left.startsOn > today ? 1 : 0;
      const rightWaiting = right.startsOn > today ? 1 : 0;
      if (leftWaiting !== rightWaiting) {
        return leftWaiting - rightWaiting;
      }
      const byAge = left.createdAt.getTime() - right.createdAt.getTime();
      if (byAge !== 0) {
        return byAge;
      }
      return left.id < right.id ? -1 : 1;
    })
    .slice(keep)
    .map((goal) => goal.id);
}

export function isGoalKind(value: string): value is GoalKind {
  return (GOAL_KINDS as readonly string[]).includes(value);
}

export interface GoalInput {
  endsOn: string;
  kind: string;
  name?: string | null | undefined;
  startsOn: string;
  /** BRL decimal text for money goals, whole number text for a count goal. */
  target: string;
}

export interface NormalizedGoal {
  endsOn: string;
  kind: GoalKind;
  name: string | null;
  startsOn: string;
  /** Exact decimal text: two places for money goals, a whole number for a count. */
  target: string;
}

const wholeNumberPattern = /^\d{1,9}$/;

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) + days))
    .toISOString()
    .slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000
  );
}

/** Text PostgreSQL cannot store (NUL) or that is not valid Unicode (a lone surrogate). */
export function hasUnstorableCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0) {
      return true;
    }
    if (code >= 0xd8_00 && code <= 0xdb_ff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc_00 && next <= 0xdf_ff)) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc_00 && code <= 0xdf_ff) {
      return true;
    }
  }
  return false;
}

/** Normalizes a target for a kind: positive, exact, within limits. */
export function normalizeGoalTarget(kind: GoalKind, target: string): string {
  const text = target.trim();
  if (kind === "sale_count") {
    if (!wholeNumberPattern.test(text)) {
      throw new InvalidGoalError();
    }
    const count = Number(text);
    if (count < 1 || count > MAX_SALE_COUNT_TARGET) {
      throw new InvalidGoalError();
    }
    return String(count);
  }
  let money: Money;
  try {
    money = Money.from(text);
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: the cause is passed in the options object.
    throw new InvalidGoalError({ cause: error });
  }
  if (money.minorUnits <= 0n) {
    throw new InvalidGoalError();
  }
  return money.toString();
}

/**
 * Validates what a person typed for a goal. The period is a range of the
 * organization's calendar of at most 366 days that starts no earlier than
 * `2000-01-01` and no later than 366 days after `today`.
 */
export function normalizeGoal(input: GoalInput, today: string): NormalizedGoal {
  if (!isGoalKind(input.kind)) {
    throw new InvalidGoalError();
  }
  const name = input.name?.trim() || null;
  if (
    !(
      isValidCalendarDate(input.startsOn) && isValidCalendarDate(input.endsOn)
    ) ||
    input.startsOn < EARLIEST_EXPENSE_COMPETENCE ||
    input.startsOn > addDays(today, MAX_EXPENSE_COMPETENCE_DAYS_AHEAD) ||
    input.endsOn < input.startsOn ||
    daysBetween(input.startsOn, input.endsOn) + 1 > MAX_GOAL_PERIOD_DAYS ||
    (name !== null &&
      ([...name].length > MAX_GOAL_NAME_LENGTH || hasUnstorableCharacter(name)))
  ) {
    throw new InvalidGoalError();
  }
  return {
    endsOn: input.endsOn,
    kind: input.kind,
    name,
    startsOn: input.startsOn,
    target: normalizeGoalTarget(input.kind, input.target),
  };
}

export interface GoalEvaluation {
  /** True when the period has ended (its last day is before today). */
  periodEnded: boolean;
  /** Progress over the target in percent with one place, or null when it is not positive. */
  percent: string | null;
  /** The measure so far: BRL decimal text, or a whole number for a count goal. */
  progress: string;
  reached: boolean;
}

function measure(kind: GoalKind, result: PeriodResult): string {
  switch (kind) {
    case "net_sales":
      return result.netSales;
    case "operating_result":
      return result.estimatedOperatingResult;
    default:
      return String(result.salesCount);
  }
}

/** units of the measure that compare: centavos for money, the count itself */
function comparable(kind: GoalKind, value: string): bigint {
  return kind === "sale_count" ? BigInt(value) : Money.from(value).minorUnits;
}

/**
 * Evaluates a goal against the result of its period so far (from the start to
 * the earlier of the end and today). Pure: the caller reads the result.
 */
export function evaluateGoal(
  goal: { endsOn: string; kind: GoalKind; target: string },
  result: PeriodResult,
  today: string
): GoalEvaluation {
  const progress = measure(goal.kind, result);
  const reachedValue = comparable(goal.kind, progress);
  const targetValue = comparable(goal.kind, goal.target);
  let percent: string | null = null;
  if (reachedValue > 0n) {
    const tenths =
      (reachedValue * 1000n * 2n + targetValue) / (targetValue * 2n);
    percent = `${tenths / 10n}.${tenths % 10n}`;
  }
  return {
    percent,
    periodEnded: goal.endsOn < today,
    progress,
    reached: reachedValue >= targetValue,
  };
}

export type GoalSettlement = "completed" | "missed";

/**
 * What an active goal turns into, if anything: completed as soon as the target
 * is reached (even before the period ends), missed once the period ended
 * without it. Anything that is not active never changes by itself.
 *
 * An operating-result goal is the exception: completion is irreversible, and
 * the result is not trustworthy before the period closes (costs dated later in
 * the month are not in it yet), so it settles only once the period has ended,
 * as completed or missed.
 */
export function settleGoal(
  status: GoalStatus,
  evaluation: GoalEvaluation,
  kind: GoalKind = "net_sales"
): GoalSettlement | null {
  if (status !== "active") {
    return null;
  }
  if (kind === "operating_result" && !evaluation.periodEnded) {
    return null;
  }
  if (evaluation.reached) {
    return "completed";
  }
  return evaluation.periodEnded ? "missed" : null;
}
