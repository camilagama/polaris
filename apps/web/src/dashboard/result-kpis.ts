import { Money } from "@polaris/domain/money/money";
import {
  type Delta,
  divideHalfUp,
  type KpiReading,
  moneyDelta,
  NOT_PROFIT_NOR_CASH,
  percentDelta,
  resultHelp,
  ticketHelp,
} from "../home/home-kpis";
import {
  fullDate,
  periodShort,
  salesCountText,
  shortDate,
} from "../home/home-model";
import {
  cogsCoverageOf,
  type StoredDay,
  type StoredPeriodSummary,
} from "../lib/period-summary-cache";
import {
  addDays,
  dayCount,
  lastOfMonth,
  monthName,
  type Period,
} from "./result-period";

/**
 * The row of KPI cards of the Resultado (revisão de UI v7, § 8), in the mold of the Início's (home-kpis.ts): Resultado
 * estimado, Vendas, Ticket médio and Margem, each read at rest (the period up to the store's today) or on a day of its
 * sparkline, the three cards of sales, ticket and result reading the same day together. The chips compare with the
 * period before (`comparisonPeriod`), day by day from its start: a month with the month before, any other range with
 * the range of the same length that ends the day before it. Money is added and divided in exact cents.
 *
 * The result is a sum of the results of the days only when every day up to today has a known one (AC-9: a sum of the
 * known days is never the total): then it has its sparkline and its chip, in reais. Otherwise the number at rest is
 * the server's card, with its badge, and the card says how many days have no cost informed, with no sparkline and
 * no chip.
 */

/** A day, or a month of a long period (`to`, `days` and `unknownDays`, as the server adds it up). */
type Day = Pick<StoredDay, "date" | "netSales" | "salesCount"> &
  Partial<Pick<StoredDay, "days" | "operatingResult" | "to" | "unknownDays">>;

/** The last day an entry adds up: its own date, or the last day of a month. */
const lastDayOf = (day: Day): string => day.to ?? day.date;

const cents = (amount: string): bigint => Money.from(amount).minorUnits;
const drawing = (amount: bigint): number => Number(amount) / 100;

/** Above this many days a period groups by month (AC-7): its cards compare with nothing. */
const LONGEST_COMPARED = 62;

/** True when the period is one whole calendar month ("Este mês", "Mês passado", or a range given as one). */
function isWholeMonth(period: Period): boolean {
  return period.from.endsWith("-01") && period.to === lastOfMonth(period.from);
}

/**
 * The period the chips compare with: the month before a whole month; the same number of days before any other range.
 * None for a period that has not started, or one long enough to group by month.
 */
export function comparisonPeriod(period: Period, today: string): Period | null {
  if (period.from > today || dayCount(period) > LONGEST_COMPARED) {
    return null;
  }
  const before = addDays(period.from, -1);
  if (isWholeMonth(period)) {
    return { from: `${before.slice(0, 7)}-01`, to: before };
  }
  return { from: addDays(period.from, -dayCount(period)), to: before };
}

/**
 * What a reading says it goes up to: "Até 17/10", "Até 31/12/2025" when the day is not in `thisYear`. A month reads to
 * its last day.
 */
export function untilText(
  point: { date: string; to?: string | undefined } | undefined,
  today: string
): string {
  const day = point?.to ?? point?.date ?? today;
  return `Até ${day.slice(0, 4) === today.slice(0, 4) ? shortDate(day) : fullDate(day)}`;
}

/**
 * The chip with what it compares with: short beside it ("vs. setembro", "vs. 1 a 7/09") and in full in its name. The
 * cards compare the days up to the day read with the same days of the period before, so the name of a month also says
 * those days ("setembro (1 a 25/09)").
 */
function withAgainst(
  delta: Delta | null,
  period: Period,
  priorRange: string
): Delta | null {
  if (!delta) {
    return null;
  }
  if (!isWholeMonth(period)) {
    return { ...delta, against: `vs. ${priorRange}` };
  }
  const month = monthName(addDays(period.from, -1));
  return {
    ...delta,
    against: `vs. ${month}`,
    basis: `em relação a ${month} (${priorRange})`,
  };
}

