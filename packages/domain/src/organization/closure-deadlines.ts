/**
 * The dates of a closed organization (ADR 0074 and 0081, amended): the one function that says when its data may
 * be deleted and in which phase it is. Only dates decide (the request, the end of the recovery window and the
 * purge, once it happened), never a legal hold nor the status of a scheduled purge, so what the owner reads is the
 * same with or without them.
 *
 * "90 days" are calendar days in the organization's time zone: D is the local date of the request plus 90 days,
 * and it starts at the first instant of that local day (so a change of daylight saving time never moves it). The
 * database repeats the same rule (`closure_deadlines` and `closure_phase_at`), and a gate compares the two at the
 * edges.
 */
import { ORGANIZATION_PURGE_CLOSURE_PERIOD_DAYS } from "../privacy/organization-purge";

/** D is this many calendar days after the local date of the request (the period of the purge, ADR 0081). */
export const CLOSURE_DELETABLE_AFTER_DAYS =
  ORGANIZATION_PURGE_CLOSURE_PERIOD_DAYS;
/** The purge is scheduled this many days before D, and its notice goes out with it. */
export const CLOSURE_PURGE_SCHEDULE_LEAD_DAYS = 7;
/** The first purge run is never sooner than this after D. */
export const CLOSURE_PURGE_GRACE_HOURS = 48;
/**
 * A purge of the closure period never runs sooner than this after it was scheduled, nor after a legal hold
 * that held it was released (ADR 0102): the owner always has this notice. The database writes it in hours
 * (`interval '168 hours'`), so the session's time zone never changes it.
 */
export const CLOSURE_PURGE_MIN_NOTICE_DAYS = 7;
/**
 * A closed organization still not purged this many days after D, with no legal hold, was left behind (a cancellation
 * of the Admin, a renewal still alive, a temporary access of the Admin): the privacy job raises an alert (ADR 0102).
 * The database writes it in hours (`interval '720 hours'`).
 */
export const CLOSURE_PURGE_OVERDUE_DAYS = 30;
/** The first notice before D goes out this many days before it. */
export const CLOSURE_FIRST_NOTICE_LEAD_DAYS = 30;

export const CLOSURE_PHASES = Object.freeze([
  "closing",
  "closed",
  "deletion_scheduled",
  "deletable",
  "purged",
] as const);

export type ClosurePhase = (typeof CLOSURE_PHASES)[number];

export interface ClosureDeadlines {
  /** The first notice, 30 local days before D. */
  d30At: Date;
  /** The schedule of the purge and its notice, 7 local days before D. */
  d7At: Date;
  /** The first instant of D in the organization's time zone. */
  deletableFrom: Date;
  /** D, as the organization's calendar shows it (YYYY-MM-DD). */
  deletionDate: string;
  /** The last instant the owner may ask for a copy: D itself. */
  exportOpenUntil: Date;
}

const DAY_MS = 86_400_000;
/** Every offset in use is within 14 hours of UTC; the search window is wider than that. */
const SEARCH_MS = 16 * 3_600_000;
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterOf(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    // throws a RangeError for a time zone that does not exist
    formatter = new Intl.DateTimeFormat("en-CA", {
      day: "2-digit",
      month: "2-digit",
      timeZone,
      year: "numeric",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The calendar date of an instant in a time zone, as YYYY-MM-DD. */
export function localDate(instant: Date, timeZone: string): string {
  const parts = formatterOf(timeZone).formatToParts(instant);
  const part = (type: string) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function utcMidnight(date: string): number {
  const match = CALENDAR_DATE.exec(date);
  if (!match) {
    throw new RangeError("invalid_calendar_date");
  }
  const [, year, month, day] = match.map(Number) as [
    number,
    number,
    number,
    number,
  ];
  const midnight = Date.UTC(year, month - 1, day);
  if (new Date(midnight).toISOString().slice(0, 10) !== date) {
    throw new RangeError("invalid_calendar_date");
  }
  return midnight;
}

function addDays(date: string, days: number): string {
  return new Date(utcMidnight(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The first instant whose local date is `date`. A local date only moves forward with time, so the first instant
 * is found by halving: it is the day's midnight, or the first instant after a gap when midnight did not exist, or
 * the first of two midnights when the clock went back over it.
 */
export function localDayStart(date: string, timeZone: string): Date {
  const midnight = utcMidnight(date);
  let low = midnight - SEARCH_MS;
  let high = midnight + SEARCH_MS;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (localDate(new Date(middle), timeZone) >= date) {
      high = middle;
    } else {
      low = middle;
    }
  }
  return new Date(high);
}

/** D and the milestones before it, for a closure requested at `requestedAt`. */
export function closureDeadlines(
  requestedAt: Date,
  timeZone: string
): ClosureDeadlines {
  const deletionDate = addDays(
    localDate(requestedAt, timeZone),
    CLOSURE_DELETABLE_AFTER_DAYS
  );
  const deletableFrom = localDayStart(deletionDate, timeZone);
  return {
    d30At: localDayStart(
      addDays(deletionDate, -CLOSURE_FIRST_NOTICE_LEAD_DAYS),
      timeZone
    ),
    d7At: localDayStart(
      addDays(deletionDate, -CLOSURE_PURGE_SCHEDULE_LEAD_DAYS),
      timeZone
    ),
    deletableFrom,
    deletionDate,
    exportOpenUntil: deletableFrom,
  };
}

const HOUR_MS = 3_600_000;

/**
 * The first instant the purge of the closure period may run, when the privacy job schedules it at
 * `scheduledAt` (ADR 0102): the later of D plus 48 hours and the schedule plus 7 days. On time (7 local days
 * before D) it is D plus 48 hours; a late sweep pushes it to the schedule plus 7 days. The database writes the
 * same `not_before` (`schedule_closed_organization_purges`), and a gate compares them.
 */
export function closurePurgeNotBefore(
  requestedAt: Date,
  timeZone: string,
  scheduledAt: Date
): Date {
  const { deletableFrom } = closureDeadlines(requestedAt, timeZone);
  return new Date(
    Math.max(
      deletableFrom.getTime() + CLOSURE_PURGE_GRACE_HOURS * HOUR_MS,
      scheduledAt.getTime() + CLOSURE_PURGE_MIN_NOTICE_DAYS * DAY_MS
    )
  );
}

/** Whether the privacy job may schedule the purge of this closure at `now`: from 7 local days before D on. */
export function closurePurgeSchedulable(
  requestedAt: Date,
  timeZone: string,
  now: Date
): boolean {
  return (
    now.getTime() >= closureDeadlines(requestedAt, timeZone).d7At.getTime()
  );
}

export interface ClosureDates {
  purgedAt: Date | null;
  recoverUntil: Date;
  requestedAt: Date;
  timeZone: string;
}

/**
 * Where a closure stands at `now`: `closing` while it can be undone, `closed` after that, `deletion_scheduled`
 * from 7 local days before D, `deletable` from D, `purged` once the data is gone.
 */
export function closurePhaseAt(closure: ClosureDates, now: Date): ClosurePhase {
  if (closure.purgedAt) {
    return "purged";
  }
  const time = now.getTime();
  if (time < closure.recoverUntil.getTime()) {
    return "closing";
  }
  const deadlines = closureDeadlines(closure.requestedAt, closure.timeZone);
  if (time >= deadlines.deletableFrom.getTime()) {
    return "deletable";
  }
  if (time >= deadlines.d7At.getTime()) {
    return "deletion_scheduled";
  }
  return "closed";
}
