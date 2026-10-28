import { Money } from "@polaris/domain/money/money";
import { formatBrlAmount, formatCalendarDate } from "../lib/format";
import { cogsCoverageOf, type StoredDay } from "../lib/period-summary-cache";
import type { PeriodChain, PeriodQuality } from "./dashboard-model";
import { monthAbbreviation, monthName } from "./result-period";

/**
 * The series of the Resultado chart and its table (corte resultado-v2, AC-5 to AC-12): the days up to the store's today,
 * the days after it kept apart, the rule that a day with an unknown cost is hatched and breaks the cost line only on
 * itself (AC-9: never a zero, never a partial sum as the total), the grouping by month of the
 * long periods, the parts of the cost and the sentences that depend on what is drawn. Money is added in exact cents
 * (`Money`); the numbers given to a drawing are only for the drawing.
 */

/** Above this many days the chart and the table group by month (AC-7): at most 13 points. */
const GROUP_ABOVE_DAYS = 62;

/**
 * What the table, the reading of a day and the tooltip say for a day whose cost the server could not know (AC-9):
 * never 0,00. One text everywhere, so the eye and the screen reader meet the same words.
 */
export const NO_COST_TEXT = "sem custo informado";

const ZERO = Money.fromMinorUnits(0n);

/** A point of the chart and a row of the table: a day, or a month once the period is long. */
export interface ResultRow {
  /** The cost of the row: money, unknown (`null`) or not sent (`undefined`, an older server or copy). */
  costs: string | null | undefined;
  /**
   * The expenses without a sale that fell on the day (the server's `operatingExpenses`, also on a day with sales),
   * or null when there is none, or when the day cannot say (a group of months; an older server or copy that sends no
   * `operatingExpenses`, where only a day with no sale is known: everything it costs is one, AC-8).
   */
  expenses: string | null;
  /** The date of a day, the month ("2026-01") of a group. */
  key: string;
  /** The text on the x axis: "18/10", or "jan". */
  label: string;
  netSales: string;
  operatingResult: string | null | undefined;
  salesCount: number;
  /** The text in the first column of the table: "18/10/2026", or "janeiro de 2026". */
  tableLabel: string;
}

const cents = (amount: string): bigint => Money.from(amount).minorUnits;

/** The number a drawing gets from an exact text: cents to reais. Only for the drawing. */
export function chartNumber(amount: string): number {
  return Number(cents(amount)) / 100;
}

/** "18/10" for "2026-10-18". */
function shortDay(day: string): string {
  return `${day.slice(8, 10)}/${day.slice(5, 7)}`;
}

const GROUP_OF_THREE = /\B(?=(\d{3})+(?!\d))/g;

/** A value of the y axis with no unit (the unit goes once, on the top line): "500", "1.250", "12,5 mil", "1 mi". */
export function axisMoney(value: number): string {
  const decimal = (amount: number) =>
    String(Math.round(amount * 100) / 100).replace(".", ",");
  if (value >= 999_950) {
    return `${decimal(value / 1_000_000)} mi`;
  }
  if (value >= 9999.5) {
    return `${decimal(value / 1000)} mil`;
  }
  return value >= 1000
    ? String(Math.round(value)).replace(GROUP_OF_THREE, ".")
    : decimal(value);
}

/** The exact text of a value of the drawing, for the reading of the day. */
export function moneyText(value: number): string {
  return formatBrlAmount((Math.round(value * 100) / 100).toFixed(2));
}

/**
 * True when the cost line and the result of the day can be drawn: every day of the period has both, as money. One day
 * with an unknown cost (`null`), or a server or a copy that sends none (`undefined`), draws neither, and the screen
 * never adds the costs that are known as if they were the total (AC-9).
 */
export function costsKnown(days: readonly StoredDay[]): boolean {
  return (
    days.length > 0 &&
    days.every(
      (day) =>
        typeof day.costs === "string" && typeof day.operatingResult === "string"
    )
  );
}

