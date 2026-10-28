import { monthBounds, monthOfDay, shiftMonth } from "../expenses/expense-model";
import { isCalendarDate } from "../lib/dates";

/**
 * The periods of the Resultado (corte resultado-v2, AC-1 and AC-2): the presets, the free range, what each one reads,
 * how the screen says its dates and which one has a copy on the device. Pure: dates are `YYYY-MM-DD` with no time zone
 * in the way; the store's "today" comes from the caller.
 */

export interface Period {
  from: string;
  to: string;
}

export type PeriodPreset =
  | "custom"
  | "last-30"
  | "last-month"
  | "this-month"
  | "year";

/**
 * "Este ano" and any range above 62 days wait for the CPU measure of the `periodSummary` of 366 days in staging
 * (AC-23). The grouping by month (`groupByMonth`) is ready and tested; turning this on is the one
 * change that opens the long periods. Until the measure is registered it stays off.
 */
export const LONG_PERIODS_ENABLED = false;

/** The longest range the contract accepts (AC-2). */
export const MAX_PERIOD_DAYS = 366;
/** The longest range while the long periods are off. */
const SHORT_PERIOD_DAYS = 62;

/** The longest range a person can ask for. */
export function maxPeriodDays(longPeriods: boolean = LONG_PERIODS_ENABLED) {
  return longPeriods ? MAX_PERIOD_DAYS : SHORT_PERIOD_DAYS;
}

/** The presets on offer, in the order they are shown ("Este ano" only with the long periods on). */
export function availablePresets(
  longPeriods: boolean = LONG_PERIODS_ENABLED
): PeriodPreset[] {
  return longPeriods
    ? ["this-month", "last-month", "last-30", "year", "custom"]
    : ["this-month", "last-month", "last-30", "custom"];
}

export const PRESET_LABELS: Readonly<Record<PeriodPreset, string>> = {
  custom: "Período",
  "last-30": "Últimos 30 dias",
  "last-month": "Mês passado",
  "this-month": "Este mês",
  year: "Este ano",
};

const DAY_MS = 86_400_000;

function utcTime(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

/** The calendar day `days` away from `day`. */
export function addDays(day: string, days: number): string {
  return new Date(utcTime(day) + days * DAY_MS).toISOString().slice(0, 10);
}

/** How many calendar days a period has, both ends counted. */
export function dayCount(period: Period): number {
  return Math.round((utcTime(period.to) - utcTime(period.from)) / DAY_MS) + 1;
}

/**
 * What a preset reads on a day. The month is read whole (its last day is the month's, so an expense of the competence
 * after today is in it, AC-10); the 30 days end today; the year goes from January 1st to today. `custom` is the range
 * the person gave, which the caller validated.
 */
export function presetPeriod(
  preset: PeriodPreset,
  today: string,
  custom: Period | null
): Period | null {
  switch (preset) {
    case "this-month":
      return monthBounds(monthOfDay(today));
    case "last-month": {
      const previous = shiftMonth(monthOfDay(today), -1);
      return previous === null ? null : monthBounds(previous);
    }
    case "last-30":
      return { from: addDays(today, -29), to: today };
    case "year":
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
    default:
      return custom;
  }
}

/** The month whose copy a preset may use offline (AC-16, Q-2): only the two months; a window that moves has none. */
export function copyMonthOf(
  preset: PeriodPreset,
  period: Period | null
): string | null {
  if ((preset === "this-month" || preset === "last-month") && period) {
    return monthOfDay(period.from);
  }
  return null;
}

export type RangeProblem = "missing" | "order" | "too_long";

/** What is wrong with a range typed by the person, before anything is asked of the server (AC-2); null when it is fine. */
export function rangeProblem(
  from: string,
  to: string,
  maxDays: number = maxPeriodDays()
): RangeProblem | null {
  if (!(isCalendarDate(from) && isCalendarDate(to))) {
    return "missing";
  }
  if (from > to) {
    return "order";
  }
  return dayCount({ from, to }) > maxDays ? "too_long" : null;
}

/** The sentence under the field for each problem. */
export function rangeMessage(
  problem: RangeProblem,
  maxDays: number = maxPeriodDays()
): string {
  switch (problem) {
    case "missing":
      return "Escolha a data inicial e a final.";
    case "order":
      return "A data inicial vem depois da final.";
    default:
      return maxDays >= MAX_PERIOD_DAYS
        ? "Escolha até 1 ano."
        : `Escolha até ${maxDays} dias.`;
  }
}

const MONTH_NAMES = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
] as const;

const MONTH_ABBREVIATIONS = [
  "jan",
  "fev",
  "mar",
  "abr",
  "mai",
  "jun",
  "jul",
  "ago",
  "set",
  "out",
  "nov",
  "dez",
] as const;

/** "janeiro" for "2026-01-15" or "2026-01". */
export function monthName(day: string): string {
  return MONTH_NAMES[Number(day.slice(5, 7)) - 1] ?? day;
}

/** "jan" for "2026-01-15" or "2026-01": the label of a month on the x axis (AC-7). */
export function monthAbbreviation(day: string): string {
  return MONTH_ABBREVIATIONS[Number(day.slice(5, 7)) - 1] ?? day;
}

function dayOfMonth(day: string): number {
  return Number(day.slice(8, 10));
}

/**
 * The dates of a period in words, the way the screen says them (AC-1): "1 a 23 de outubro", "28 de setembro a 23 de
 * outubro", "23 de outubro". The year is written when it is not `thisYear` or when the period crosses a year.
 */
export function periodText(period: Period, thisYear: string): string {
  const { from, to } = period;
  const fromYear = from.slice(0, 4);
  const toYear = to.slice(0, 4);
  const withYear = fromYear !== toYear || toYear !== thisYear;
  const end = `${dayOfMonth(to)} de ${monthName(to)}${withYear ? ` de ${toYear}` : ""}`;
  if (from === to) {
    return end;
  }
  if (from.slice(0, 7) === to.slice(0, 7)) {
    return `${dayOfMonth(from)} a ${end}`;
  }
  const start =
    fromYear === toYear
      ? `${dayOfMonth(from)} de ${monthName(from)}`
      : `${dayOfMonth(from)} de ${monthName(from)} de ${fromYear}`;
  return `${start} a ${end}`;
}

/** True when two periods are the same dates. */
export function samePeriod(a: Period | null, b: Period | null): boolean {
  return a !== null && b !== null && a.from === b.from && a.to === b.to;
}