/** The sums of the days from the first to each day. */
interface Cumulative {
  count: number;
  net: bigint;
  /** null once a day up to here has no known result (or the series does not say it). */
  result: bigint | null;
}

function cumulate(days: readonly Day[]): Cumulative[] {
  const sums: Cumulative[] = [];
  let net = 0n;
  let count = 0;
  let result: bigint | null = 0n;
  for (const day of days) {
    net += cents(day.netSales);
    count += day.salesCount;
    result =
      result === null || typeof day.operatingResult !== "string"
        ? null
        : result + cents(day.operatingResult);
    sums.push({ count, net, result });
  }
  return sums;
}

/**
 * The entries of `period` in order from its first day, each starting the day after the one before ends (a day, or a
 * month that ends on its `to`), while the series has each of them: a gap ends it.
 */
function consecutive(days: readonly Day[], period: Period): Day[] {
  const byDate = new Map(days.map((day) => [day.date, day]));
  const out: Day[] = [];
  let date = period.from;
  while (date <= period.to) {
    const day = byDate.get(date);
    if (!day) {
      break;
    }
    out.push(day);
    date = addDays(lastDayOf(day), 1);
  }
  return out;
}

/** The days of the period from its first to today (or to its last, when that is before today): what the cards read. */
function daysUpToToday(
  daily: readonly Day[],
  period: Period,
  today: string
): Day[] {
  return consecutive(daily, {
    from: period.from,
    to: period.to < today ? period.to : today,
  });
}

/** How many days an entry adds up, and how many of them have an unknown cost (a month says it; a day is one). */
function dayCounts(day: Day): { total: number; unknown: number } {
  if (day.days !== undefined && day.unknownDays !== undefined) {
    return { total: day.days, unknown: day.unknownDays };
  }
  return { total: 1, unknown: day.operatingResult === null ? 1 : 0 };
}

/**
 * Whether the result of the days has a sparkline and a chip, and if not why (AC-8, AC-9): with a month that has an
 * unknown day, "N de M dias" counts the days of the months (D1-4).
 */
function resultKindOf(days: readonly Day[]): ResultKind {
  const counts = days.map(dayCounts);
  const unknown = counts.reduce((sum, count) => sum + count.unknown, 0);
  if (unknown > 0 || days.some((day) => day.operatingResult === null)) {
    return {
      kind: "incomplete",
      total: counts.reduce((sum, count) => sum + count.total, 0),
      unknown: Math.max(unknown, 1),
    };
  }
  if (
    days.length === 0 ||
    days.some((day) => day.operatingResult === undefined)
  ) {
    return { kind: "unsent" };
  }
  return { kind: "known" };
}

/**
 * The period before whose `periodSummary` the chip of the result needs, or null when that chip cannot exist: the
 * result is a sum of known days (`kind: "known"`) and some cost of the goods of the period is known (`cogsCoverageOf`
 * is not "none"). Only `periodSummary` runs the engine, so the Worker does not read the period before for a card with
 * no chip.
 */
export function resultChipPeriod(
  summary: Pick<StoredPeriodSummary, "daily" | "period" | "quality">,
  today: string
): Period | null {
  const days = daysUpToToday(summary.daily ?? [], summary.period, today);
  if (
    resultKindOf(days).kind !== "known" ||
    cogsCoverageOf(summary.quality) === "none"
  ) {
    return null;
  }
  return comparisonPeriod(summary.period, today);
}

export interface ResultKpiCards {
  marginPercent: string | null;
  netSales: string;
  operatingResult: string;
  salesCount: number;
  ticket: string | null;
}

/** Why the result has no sparkline and no chip: "N de M dias sem custo informado", or no series at all. */
type ResultKind =
  | { kind: "known" }
  | { kind: "incomplete"; total: number; unknown: number }
  | { kind: "unsent" };