/** True when the period has a day with an unknown cost, as opposed to costs the server never sent. */
export function hasUnknownCostDay(days: readonly StoredDay[]): boolean {
  return days.some(isUnknownDay);
}

/** A day the server could not know the cost of: both fields `null` (AC-8), or either one. */
function isUnknownDay(day: StoredDay): boolean {
  return day.costs === null || day.operatingResult === null;
}

/**
 * True when every day says its cost, known (money) or unknown (`null`): a server or a copy that sends none
 * (`undefined`) has no cost series at all, which is not the same as an unknown one.
 */
export function costsSent(days: readonly StoredDay[]): boolean {
  return (
    days.length > 0 &&
    days.every(
      (day) => day.costs !== undefined && day.operatingResult !== undefined
    )
  );
}

/** The expenses without a sale of a day: the server's figure when it sends one, else what a day with no sale costs. */
function dayExpenses(day: StoredDay): string | null {
  if (typeof day.operatingExpenses === "string") {
    return cents(day.operatingExpenses) > 0n ? day.operatingExpenses : null;
  }
  return day.salesCount === 0 &&
    typeof day.costs === "string" &&
    cents(day.costs) > 0n
    ? day.costs
    : null;
}

function dayRow(day: StoredDay): ResultRow {
  const expenses = dayExpenses(day);
  return {
    costs: day.costs,
    expenses,
    key: day.date,
    label: shortDay(day.date),
    netSales: day.netSales,
    operatingResult: day.operatingResult,
    salesCount: day.salesCount,
    tableLabel: formatCalendarDate(day.date),
  };
}

/** One field summed over the rows of a group: unknown if any day is, not sent if any day has none. */
function sumOptional(
  values: ReadonlyArray<string | null | undefined>
): string | null | undefined {
  if (values.some((value) => value === undefined)) {
    return undefined;
  }
  if (values.some((value) => value === null)) {
    return null;
  }
  return values
    .reduce((total, value) => total.add(Money.from(value as string)), ZERO)
    .toString();
}

/**
 * The daily rows summed by calendar month, in order (AC-7): the net sales and the sales with `Money`, the cost and
 * the result unknown when any day of the month is. The month names itself on the axis ("jan") and in the table
 * ("janeiro de 2026"). The sum of the groups is the sum of the days.
 */
function groupByMonth(rows: readonly ResultRow[]): ResultRow[] {
  const groups = new Map<string, ResultRow[]>();
  for (const row of rows) {
    const month = row.key.slice(0, 7);
    groups.set(month, [...(groups.get(month) ?? []), row]);
  }
  return [...groups].map(([month, members]) => ({
    costs: sumOptional(members.map((row) => row.costs)),
    expenses: null,
    key: month,
    label: monthAbbreviation(month),
    netSales: members
      .reduce((total, row) => total.add(Money.from(row.netSales)), ZERO)
      .toString(),
    operatingResult: sumOptional(members.map((row) => row.operatingResult)),
    salesCount: members.reduce((total, row) => total + row.salesCount, 0),
    tableLabel: `${monthName(month)} de ${month.slice(0, 4)}`,
  }));
}

export interface ResultSeries {
  /** The expenses of the days after today as one sum, when there are some and the costs are known (AC-10). */
  afterToday: string | null;
  /**
   * The cost line is drawn: every day says its cost (`costsSent`) and at least one row up to today is known. The rows
   * with an unknown cost are hatched and break the line (AC-9).
   */
  costsDrawn: boolean;
  /** Every day says its cost, known or unknown: the table has the cost columns. */
  costsSent: boolean;
  /** True when the rows are months. */
  grouped: boolean;
  /** The days up to today (or the months made of them): what is drawn and what the table lists. */
  rows: ResultRow[];
  /** How many days up to today there are, and how many of them have an unknown cost ("3 de 25 dias"). */
  days: { total: number; unknown: number };
}

