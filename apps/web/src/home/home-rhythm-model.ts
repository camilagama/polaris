import type { DailySalesReadModel } from "@polaris/contracts";
import { Money } from "@polaris/domain/money/money";
import { formatBrlAmount, formatQuantity } from "../lib/format";
import { isDate, isMoney } from "../lib/period-summary-cache";
import { divideHalfUp } from "./home-kpis";
import {
  addDays,
  firstOfMonth,
  type Period,
  salesCountText,
  shortDate,
} from "./home-model";

/**
 * Pure rules of "Ritmo de vendas", the map of the Início (revisão de UI v7, § 3 item 10): which days it reads, how the
 * days of `report.dailySales` and of the month's `daily` make one series (one source per day: the days before the
 * month from the light series, the month from the figures, so the cell of today and the card of Hoje never differ),
 * the four levels by the quartiles of the store's own days, the best day, the mean by weekday and the sentences.
 * Money is compared and divided in exact cents (`Money`); a day that is not known is never a zero: without it there is
 * no map at all.
 */

/** The weeks of the map: 26 from 760 px, 13 on a phone; a week goes from Sunday to Saturday. */
export const RHYTHM_WEEKS = 26;
export const RHYTHM_WEEKS_PHONE = 13;

/** Under this many weeks with a sale the map says it is still filling up, and the weekday sentence waits. */
const FEW_WEEKS = 4;

const DAY = 86_400_000;

const WEEKDAYS = [
  "Domingo",
  "Segunda",
  "Terça",
  "Quarta",
  "Quinta",
  "Sexta",
  "Sábado",
] as const;

/** The labels of the bars of the mean by weekday. */
export const WEEKDAY_SHORT = [
  "Dom",
  "Seg",
  "Ter",
  "Qua",
  "Qui",
  "Sex",
  "Sáb",
] as const;

const time = (day: string) => Date.parse(`${day}T00:00:00.000Z`);

/** 0 for Sunday to 6 for Saturday. */
export function weekdayOf(day: string): number {
  return new Date(time(day)).getUTCDay();
}

/** The days from `from` to `to` (0 on the same day, negative before). */
function daysBetween(from: string, to: string): number {
  return Math.round((time(to) - time(from)) / DAY);
}

/** The Sunday that opens the first of the `weeks` weeks that end with the week of `today`. */
export function rhythmStart(today: string, weeks = RHYTHM_WEEKS): string {
  return addDays(today, -weekdayOf(today) - 7 * (weeks - 1));
}

/**
 * What `report.dailySales` is asked for: from the first Sunday of the 26 weeks to the eve of the 1st of the month (the
 * month comes from the figures). At most 181 days, inside the 182 of the contract. The phone reads the same 26 weeks:
 * one read and one copy whatever the width (turning the phone on its side shows 26).
 */
export function rhythmPeriod(today: string): Period {
  return {
    from: rhythmStart(today),
    to: addDays(firstOfMonth(today), -1),
  };
}

export type DailySeries = DailySalesReadModel;

const isCount = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/** A series as the server sends it for that period: one entry per date, money as the server writes it. */
export function isDailySeries(
  value: unknown,
  period?: Period
): value is DailySeries {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { count, from, net } = value as Record<string, unknown>;
  if (
    !(isDate(from) && Array.isArray(net) && Array.isArray(count)) ||
    net.length !== count.length ||
    !net.every(isMoney) ||
    !count.every(isCount)
  ) {
    return false;
  }
  return (
    period === undefined ||
    (from === period.from &&
      net.length === daysBetween(period.from, period.to) + 1)
  );
}

/** A day of the map as it was read. */
export interface RhythmDay {
  date: string;
  netSales: string;
  salesCount: number;
}

type MonthDay = Pick<RhythmDay, "date" | "netSales" | "salesCount">;

/**
 * The days of the 26 weeks up to `today`: before the month from the series, from the 1st on from the month's
 * `daily`. Null when any day is missing from its source (an old copy, a series of another period): it is not known,
 * and the map is not drawn with a zero in its place.
 */
