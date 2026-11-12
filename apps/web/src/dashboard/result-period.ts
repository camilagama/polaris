import { monthBounds, monthOfDay } from "../expenses/expense-model";
import { isCalendarDate } from "../lib/dates";
import { shortcutLabel } from "../ui/date-range-shortcuts";
import { presetRange, type RangePreset } from "../ui/date-values";

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

/** The longest range the contract accepts (AC-2). */
export const MAX_PERIOD_DAYS = 366;

/** The presets on offer, in the order they are shown. */
export const PRESETS: readonly PeriodPreset[] = [
  "this-month",
  "last-month",
  "last-30",
  "year",
  "custom",
];

export const PRESET_SHORTCUTS: Readonly<
  Record<Exclude<PeriodPreset, "custom">, RangePreset>
> = {
  "last-30": "30-dias",
  "last-month": "mes-passado",
  "this-month": "este-mes",
  year: "este-ano",
};

export function presetOfShortcut(shortcut: RangePreset): PeriodPreset | null {
  return (
    (Object.entries(PRESET_SHORTCUTS).find(
      ([, value]) => value === shortcut
    )?.[0] as PeriodPreset | undefined) ?? null
  );
}

export const PRESET_LABELS: Readonly<Record<PeriodPreset, string>> = {
  custom: "Período",
  "last-30": shortcutLabel(PRESET_SHORTCUTS["last-30"]),
  "last-month": shortcutLabel(PRESET_SHORTCUTS["last-month"]),
  "this-month": shortcutLabel(PRESET_SHORTCUTS["this-month"]),
  year: shortcutLabel(PRESET_SHORTCUTS.year),
};

const DAY_MS = 86_400_000;

function utcTime(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

/** The calendar day `days` away from `day`. */
export function addDays(day: string, days: number): string {
  return new Date(utcTime(day) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The last day of the month of `day`. */
export function lastOfMonth(day: string): string {
  return addDays(`${addDays(`${day.slice(0, 7)}-28`, 4).slice(0, 7)}-01`, -1);
}

/** How many calendar days a period has, both ends counted. */
export function dayCount(period: Period): number {
  return Math.round((utcTime(period.to) - utcTime(period.from)) / DAY_MS) + 1;
}

/**
 * What a preset reads on a day. "Este mês" is the calendar month, whole like everywhere else (its last day is the
 * month's, so an expense of the competence after today is in it, AC-10); the 30 days end today; the year goes from
 * January 1st to today. `custom` is the range the person gave, which the caller validated.
 */
export function presetPeriod(
  preset: PeriodPreset,
  today: string,
  custom: Period | null
): Period | null {
  switch (preset) {
    case "this-month":
      return presetRange(PRESET_SHORTCUTS["this-month"], today);
    case "last-month":
      return presetRange(PRESET_SHORTCUTS["last-month"], today);
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

/** The month ("YYYY-MM") when the period is exactly one calendar month, from the 1st to the last day; null otherwise. */
export function wholeMonthOf(period: Period | null): string | null {
  if (period === null) {
    return null;
  }
  const month = monthOfDay(period.from);
  const bounds = monthBounds(month);
  return bounds !== null &&
    bounds.from === period.from &&
    bounds.to === period.to
    ? month
    : null;
}

export type RangeProblem = "missing" | "order" | "too_long";

/** What is wrong with a range typed by the person, before anything is asked of the server (AC-2); null when it is fine. */
export function rangeProblem(from: string, to: string): RangeProblem | null {
  if (!(isCalendarDate(from) && isCalendarDate(to))) {
    return "missing";
  }
  if (from > to) {
    return "order";
  }
  return dayCount({ from, to }) > MAX_PERIOD_DAYS ? "too_long" : null;
}

/** The sentence under the field for each problem. */
export function rangeMessage(problem: RangeProblem): string {
  switch (problem) {
    case "missing":
      return "Escolha a data inicial e a final.";
    case "order":
      return "A data inicial vem depois da final.";
    default:
      return "Escolha até 1 ano";
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

/** The key under which the Resultado leaves the period to filter in the state of the entry it opens in the Histórico. */
export const HISTORY_PERIOD_STATE = "historyPeriod";

/** The key under which the Histórico leaves the period to read in the state of the entry it opens in the Resultado. */
export const RESULT_PERIOD_STATE = "resultPeriod";

/** A period taken from a navigation state: both ends real days in order, within the Resultado's limit; null otherwise. */
export function periodFromState(value: unknown): Period | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const from: unknown = Reflect.get(value, "from");
  const to: unknown = Reflect.get(value, "to");
  return typeof from === "string" &&
    typeof to === "string" &&
    rangeProblem(from, to) === null
    ? { from, to }
    : null;
}

export function presetOfPeriod(period: Period, today: string): PeriodPreset {
  return (
    PRESETS.find(
      (preset) =>
        preset !== "custom" &&
        samePeriod(presetPeriod(preset, today, null), period)
    ) ?? "custom"
  );
}

/** "01/10 a 14/10": the ends of a period as the Histórico's pill says them, with the year only when the ends differ in it. */
export function periodRangeLabel(period: Period): string {
  const years = period.from.slice(0, 4) !== period.to.slice(0, 4);
  const day = (value: string) =>
    `${value.slice(8, 10)}/${value.slice(5, 7)}${years ? `/${value.slice(0, 4)}` : ""}`;
  return `${day(period.from)} a ${day(period.to)}`;
}