/**
 * The series of the screen from the server's days: every date of the period comes, and the client cuts it at the
 * store's today (AC-6, AC-10): a day to come is never drawn as zero, and what the days to come cost is kept for the
 * line "Depois de hoje" of the table, so that the table adds up to the total of the cards.
 */
export function resultSeries(
  daily: readonly StoredDay[],
  today: string
): ResultSeries {
  const sent = costsSent(daily);
  const upToToday = daily.filter((day) => day.date <= today);
  const toCome = daily.filter((day) => day.date > today);
  const rows = upToToday.map(dayRow);
  const grouped = daily.length > GROUP_ABOVE_DAYS;
  // what the days to come cost is summed only when every day of the period is known: never a partial sum (AC-9)
  const known = costsKnown(daily);
  const total = known
    ? toCome.reduce(
        (sum, day) => sum.add(Money.from(day.costs as string)),
        ZERO
      )
    : ZERO;
  return {
    afterToday:
      known && toCome.length > 0 && total.minorUnits > 0n
        ? total.toString()
        : null,
    costsDrawn: sent && rows.some((row) => typeof row.costs === "string"),
    costsSent: sent,
    days: {
      total: upToToday.length,
      unknown: sent ? upToToday.filter(isUnknownDay).length : 0,
    },
    grouped,
    rows: grouped ? groupByMonth(rows) : rows,
  };
}

/**
 * True when some row sold, returned or cost anything, or has a cost the server could not know (a hatched day is
 * something to show): otherwise the screen says "Sem vendas" and draws no line (AC-6).
 */
export function hasAnyValue(
  rows: readonly ResultRow[],
  costsDrawn: boolean
): boolean {
  return rows.some(
    (row) =>
      cents(row.netSales) !== 0n ||
      row.costs === null ||
      (costsDrawn && typeof row.costs === "string" && cents(row.costs) !== 0n)
  );
}

/**
 * The cost line as the drawing gets it: the cost of each row in reais, or `null` for a row whose cost is unknown (or
 * not sent). Never a zero in place of an unknown cost (AC-9): the chart breaks
 * the line on a `null` and hatches the row.
 */
export function costSeries(rows: readonly ResultRow[]): (number | null)[] {
  return rows.map((row) =>
    typeof row.costs === "string" ? chartNumber(row.costs) : null
  );
}

/** "3 de 25 dias sem custo informado" (AC-11). */
export function unknownDaysCount(unknown: number, total: number): string {
  return `${unknown} de ${total} ${total === 1 ? "dia" : "dias"} sem custo informado`;
}

/** The row with the highest net sales (the first when two tie), or null when no row sold anything (AC-5). */
export function bestRow(rows: readonly ResultRow[]): ResultRow | null {
  let best: ResultRow | null = null;
  for (const row of rows) {
    const value = cents(row.netSales);
    if (value > 0n && (best === null || value > cents(best.netSales))) {
      best = row;
    }
  }
  return best;
}

/** "Melhor dia: 18/10, R$ 1.840,00"; for months, "Melhor mês: janeiro, R$ 9.100,00". Null when nothing sold. */
export function bestRowText(series: ResultSeries): string | null {
  const best = bestRow(series.rows);
  if (!best) {
    return null;
  }
  const amount = formatBrlAmount(best.netSales);
  return series.grouped
    ? `Melhor mês: ${monthName(best.key)}, ${amount}`
    : `Melhor dia: ${best.label}, ${amount}`;
}

/** The third part of the reading of a day: only when an expense without a sale fell on it (AC-11). */
export function readingNote(row: ResultRow | undefined): string | null {
  return row?.expenses
    ? `inclui ${formatBrlAmount(row.expenses)} de despesas do período`
    : null;
}

/** What the table says in the cost column of a row: the amount, or "sem custo" for a day the server could not know. */
export function costText(value: string | null | undefined): string {
  return typeof value === "string" ? formatBrlAmount(value) : NO_COST_TEXT;
}