export function rhythmDays(
  series: DailySeries,
  month: readonly MonthDay[],
  today: string
): RhythmDay[] | null {
  const start = rhythmStart(today);
  const first = firstOfMonth(today);
  const byDate = new Map(month.map((day) => [day.date, day]));
  const days: RhythmDay[] = [];
  for (let date = start; date <= today; date = addDays(date, 1)) {
    if (date < first) {
      const index = daysBetween(series.from, date);
      const netSales = series.net[index];
      const salesCount = series.count[index];
      if (index < 0 || netSales === undefined || salesCount === undefined) {
        return null;
      }
      days.push({ date, netSales, salesCount });
    } else {
      const day = byDate.get(date);
      if (!day) {
        return null;
      }
      days.push({
        date,
        netSales: day.netSales,
        salesCount: day.salesCount,
      });
    }
  }
  return days;
}

/** A cell of the map: a day read, or a day of this week still to come (drawn as nothing). */
interface RhythmCell {
  date: string;
  /** 0 is a day with nothing sold (an empty square with an outline), 1 to 4 the quartiles of the store's days. */
  level: 0 | 1 | 2 | 3 | 4;
  /** Null on a day still to come. */
  netSales: string | null;
  salesCount: number;
}

export interface RhythmView {
  /** The index of the best day (the first with the highest net sales), or null when no day sold. */
  best: number | null;
  /** `weeks` × 7 cells from a Sunday, column by column. */
  cells: RhythmCell[];
  /** Days with a sale in the weeks shown. */
  soldDays: number;
  /** Weeks with at least one sale in the weeks shown. */
  soldWeeks: number;
  /** The tops of levels 1, 2 and 3, in money; null when no day sold. */
  thresholds: [string, string, string] | null;
  /** The index of today. */
  today: number;
  /** The mean of net sales by weekday (Sunday first) over the days shown, and the best weekday (null when none sold). */
  weekdays: { best: number | null; means: string[] };
  weeks: number;
}

const centsOf = (amount: string): bigint => Money.from(amount).minorUnits;
const moneyOf = (cents: bigint): string =>
  Money.fromMinorUnits(cents).toString();

/** The quartile tops of the days that sold: the 25th, 50th and 75th of their sorted values (by the rank, no mean). */
function quartiles(sold: bigint[]): [bigint, bigint, bigint] | null {
  if (sold.length === 0) {
    return null;
  }
  const sorted = [...sold].sort((a, b) => Number(a - b));
  const top = sorted.at(-1) ?? 0n;
  if (sorted.length < 4) {
    // too few days for quartiles: quarters of the best day
    return [
      divideHalfUp(top * 25n, 100n),
      divideHalfUp(top * 50n, 100n),
      divideHalfUp(top * 75n, 100n),
    ];
  }
  const at = (share: number) =>
    sorted[Math.floor(sorted.length * share)] ?? top;
  return [at(0.25), at(0.5), at(0.75)];
}

function levelOf(
  cents: bigint,
  tops: [bigint, bigint, bigint] | null
): RhythmCell["level"] {
  if (cents <= 0n || tops === null) {
    return 0;
  }
  return (1 + tops.filter((top) => cents > top).length) as RhythmCell["level"];
}

/** The map of the last `weeks` weeks of `days` (which end on today, as `rhythmDays` returns them). */
export function rhythmView(
  days: readonly RhythmDay[],
  weeks: number
): RhythmView {
  const today = days.at(-1)?.date ?? "";
  const start = rhythmStart(today, weeks);
  const shown = days.filter((day) => day.date >= start);
  const tops = quartiles(
    shown.map((day) => centsOf(day.netSales)).filter((cents) => cents > 0n)
  );
  const cells: RhythmCell[] = Array.from({ length: weeks * 7 }, (_, index) => {
    const date = addDays(start, index);
    const day = shown[index];
    return day && day.date === date
      ? {
          date,
          level: levelOf(centsOf(day.netSales), tops),
          netSales: day.netSales,
          salesCount: day.salesCount,
        }
      : { date, level: 0, netSales: null, salesCount: 0 };
  });
  let best: number | null = null;
  let bestCents = 0n;
  const sums = Array.from({ length: 7 }, () => 0n);
  const counts = Array.from({ length: 7 }, () => 0n);
  const soldWeeks = new Set<number>();
  let soldDays = 0;
  cells.forEach((cell, index) => {
    if (cell.netSales === null) {
      return;
    }
    const cents = centsOf(cell.netSales);
    if (cents > bestCents) {
      best = index;
      bestCents = cents;
    }
    if (cell.salesCount > 0) {
      soldDays += 1;
      soldWeeks.add(Math.floor(index / 7));
    }
    const weekday = index % 7;
    sums[weekday] = (sums[weekday] ?? 0n) + cents;
    counts[weekday] = (counts[weekday] ?? 0n) + 1n;
  });
  const means = sums.map((sum, weekday) => {
    const count = counts[weekday] ?? 0n;
    return count > 0n ? divideHalfUp(sum, count) : 0n;
  });
  let bestWeekday: number | null = null;
  means.forEach((mean, weekday) => {
    if (
      mean > 0n &&
      (bestWeekday === null || mean > (means[bestWeekday] ?? 0n))
    ) {
      bestWeekday = weekday;
    }
  });
  return {
    best,
    cells,
    soldDays,
    soldWeeks: soldWeeks.size,
    thresholds: tops
      ? [moneyOf(tops[0]), moneyOf(tops[1]), moneyOf(tops[2])]
      : null,
    today: shown.length - 1,
    weekdays: { best: bestWeekday, means: means.map(moneyOf) },
    weeks,
  };
}

