import type { GoalReadModel } from "@polaris/contracts";
import { GOAL_KINDS } from "@polaris/domain/goals/goal";
import type { PreferenceStorage } from "../lib/current-organization-model";
import {
  HOME_COPY_KEY_PREFIX,
  isDate,
  isMoney,
  isPercent,
  isPeriodSummary,
  readPeriodSummaryCache,
  type StoredPeriodSummary,
} from "../lib/period-summary-cache";
import { calendarDayInTimezone } from "../lib/dates";
import type { DailySeries } from "./home-rhythm-model";
import {
  copyStanding,
  type GoalView,
  homePeriods,
  type OfflineGoal,
  offlineGoal,
  storeToday,
} from "./home-model";
import { readRhythmCopy } from "./rhythm-copy";

/**
 * The Início's copy on the device (desenho t269 v2, § 7.2; ADR 0056, emenda (ii)): A, the month, lives under the key
 * of the period summary that the Resultado also keeps; here, under `polaris.offline.home.<org>`, the rest of what
 * the Início showed: B (the days before the month), the goal of the card and whether the store already sold. All of
 * it as the server said it, never a figure of the device; read back only after the shape checks, and gone with the
 * session (`clearPeriodSummaryCaches`).
 */
export interface HomeCopy {
  /** B as the server returned it; its day after the end is in the month of A. */
  before: StoredPeriodSummary | null;
  /** The goal the card showed and when (the server's clock as the device estimated it), null when not read. */
  goal: { at: string; view: GoalView } | null;
  /** The store sold at least once (the checklist does not come back, AC-23). */
  hadSale: boolean;
}

type Dictionary = Record<string, unknown>;

const GOAL_STATUSES: readonly unknown[] = [
  "active",
  "cancelled",
  "completed",
  "missed",
];

