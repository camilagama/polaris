import { Money } from "@polaris/domain/money/money";
import {
  divideHalfUp,
  type KpiReading,
  moneyDelta,
  percentDelta,
} from "../home/home-kpis";
import { salesCountText, shortDate } from "../home/home-model";
import type { StoredDay } from "../lib/period-summary-cache";
import { addDays, dayCount, monthName, type Period } from "./result-period";

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

type Day = Pick<StoredDay, "date" | "netSales" | "salesCount"> &
  Partial<Pick<StoredDay, "operatingResult">>;

const cents = (amount: string): bigint => Money.from(amount).minorUnits;
const drawing = (amount: bigint): number => Number(amount) / 100;

/** Above this many days a period groups by month (AC-7): its cards compare with nothing. */
const LONGEST_COMPARED = 62;

function lastOfMonth(day: string): string {
  return addDays(`${addDays(`${day.slice(0, 7)}-28`, 4).slice(0, 7)}-01`, -1);
}

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

/** "1 a 25/10" within a month, "26/09 a 25/10" across two, "25/10" for one day. */
export function rangeText(first: string, last: string): string {
  if (first === last) {
    return shortDate(last);
  }
  return first.slice(0, 7) === last.slice(0, 7)
    ? `${Number(first.slice(8, 10))} a ${shortDate(last)}`
    : `${shortDate(first)} a ${shortDate(last)}`;
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

/** The days of `period` in order from its first one, while the series has each of them: a gap ends it. */
function consecutive(days: readonly Day[], period: Period): Day[] {
  const byDate = new Map(days.map((day) => [day.date, day]));
  const out: Day[] = [];
  for (let date = period.from; date <= period.to; date = addDays(date, 1)) {
    const day = byDate.get(date);
    if (!day) {
      break;
    }
    out.push(day);
  }
  return out;
}

/**
 * True when no cost of the period is known: every day up to today has a null result, or every item line sold has an
 * unknown cost (the server's CMV is then zero by lack of data, not by fact). The margin and the result of the server
 * are then the sales, not an estimate: the cards show a dash, never a number made of costs read as zero.
 */
export function noKnownCost(
  days: readonly Day[],
  quality: { itemLines: number; itemLinesWithUnknownCost: number }
): boolean {
  if (days.length > 0 && days.every((day) => day.operatingResult === null)) {
    return true;
  }
  return (
    quality.itemLines > 0 &&
    quality.itemLinesWithUnknownCost >= quality.itemLines
  );
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
  /** The days from the first of the period to today: one point of each sparkline, the index the cards read together. */
  days: Day[];
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

interface ReadContext {
  /** At rest: the period up to today, with the server's cards as the numbers. */
  atRest: boolean;
  cards: ResultKpiCards;
  date: string;
  /** The sums of the same days of the period before, or undefined when they were not read (or not all of them). */
  prior: Cumulative | undefined;
  priorRange: string;
  range: string;
  result: ResultKind;
  /** "no mês" or "no período". */
  scope: string;
  sum: Cumulative;
  /** The whole period, as the server's cards read it: "outubro inteiro". */
  whole: string;
}

function salesReading({
  atRest,
  cards,
  date,
  prior,
  priorRange,
  range,
  scope,
  sum,
}: ReadContext): KpiReading {
  const delta = prior ? percentDelta(sum.net, prior.net) : null;
  let note: string | null = delta ? `vs. ${priorRange}` : null;
  if (!delta && prior && prior.count === 0) {
    note = `Sem vendas de ${priorRange} para comparar`;
  }
  return {
    count: atRest
      ? `${salesCountText(cards.salesCount)} ${scope}`
      : `${salesCountText(sum.count)} até ${shortDate(date)}`,
    date: range,
    delta,
    note,
    value: atRest ? cards.netSales : Money.fromMinorUnits(sum.net).toString(),
  };
}

function resultReading({
  atRest,
  cards,
  prior,
  priorRange,
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
    !card && known !== null && prior && prior.result !== null
      ? moneyDelta(known, prior.result)
      : null;
  let value: string | null =
    known === null ? null : Money.fromMinorUnits(known).toString();
  if (card) {
    value = cards.operatingResult;
  }
  return {
    count: "Não é lucro líquido nem dinheiro já recebido.",
    date: card ? whole : range,
    delta,
    note: delta ? `vs. ${priorRange}` : null,
    value,
  };
}

const ticketOf = (sum: Cumulative | undefined): bigint | null =>
  sum && sum.count > 0 ? divideHalfUp(sum.net, BigInt(sum.count)) : null;

function ticketReading({
  atRest,
  cards,
  prior,
  priorRange,
  range,
  scope,
  sum,
}: ReadContext): KpiReading {
  const ticket = ticketOf(sum);
  const priorTicket = ticketOf(prior);
  const delta =
    ticket !== null && priorTicket !== null
      ? percentDelta(ticket, priorTicket)
      : null;
  let value: string | null = cards.ticket;
  if (!atRest) {
    value = ticket === null ? null : Money.fromMinorUnits(ticket).toString();
  }
  let count: Pick<KpiReading, "count" | "countNarrow"> = {
    count: `Média por venda de ${range}`,
  };
  if (value === null) {
    count = { count: "Sem vendas no período" };
  } else if (atRest) {
    count = {
      count: `Média por venda ${scope}`,
      countNarrow: "Média por venda",
    };
  }
  return {
    ...count,
    date: range,
    delta,
    note: delta ? `vs. ${priorRange}` : null,
    value,
  };
}

/**
 * The cards of the period. `previous` is the daily series of `comparisonPeriod` (null when it was not read: no chip,
 * nothing said about it); a previous series with a gap compares only as far as it goes.
 */
export function resultKpis({
  cards,
  daily,
  period,
  previous,
  today,
}: {
  cards: ResultKpiCards;
  daily: readonly Day[];
  period: Period;
  previous: { days: readonly Day[]; period: Period } | null;
  today: string;
}): ResultKpis {
  const days = consecutive(daily, {
    from: period.from,
    to: period.to < today ? period.to : today,
  });
  const sums = cumulate(days);
  const before = previous ? consecutive(previous.days, previous.period) : [];
  const beforeSums = cumulate(before);
  const beforeLength = previous ? dayCount(previous.period) : 0;
  const month = isWholeMonth(period) ? monthName(period.from) : null;
  const scope = month ? "no mês" : "no período";

  // the same day the chart hatches: the contract sends `costs` and `operatingResult` null together (AC-8)
  const unknown = days.filter((day) => day.operatingResult === null).length;
  let result: ResultKind = { kind: "known" };
  if (unknown > 0) {
    result = { kind: "incomplete", total: days.length, unknown };
  } else if (
    days.length === 0 ||
    days.some((day) => day.operatingResult === undefined)
  ) {
    result = { kind: "unsent" };
  }
  const whole = month ? `${month} inteiro` : rangeText(period.from, period.to);

  const read = (index: number | null) => {
    // an index of another series (the period changed under the pointer) reads the last day of this one
    const at = Math.min(index ?? sums.length - 1, sums.length - 1);
    const date = days[at]?.date ?? today;
    // the same days of the period before, as many as from the first to the day read, at most all of it
    const compared = Math.min(at + 1, beforeLength);
    const context: ReadContext = {
      atRest: index === null,
      cards,
      date,
      prior:
        previous && compared > 0 && beforeSums.length >= compared
          ? beforeSums[compared - 1]
          : undefined,
      priorRange: previous
        ? rangeText(
            previous.period.from,
            addDays(previous.period.from, compared - 1)
          )
        : "",
      // a period that has not started has no day yet: its dates are the whole period
      range: days.length > 0 ? rangeText(period.from, date) : whole,
      result,
      scope,
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