/** The reading of a day, in its parts: "Sábado, 17/10", "R$ 412,40 · 5 vendas" (or "sem venda") and "melhor dia". */
export interface RhythmReading {
  day: string;
  note: string | null;
  value: string;
}

export function rhythmReading(
  view: RhythmView,
  index: number
): RhythmReading | null {
  const cell = view.cells[index];
  if (!cell || cell.netSales === null) {
    return null;
  }
  const notes = [
    index === view.best ? "melhor dia" : null,
    index === view.today ? "hoje" : null,
  ].filter((note) => note !== null);
  return {
    day: `${WEEKDAYS[weekdayOf(cell.date)]}, ${shortDate(cell.date)}`,
    note: notes.length > 0 ? notes.join(" · ") : null,
    value:
      cell.salesCount === 0
        ? "sem venda"
        : `${formatBrlAmount(cell.netSales)} · ${salesCountText(cell.salesCount)}`,
  };
}

/** The reading in one line: what the keyboard control says. */
export function rhythmReadingText(reading: RhythmReading): string {
  return [reading.day, reading.value, reading.note]
    .filter((part) => part !== null)
    .join(" · ");
}

function soldDaysText(count: number): string {
  return `${formatQuantity(count)} ${count === 1 ? "dia" : "dias"} com venda`;
}

/** The name of the map for a screen reader: what it shows, in words; the numbers are in the table. */
export function rhythmSummary(view: RhythmView): string {
  const head = `Vendas por dia nas últimas ${view.weeks} semanas`;
  const best = view.best === null ? null : view.cells[view.best];
  if (!best?.netSales) {
    return `${head}: nenhum dia com venda.`;
  }
  return `${head}: ${soldDaysText(view.soldDays)}. Melhor dia ${shortDate(best.date)}, ${formatBrlAmount(best.netSales)}. Os números estão em Ver os números.`;
}

/** Under the legend: "Vazio: sem venda · até R$ 57,98 · até R$ 83,64 · até R$ 142,73 · acima". */
export function rhythmRangesText(view: RhythmView): string {
  if (view.thresholds === null) {
    return "Vazio: sem venda";
  }
  const [first, second, third] = view.thresholds.map(formatBrlAmount);
  return `Vazio: sem venda · até ${first} · até ${second} · até ${third} · acima`;
}

/**
 * The sentence under the map: with few weeks of sales, that the map fills up as the store sells (and how many days
 * sold); otherwise the best weekday and its mean.
 */
export function rhythmInsight(
  view: RhythmView
):
  | { kind: "few"; text: string; detail: string }
  | { kind: "weekday"; text: string } {
  const { best, means } = view.weekdays;
  if (view.soldWeeks < FEW_WEEKS || best === null) {
    return {
      detail: `${soldDaysText(view.soldDays)} até agora.`,
      kind: "few",
      text: "Poucas semanas de vendas ainda: o mapa enche conforme você vende.",
    };
  }
  return {
    kind: "weekday",
    text: `${WEEKDAYS[best]} é o seu melhor dia da semana: média de ${formatBrlAmount(means[best] ?? "0.00")}.`,
  };
}