export interface ResultKpis {
  /**
   * The days (or, above 62 days, the months) from the first of the period to today: one point of each sparkline, the
   * index the cards read together.
   */
  days: Day[];
  /** True when each point is a month (the server's `granularity` "month"): the curve adds up by month (D1-3). */
  monthly: boolean;
  /** "outubro" for a whole month, null for any other range: the title of the sales card and the words of the counts. */
  month: string | null;
  read: (index: number | null) => {
    result: KpiReading;
    sales: KpiReading;
    ticket: KpiReading;
  };
  result: ResultKind;
  series: { result: number[] | null; sales: number[]; ticket: number[] };
}

/** The same days of the period before, as far as the day read: their sums and their dates, none when not read. */
interface Prior {
  range: string;
  sum: Cumulative | undefined;
}

interface ReadContext {
  /** The period the cards read, to say what its chips compare with. */
  period: Period;
  /** At rest: the period up to today, with the server's cards as the numbers. */
  atRest: boolean;
  cards: ResultKpiCards;
  date: string;
  /** Whether the reading is of the period up to today, which has not ended: at rest, with the period reaching today. */
  open: boolean;
  /** The period before as the `periodSummary` read it (it has the result of each day): what the result chip compares. */
  prior: Prior;
  /** The period before as `dailySales` read it (sales and counts only): what the chips of sales and ticket compare. */
  priorSales: Prior;
  range: string;
  result: ResultKind;
  sum: Cumulative;
  /** The whole period, as the server's cards read it: "outubro inteiro". */
  whole: string;
}

/** "ainda" only for a period that is still open at its end; a closed one, or a day of it already gone, has none. */
function noSalesText(open: boolean): string {
  return open ? "Nenhuma venda ainda" : "Sem vendas no período";
}

function salesReading({
  atRest,
  cards,
  open,
  period,
  priorSales,
  range,
  sum,
}: ReadContext): KpiReading {
  const before = priorSales.sum;
  const delta = before
    ? withAgainst(
        percentDelta(sum.net, before.net, `em relação a ${priorSales.range}`),
        period,
        priorSales.range
      )
    : null;
  let compare = "";
  if (delta) {
    compare = ` Compara com ${priorSales.range}.`;
  } else if (before && before.count === 0) {
    compare = ` Sem vendas de ${priorSales.range}, não há comparação.`;
  }
  const count = atRest ? cards.salesCount : sum.count;
  return {
    count: count === 0 ? noSalesText(open) : salesCountText(count),
    date: range,
    delta,
    help: `Vendas líquidas de ${range}.${compare}`,
    note: null,
    value: atRest ? cards.netSales : Money.fromMinorUnits(sum.net).toString(),
  };
}

function resultReading({
  atRest,
  cards,
  period,
  prior,
  range,
  result,
  sum,
  whole,
}: ReadContext): KpiReading {
  const known =
    result.kind === "known" && sum.result !== null ? sum.result : null;
  // at rest the number is the server's card, the same as the last line of the chain. It is the sum of the days up to
  // today when every day is known and nothing is dated after today: then it has the dates of those days and its
  // chip. Otherwise (an unknown day, or an expense whose competence is after today) the card is of the whole period,
  // as its date says, with no chip: a chip of the days up to today beside it would compare another number
  const card =
    atRest && (known === null || known !== cents(cards.operatingResult));
  const delta =
    !card && known !== null && prior.sum && prior.sum.result !== null
      ? withAgainst(
          moneyDelta(known, prior.sum.result, `em relação a ${prior.range}`),
          period,
          prior.range
        )
      : null;
  let value: string | null =
    known === null ? null : Money.fromMinorUnits(known).toString();
  if (card) {
    value = cards.operatingResult;
  }
  return {
    count: NOT_PROFIT_NOR_CASH,
    date: card ? whole : range,
    delta,
    help: resultHelp(
      card ? "do período inteiro" : `de ${range}`,
      delta ? prior.range : null,
      result.kind === "incomplete" ? result : null
    ),
    note: null,
    value,
  };
}

const ticketOf = (sum: Cumulative | undefined): bigint | null =>
  sum && sum.count > 0 ? divideHalfUp(sum.net, BigInt(sum.count)) : null;

