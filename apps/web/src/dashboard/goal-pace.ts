import type { GoalReadModel } from "@polaris/contracts";
import type { PaceState } from "@/ui/pace-line";
import { goalProgressWidth } from "./goal-model";

export type GoalPaceState = PaceState;

export interface GoalPace {
  /** The share of the target expected by today, as the whole percent the screen writes ("60%"). */
  expectedPercent: number;
  /** Where the mark sits on the ring and on the bar, 0 to 100: days over ÷ days of the period. */
  position: number;
  state: GoalPaceState;
}

export const GOAL_PACE_LABEL: Readonly<Record<GoalPaceState, string>> = {
  ahead: "Adiantada",
  behind: "Atrasada",
  on_pace: "No ritmo",
};

/** Up to this many tenths of a percent of the target below the expected is still "No ritmo". */
const ON_PACE_TENTHS = 50;
const TENTHS = 1000;

const DAY = 86_400_000;

function daysBetween(from: string, to: string): number {
  return Math.round(
    (new Date(`${to}T00:00:00.000Z`).getTime() -
      new Date(`${from}T00:00:00.000Z`).getTime()) /
      DAY
  );
}

/**
 * Where the goal should be today if the sales were the same every day: the share of the period already over, against
 * what the goal measured so far. It is not the projection (where the rhythm of the last 7 days leads); the two never
 * share a sentence.
 *
 * The pace of an active goal on the store's `today` (YYYY-MM-DD, the store's time zone), or null where there is
 * nothing to say: paused, reached, period over, not begun, progress not read, no `today`, and the first day of the
 * period (nothing is over yet, so the mark would sit on the start). The days over are the whole days before today;
 * what was sold today is already in the measure, so it counts for the goal and not against it.
 */
export function goalPace(
  goal: Pick<
    GoalReadModel,
    "endsOn" | "paused" | "progress" | "startsOn" | "status"
  >,
  today: string | null
): GoalPace | null {
  const { progress } = goal;
  if (
    today === null ||
    goal.status !== "active" ||
    goal.paused ||
    progress === null ||
    progress.reached ||
    progress.periodEnded ||
    today < goal.startsOn ||
    today > goal.endsOn
  ) {
    return null;
  }
  const total = daysBetween(goal.startsOn, goal.endsOn) + 1;
  const over = daysBetween(goal.startsOn, today);
  if (over <= 0) {
    return null;
  }
  const doneTenths = Math.round(goalProgressWidth(progress.percent) * 10);
  // the state is decided against the same whole percent the screen writes, so the word never contradicts the number
  const expectedPercent = Math.round((over * 100) / total);
  const expectedTenths = expectedPercent * (TENTHS / 100);
  let state: GoalPaceState = "behind";
  if (doneTenths > expectedTenths) {
    state = "ahead";
  } else if (doneTenths + ON_PACE_TENTHS >= expectedTenths) {
    state = "on_pace";
  }
  return { expectedPercent, position: (over * 100) / total, state };
}

/** The state in words for the name of the ring and the bar: "Atrasada: o esperado até hoje era 60%." */
export function goalPaceSpoken(pace: GoalPace): string {
  return `${GOAL_PACE_LABEL[pace.state]}: o esperado até hoje era ${pace.expectedPercent}%.`;
}

/** What `PaceLine` takes: the word and the state, both null where there is no pace (the line stays, empty). */
export function goalPaceLine(pace: GoalPace | null): {
  label: string | null;
  state: GoalPaceState | null;
} {
  return pace
    ? { label: GOAL_PACE_LABEL[pace.state], state: pace.state }
    : { label: null, state: null };
}