function isDictionary(value: unknown): value is Dictionary {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isText = (value: unknown): value is string => typeof value === "string";
const isNullableText = (value: unknown) => value === null || isText(value);
const isInstant = (value: unknown) =>
  isText(value) && !Number.isNaN(Date.parse(value));

function isProgress(value: unknown): boolean {
  return (
    value === null ||
    (isDictionary(value) &&
      typeof value.periodEnded === "boolean" &&
      (value.percent === null || isPercent(value.percent)) &&
      typeof value.reached === "boolean" &&
      isMoney(value.value))
  );
}

/** Every field of a goal the card reads, with the right kind of value. */
function isGoal(value: unknown): value is GoalReadModel {
  return (
    isDictionary(value) &&
    (value.achievedValue === null || isMoney(value.achievedValue)) &&
    isDate(value.endsOn) &&
    isText(value.id) &&
    (GOAL_KINDS as readonly unknown[]).includes(value.kind) &&
    isNullableText(value.name) &&
    typeof value.paused === "boolean" &&
    isProgress(value.progress) &&
    (value.settledAt === null || isInstant(value.settledAt)) &&
    isDate(value.startsOn) &&
    GOAL_STATUSES.includes(value.status) &&
    isMoney(value.target)
  );
}

function isGoalView(value: unknown): value is GoalView {
  if (!isDictionary(value)) {
    return false;
  }
  switch (value.kind) {
    case "active":
      return (
        isGoal(value.goal) &&
        typeof value.others === "number" &&
        Number.isInteger(value.others) &&
        value.others >= 0
      );
    case "settled":
      return isGoal(value.goal);
    default:
      return value.kind === "none";
  }
}

function isKeptGoal(value: unknown): boolean {
  return isDictionary(value) && isInstant(value.at) && isGoalView(value.view);
}

function isHomeCopy(value: unknown): value is HomeCopy {
  return (
    isDictionary(value) &&
    (value.before === null || isPeriodSummary(value.before)) &&
    (value.goal === null || isKeptGoal(value.goal)) &&
    typeof value.hadSale === "boolean"
  );
}

const keyOf = (organizationId: string) =>
  `${HOME_COPY_KEY_PREFIX}${organizationId}`;

/** The copy of the organization, or null when missing, corrupt or not the expected shape (it is then worth nothing). */
export function readHomeCopy(
  storage: PreferenceStorage | null,
  organizationId: string
): HomeCopy | null {
  try {
    const parsed: unknown = JSON.parse(
      storage?.getItem(keyOf(organizationId)) ?? "null"
    );
    return isHomeCopy(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Keeps what the server just said, over what was kept: B replaces B, the goal replaces the goal, and the store that
 * sold stays a store that sold. The caller asks the guard first (runtime on, `report:read`, no sign-out under way).
 */
export function writeHomeCopy(
  storage: PreferenceStorage | null,
  organizationId: string,
  change: Partial<HomeCopy>
): void {
  if (!storage) {
    return;
  }
  const kept = readHomeCopy(storage, organizationId) ?? {
    before: null,
    goal: null,
    hadSale: false,
  };
  const next: HomeCopy = {
    before: change.before === undefined ? kept.before : change.before,
    goal: change.goal === undefined ? kept.goal : change.goal,
    hadSale: kept.hadSale || change.hadSale === true,
  };
  if (!isHomeCopy(next)) {
    return;
  }
  try {
    storage.setItem(keyOf(organizationId), JSON.stringify(next));
  } catch {
    // Without it the Início only loses its copy for offline.
  }
}

/** A day after `day` (YYYY-MM-DD). */
function dayAfter(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** The figures of the copy: A of the month that follows B, and B; null when either is missing or they do not match. */
export interface CopiedFigures {
  before: StoredPeriodSummary;
  /** The older of the two reads: what "Último resultado confirmado" can vouch for. */
  confirmedAt: string;
  month: StoredPeriodSummary;
  /** The store's day of the read of A, never past the month (the series ends there). */
  today: string;
}

export function copiedFigures(
  storage: PreferenceStorage | null,
  organizationId: string,
  copy: HomeCopy,
  timezone: string | null
): CopiedFigures | null {
  const { before } = copy;
  if (before === null) {
    return null;
  }
  const monthKey = dayAfter(before.period.to).slice(0, 7);
  const month = readPeriodSummaryCache(storage, organizationId, monthKey);
  if (month === null) {
    return null;
  }
  const read = storeToday(month.generatedAt, timezone);
  const today = read > month.period.to ? month.period.to : read;
  // B has to hold every day the comparison and the 30 days need, or a missing day would be drawn as a zero
  if (
    today < month.period.from ||
    before.period.from > homePeriods(today).before.from ||
    before.period.to !== homePeriods(today).before.to
  ) {
    return null;
  }
  const confirmedAt =
    Date.parse(before.generatedAt) < Date.parse(month.generatedAt)
      ? before.generatedAt
      : month.generatedAt;
  return { before, confirmedAt, month, today };
}

/** What the Início shows without a connection, from the copy (§ 7.4): null figures say "sem números". */
export interface OfflineHome {
  figures:
    | (CopiedFigures & {
        stale: boolean;
        todayShown: boolean;
      })
    | null;
  goal: OfflineGoal;
  /** The map's series as kept (`rhythm-copy.ts`), beside the figures only; null without it ("O mapa abre com internet."). */
  rhythm: DailySeries | null;
}

/**
 * Reads the copy when `allowed` (runtime on, `report:read`, the user's lease in force, no refusal of the session)
 * and says what each block takes from it at `now` (the server's clock as the device estimates it). The goal is
 * taken only beside the figures: the line of the last confirmed read vouches for both.
 */
const NOTHING: OfflineHome = {
  figures: null,
  goal: { kind: "online-only" },
  rhythm: null,
};

const older = (a: string, b: string) => (Date.parse(a) < Date.parse(b) ? a : b);

export function offlineHome(
  storage: PreferenceStorage | null,
  organizationId: string,
  timezone: string | null,
  now: number,
  allowed: boolean
): OfflineHome {
  try {
    const copy = allowed ? readHomeCopy(storage, organizationId) : null;
    const figures =
      copy && copiedFigures(storage, organizationId, copy, timezone);
    if (!(copy && figures)) {
      return NOTHING;
    }
    // the goal is read on its own: the line vouches for the oldest of what is on the screen
    const confirmedAt = copy.goal
      ? older(figures.confirmedAt, copy.goal.at)
      : figures.confirmedAt;
    const standing = copyStanding(
      confirmedAt,
      figures.month.generatedAt,
      now,
      timezone
    );
    // the day of the store now: never before the day of the read, so a device clock behind it does not keep a goal
    // that ended "em andamento"
    const deviceDay = calendarDayInTimezone(new Date(now), timezone);
    const readDay = storeToday(figures.month.generatedAt, timezone);
    const day = deviceDay > readDay ? deviceDay : readDay;
    const goal = copy.goal
      ? offlineGoal(copy.goal.view, day, timezone)
      : offlineGoal(null, day, timezone);
    return {
      figures: {
        ...figures,
        confirmedAt,
        stale: standing.stale,
        // A may be a later read of a month already over (the Resultado reads it too): its series ends before today
        todayShown: standing.todayShown && figures.today === deviceDay,
      },
      goal,
      rhythm: readRhythmCopy(storage, organizationId),
    };
  } catch {
    // a copy that passed the checks and still does not add up is worth nothing: "sem números"
    return NOTHING;
  }
}