/**
 * True when the cards carry commercial surcharges (surcharge, freight, payment surcharge): they are in the result of
 * the day and not in the cost, so the two lines no longer differ by exactly the result (AC-11).
 */
export function hasSurcharges(chain: PeriodChain): boolean {
  return cents(chain.commercialSurcharges) !== 0n;
}

const COMPETENCE = "Despesas do período entram no dia da competência.";
const EQUALITY =
  "A diferença entre as duas linhas é o resultado estimado do dia";
const TO_THE_TABLE = "O resultado de cada dia está em Ver os números.";

/**
 * The line that supports the chart (AC-11), in five
 * cases. The equality "the difference between the lines is the result" holds only when the period has no commercial
 * surcharge (a surcharge is in the result and not in the cost), and, with hatched days, only on the days without the
 * hatch; with a surcharge the line sends the reader to the table. With an unknown day it starts by how many there
 * are; with no known day there is a single line and no equality. No line when the costs are not sent at all.
 */
export function supportText(
  series: Pick<ResultSeries, "costsDrawn" | "costsSent" | "days">,
  chain: PeriodChain
): string | null {
  if (!series.costsSent) {
    return null;
  }
  const { total, unknown } = series.days;
  const tail = hasSurcharges(chain)
    ? `${TO_THE_TABLE} ${COMPETENCE}`
    : `${EQUALITY}${unknown > 0 ? " nos dias sem hachura" : ""}. ${COMPETENCE}`;
  if (unknown === 0) {
    return series.costsDrawn ? tail : null;
  }
  const count = `${unknownDaysCount(unknown, total)}.`;
  return series.costsDrawn ? `${count} ${tail}` : `${count} ${COMPETENCE}`;
}

export type CostPartId = "expenses" | "fees" | "goods";

export interface CostPart {
  id: CostPartId;
  /** True when something that belongs to the part was left out because it was unknown (AC-12): "incompleto". */
  incomplete: boolean;
  label: string;
  /** The exact amount, BRL text; null for the cost of goods when none of it is known (`cogsCoverageOf` is "none"). */
  value: string | null;
}

export interface CostParts {
  parts: CostPart[];
  /**
   * The cost of the period: the sum of the parts, which is the sum of the `costs` of the days (AC-8). Null when no cost
   * of the goods is known: the server's zero there is a lack of data, and the other parts are not the whole cost.
   */
  total: string | null;
}

/**
 * The cost of the period in its three parts (AC-12): the cost of goods, the fees (processing and anticipation) and the
 * expenses (linked to a sale, and without a sale). The parts add up to `total`, which is what the days' `costs` add up
 * to; a part with an unknown input says so and the bar never pretends to be whole. With no cost of the goods known the
 * goods and the total are null: the fees and the expenses keep their values.
 */
export function costParts(
  chain: PeriodChain,
  quality: PeriodQuality
): CostParts {
  const add = (...amounts: string[]) =>
    amounts.reduce((sum, amount) => sum.add(Money.from(amount)), ZERO);
  const goods = add(chain.cogs);
  const fees = add(chain.processingFees, chain.anticipationFees);
  const expenses = add(chain.linkedExpenses, chain.operatingExpenses);
  const noKnownCost = cogsCoverageOf(quality) === "none";
  return {
    parts: [
      {
        id: "goods",
        incomplete: quality.itemLinesWithUnknownCost > 0,
        label: "Mercadorias",
        value: noKnownCost ? null : goods.toString(),
      },
      {
        id: "fees",
        incomplete:
          quality.processingFeesUnknown > 0 ||
          quality.anticipationFeesUnknown > 0,
        label: "Taxas",
        value: fees.toString(),
      },
      {
        id: "expenses",
        incomplete: false,
        label: "Despesas",
        value: expenses.toString(),
      },
    ],
    total: noKnownCost ? null : goods.add(fees).add(expenses).toString(),
  };
}