function ticketReading({
  atRest,
  cards,
  period,
  priorSales,
  range,
  sum,
}: ReadContext): KpiReading {
  const ticket = ticketOf(sum);
  const priorTicket = ticketOf(priorSales.sum);
  const delta =
    ticket !== null && priorTicket !== null
      ? withAgainst(
          percentDelta(ticket, priorTicket, `em relação a ${priorSales.range}`),
          period,
          priorSales.range
        )
      : null;
  let value: string | null = cards.ticket;
  if (!atRest) {
    value = ticket === null ? null : Money.fromMinorUnits(ticket).toString();
  }
  return {
    count: value === null ? "Sem vendas no período" : "",
    date: range,
    delta,
    help: ticketHelp(range, delta ? priorSales.range : null),
    note: null,
    value,
  };
}

/** The days of the period before, with its period: the shape both reads of it (`periodSummary`, `dailySales`) take. */
export interface PriorSeries {
  days: readonly Day[];
  period: Period;
}

/**
 * The period before, as many days of it as from the first to the day read (at most all of it); a series with a gap
 * compares only as far as it goes.
 */
function priorReader(
  series: PriorSeries | null,
  thisYear: string
): (at: number) => Prior {
  const sums = series ? cumulate(consecutive(series.days, series.period)) : [];
  const length = series ? dayCount(series.period) : 0;
  return (at) => {
    const compared = Math.min(at + 1, length);
    return {
      range: series
        ? periodShort(
            series.period.from,
            addDays(series.period.from, compared - 1),
            thisYear
          )
        : "",
      sum:
        series && compared > 0 && sums.length >= compared
          ? sums[compared - 1]
          : undefined,
    };
  };
}

/**
 * The cards of the period. `previous` is the daily series of `comparisonPeriod` as `periodSummary` read it (it has the
 * result of each day: the chip of the result) and `previousSales` the same days as `dailySales` read them (sales and
 * counts: the chips of sales and ticket). Each is null when it was not read: no chip, nothing said about it.
 */
export function resultKpis({
  cards,
  daily,
  period,
  previous,
  previousSales,
  today,
}: {
  cards: ResultKpiCards;
  daily: readonly Day[];
  period: Period;
  previous: PriorSeries | null;
  previousSales: PriorSeries | null;
  today: string;
}): ResultKpis {
  const days = daysUpToToday(daily, period, today);
  const sums = cumulate(days);
  const thisYear = today.slice(0, 4);
  const priorResult = priorReader(previous, thisYear);
  const priorSales = priorReader(previousSales, thisYear);
  const month = isWholeMonth(period) ? monthName(period.from) : null;

  // the same day the chart hatches: the contract sends `costs` and `operatingResult` null together (AC-8)
  const result = resultKindOf(days);
  const whole = month
    ? `${month} inteiro`
    : periodShort(period.from, period.to, thisYear);

  const read = (index: number | null) => {
    // an index of another series (the period changed under the pointer) reads the last day of this one
    const at = Math.min(index ?? sums.length - 1, sums.length - 1);
    // a month is read to its last day, which the server cuts at today (D1-2, D1-5)
    const point = days[at];
    const date = point ? lastDayOf(point) : today;
    const context: ReadContext = {
      atRest: index === null,
      cards,
      date,
      open: index === null && period.to >= today,
      period,
      prior: priorResult(at),
      priorSales: priorSales(at),
      // a period that has not started has no day yet: its dates are the whole period
      range: days.length > 0 ? periodShort(period.from, date, thisYear) : whole,
      result,
      sum: sums[at] ?? { count: 0, net: 0n, result: 0n },
      whole,
    };
    return {
      result: resultReading(context),
      sales: salesReading(context),
      ticket: ticketReading(context),
    };
  };

  const firstTicket = drawing(
    ticketOf(sums.find((sum) => sum.count > 0)) ?? 0n
  );
  return {
    days,
    month,
    monthly: days.some((day) => day.to !== undefined),
    read,
    result,
    series: {
      result:
        result.kind === "known"
          ? sums.map((sum) => drawing(sum.result ?? 0n))
          : null,
      sales: sums.map((sum) => drawing(sum.net)),
      ticket: sums.map((sum) => {
        const ticket = ticketOf(sum);
        return ticket === null ? firstTicket : drawing(ticket);
      }),
    },
  };
}
