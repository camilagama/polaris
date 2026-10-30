import { Money } from "@polaris/domain/money/money";
import { NO_KNOWN_COST_RESULT } from "../dashboard/dashboard-model";
import { formatBrlAmount } from "../lib/format";
import {
  cogsCoverageOf,
  type StoredDay,
  type StoredQuality,
} from "../lib/period-summary-cache";
import {
  addDays,
  firstOfMonth,
  monthTitle,
  salesCountText,
  shortDate,
} from "./home-model";

/**
 * The four KPI cards of the Início (revisão de UI v7, § 3, items 2 to 6): what each one says for today and for any
 * day read on its sparkline, from the daily series the Início already reads (A, the month, and B, the days before it);
 * nothing new is asked of the server. Money is added and divided in exact cents (the ticket is rounded half-up to the
 * cent, as the server rounds the card's); a percent is a ratio of two exact sums, rounded half-up to one place.
 *
 * - Vendas hoje: the net sales of a day against the mean of the 4 same weekdays before it. No date at rest: the title and
 *   the header say it is today; reading another day puts it ("qui, 22/10") at the top right.
 * - Vendas no mês: the net sales from the 1st to a day, against the same days of the previous month.
 * - Resultado estimado: the same, in reais, and only when every day of both sides has a known result (AC-9: a sum of
 *   the known days is never shown as the total). Without it, the number at rest is the server's card of the whole
 *   month, and its date says so ("outubro inteiro"). With no cost of the goods known (`cogsCoverageOf` is "none") it
 *   is a dash, with no chip and no sparkline, as on the Resultado: the server's number there is the sales.
 * - Ticket médio: net sales over sales from the 1st to a day, against the same days of the previous month.
 */

type Day = Pick<StoredDay, "date" | "netSales" | "salesCount"> &
  Partial<Pick<StoredDay, "operatingResult">>;

const cents = (amount: string): bigint => Money.from(amount).minorUnits;

/** round-half-up(numerator / denominator), ties away from zero; denominator > 0 (the rule of the server's ticket). */
export function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const rounded = (absolute * 2n + denominator) / (denominator * 2n);
  return negative ? -rounded : rounded;
}

/** The chip of a card: its text, whether it went up (green) or not (neutral: selling less is not an error). */
export interface Delta {
  /** What the change is against, for the name of the chip: "em relação a 1 a 23/09". */
  basis?: string;
  /** True when the text is an amount in reais (the result's chip), which "Esconder valores" hides. */
  money: boolean;
  /** What a screen reader says in place of `text`, when the sign does not read well ("16,0 vezes" for "16,0×"). */
  spoken?: string;
  text: string;
  trend: "down" | "flat" | "up";
}

const trendOf = (difference: bigint): Delta["trend"] => {
  if (difference > 0n) {
    return "up";
  }
  return difference < 0n ? "down" : "flat";
};

/** "1.234": the digits of a whole number grouped by thousands. */
const grouped = (whole: bigint): string =>
  whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");

/** "+52,9%", "-12,0%", "0,0%" from tenths of a percent. */
function percentText(tenths: bigint): string {
  const absolute = tenths < 0n ? -tenths : tenths;
  let sign = "";
  if (tenths !== 0n) {
    sign = tenths > 0n ? "+" : "-";
  }
  return `${sign}${grouped(absolute / 10n)},${absolute % 10n}%`;
}

/** From +1.000,0% up, the chip says how many times the base: "16,0×", and "123×" with no place from 100 times up. */
const MULTIPLE_FROM_TENTHS = 10_000n;

function multipleText(
  current: bigint,
  base: bigint
): {
  spoken: string;
  text: string;
} {
  const tenths = divideHalfUp(current * 10n, base);
  const number =
    tenths >= 1000n
      ? grouped(divideHalfUp(current, base))
      : `${grouped(tenths / 10n)},${tenths % 10n}`;
  return { spoken: `${number} vezes`, text: `${number}×` };
}

/**
 * How much `current` moved against `base`, in percent with one place, or as a multiple from +1.000% up (a percent of
 * five digits says less than "16,0×"); null over a base that is not above zero (a percent over nothing, or over a
 * negative, says nothing).
 */
export function percentDelta(
  current: bigint,
  base: bigint,
  basis?: string
): Delta | null {
  if (base <= 0n) {
    return null;
  }
  const named = basis === undefined ? {} : { basis };
  const tenths = divideHalfUp((current - base) * 1000n, base);
  if (tenths >= MULTIPLE_FROM_TENTHS) {
    return {
      ...named,
      money: false,
      ...multipleText(current, base),
      trend: "up",
    };
  }
  return {
    ...named,
    money: false,
    text: percentText(tenths),
    trend: trendOf(tenths),
  };
}

/** "+R$ 436,86", "-R$ 12,00", "R$ 0,00": the difference in reais (the result's chip, § 3 item 4). */
export function moneyDelta(
  current: bigint,
  base: bigint,
  basis?: string
): Delta {
  const difference = current - base;
  const text = formatBrlAmount(Money.fromMinorUnits(difference).toString());
  return {
    ...(basis === undefined ? {} : { basis }),
    money: true,
    text: difference > 0n ? `+${text}` : text,
    trend: trendOf(difference),
  };
}

/** The weekdays: `plural` for the line of the card ("média das sextas"), `long` for the help ("4 sextas-feiras"). */
const WEEKDAYS = [
  { in: "nos", long: "domingos", of: "dos", plural: "domingos", short: "dom" },
  {
    in: "nas",
    long: "segundas-feiras",
    of: "das",
    plural: "segundas",
    short: "seg",
  },
  {
    in: "nas",
    long: "terças-feiras",
    of: "das",
    plural: "terças",
    short: "ter",
  },
  {
    in: "nas",
    long: "quartas-feiras",
    of: "das",
    plural: "quartas",
    short: "qua",
  },
  {
    in: "nas",
    long: "quintas-feiras",
    of: "das",
    plural: "quintas",
    short: "qui",
  },
  {
    in: "nas",
    long: "sextas-feiras",
    of: "das",
    plural: "sextas",
    short: "sex",
  },
  { in: "nos", long: "sábados", of: "dos", plural: "sábados", short: "sáb" },
] as const;

function weekdayOf(day: string) {
  return WEEKDAYS[new Date(`${day}T00:00:00.000Z`).getUTCDay()] ?? WEEKDAYS[0];
}

/** "qui, 22/10": the date of the card of a day other than today. */
function weekdayDate(day: string): string {
  return `${weekdayOf(day).short}, ${shortDate(day)}`;
}

/** What a card says for one day, or for the period up to it. */
export interface KpiReading {
  /** The count or the line of the card: "12 vendas", "Nenhuma venda ainda"; empty when the card has none. */
  count: string;
  /**
   * The date: "1 a 25/10" for the cards of the month (their group says it once), "" for Vendas hoje at rest, and the
   * weekday and day ("qui, 22/10") when another day is read.
   */
  date: string;
  delta: Delta | null;
  /** What the (i) says: what the number is, and what it compares with or why there is no comparison (up to 2 sentences). */
  help: string;
  /** What stays in sight of the comparison, only Vendas hoje ("vs. média das sextas"); the others say it in the (i). */
  note: string | null;
  /** The amount as the server writes money, or null when there is none (a ticket with no sale). */
  value: string | null;
}

function byDate(days: readonly Day[]): Map<string, Day> {
  return new Map(days.map((day) => [day.date, day]));
}

/** The 30 days that end on today: the sparkline of "Vendas hoje" (a day the series does not have is a zero). */
export function todaySeries(
  before: readonly Day[],
  month: readonly Day[],
  today: string
): Day[] {
  const all = byDate([...before, ...month]);
  return Array.from({ length: 30 }, (_, index) => {
    const date = addDays(today, index - 29);
    return all.get(date) ?? { date, netSales: "0.00", salesCount: 0 };
  });
}

/**
 * "Vendas hoje" for a day: its net sales and count against the mean of the 4 same weekdays before it (§ 3 item 2),
 * which is steadier than "last Sunday". With no sale on the 4, it says so and draws no chip; when one of the 4 is not
 * in the series read (a day early in the 30), it says nothing.
 */
export function dayReading(
  before: readonly Day[],
  month: readonly Day[],
  day: string,
  today: string
): KpiReading {
  const all = byDate([...before, ...month]);
  const entry = all.get(day) ?? { date: day, netSales: "0.00", salesCount: 0 };
  const previous = [7, 14, 21, 28].map((back) => all.get(addDays(day, -back)));
  const weekday = weekdayOf(day);
  const against = `média ${weekday.of} 4 ${weekday.long} anteriores`;
  let delta: Delta | null = null;
  let note: string | null = null;
  let compare = "";
  if (previous.every((item) => item !== undefined)) {
    const known = previous as Day[];
    const sold = known.reduce((total, item) => total + item.salesCount, 0);
    const sum = known.reduce((total, item) => total + cents(item.netSales), 0n);
    if (sold === 0) {
      compare = ` Sem venda ${weekday.in} 4 ${weekday.long} anteriores, não há comparação.`;
    } else {
      // the mean of the 4 is sum / 4: the day against it is (4 × day − sum) / sum
      // the base is in sight on the card ("vs. média das sextas"): the chip needs no name that says it again
      delta = percentDelta(cents(entry.netSales) * 4n, sum);
      if (delta) {
        note = `vs. média ${weekday.of} ${weekday.plural}`;
        compare = ` Compara com a ${against}.`;
      }
    }
  }
  let count = salesCountText(entry.salesCount);
  if (entry.salesCount === 0) {
    count = day === today ? "Nenhuma venda ainda" : "Nenhuma venda";
  }
  return {
    count,
    date: day === today ? "" : weekdayDate(day),
    delta,
    help: `Vendas líquidas de ${day === today ? "hoje" : weekdayDate(day)}.${compare}`,
    note,
    value: entry.netSales,
  };
}

/** The sums of the days from the 1st to each day: the sparklines of the month and what a card reads on them. */
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
      result === null ||
      day.operatingResult === null ||
      day.operatingResult === undefined
        ? null
        : result + cents(day.operatingResult);
    sums.push({ count, net, result });
  }
  return sums;
}

/** Why the result's card draws no sparkline and no chip, and the sentence it says then (AC-9). */
type ResultSeries =
  | { kind: "known" }
  /** No cost of the goods of the month is known: the dash and "Sem custo conhecido: o resultado não dá para estimar." */
  | { kind: "noCost" }
  /** Some day from the 1st to today has no known cost: "N de M dias sem custo informado". */
  | { kind: "incomplete"; total: number; unknown: number }
  /** A copy kept before the results of the day existed: nothing of the series is drawn, nothing is said. */
  | { kind: "unsent" };

export interface MonthKpis {
  /** The days from the 1st to today: one point of each sparkline per day, the index the cards read together. */
  days: Day[];
  /** What each card says when read on a day (`index`) or at rest (`null`, today and the server's cards). */
  read: (index: number | null) => {
    result: KpiReading;
    sales: KpiReading;
    ticket: KpiReading;
  };
  result: ResultSeries;
  /** The values of the sparklines, for the drawing only (reais as numbers). */
  series: { result: number[] | null; sales: number[]; ticket: number[] };
}

const drawing = (amount: bigint): number => Number(amount) / 100;

/** "1 a 25/10", or "01/10" on the first day. */
function rangeText(first: string, last: string): string {
  return first === last ? shortDate(last) : `1 a ${shortDate(last)}`;
}

interface ReadContext {
  /** At rest: today, with the server's cards as the numbers. */
  atRest: boolean;
  cards: {
    netSales: string;
    operatingResult: string;
    salesCount: number;
    ticket: string | null;
  };
  date: string;
  /** The sums of the same days of the previous month, or undefined when B does not have them all. */
  previous: Cumulative | undefined;
  previousRange: string;
  range: string;
  result: ResultSeries;
  sum: Cumulative;
  /** "outubro inteiro": the period of the server's cards, which read the month to its last day. */
  wholeMonth: string;
}

function salesReading({
  atRest,
  cards,
  previous,
  previousRange,
  range,
  sum,
}: ReadContext): KpiReading {
  const delta = previous
    ? percentDelta(sum.net, previous.net, `em relação a ${previousRange}`)
    : null;
  let compare = "";
  if (delta) {
    compare = ` Compara com ${previousRange}.`;
  } else if (previous && previous.count === 0) {
    compare = ` Sem vendas de ${previousRange}, não há comparação.`;
  }
  const count = atRest ? cards.salesCount : sum.count;
  return {
    count: count === 0 ? "Nenhuma venda ainda" : salesCountText(count),
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
  previous,
  previousRange,
  range,
  result,
  sum,
  wholeMonth,
}: ReadContext): KpiReading {
  if (result.kind === "noCost") {
    return {
      count: NO_KNOWN_COST_RESULT,
      date: atRest ? wholeMonth : range,
      delta: null,
      help: resultHelp(`de ${range}`, null, null),
      note: null,
      value: null,
    };
  }
  const delta =
    result.kind === "known" &&
    sum.result !== null &&
    previous &&
    previous.result !== null
      ? moneyDelta(sum.result, previous.result, `em relação a ${previousRange}`)
      : null;
  // with every day known, the number is the sum from the 1st to the day read, at rest too: the same account as the
  // chip and the sparkline ("1 a 25/10"), never the whole month with the expenses dated after today. Without the
  // results of the days (some unknown, or not sent) the number at rest is the server's card, with its badge: the
  // whole month, as its date says (the read of the month is the Resultado's "Este mês", kept for both offline).
  const known =
    result.kind === "known" && sum.result !== null
      ? Money.fromMinorUnits(sum.result).toString()
      : null;
  const card = atRest && known === null;
  return {
    count: NOT_PROFIT_NOR_CASH,
    date: card ? wholeMonth : range,
    delta,
    help: resultHelp(
      card ? "do mês inteiro" : `de ${range}`,
      delta ? previousRange : null,
      result.kind === "incomplete" ? result : null
    ),
    note: null,
    value: card ? cards.operatingResult : known,
  };
}

const ticketOf = (sum: Cumulative | undefined): bigint | null =>
  sum && sum.count > 0 ? divideHalfUp(sum.net, BigInt(sum.count)) : null;

function ticketReading({
  atRest,
  cards,
  previous,
  previousRange,
  range,
  sum,
}: ReadContext): KpiReading {
  const ticket = ticketOf(sum);
  const previousTicket = ticketOf(previous);
  const delta =
    ticket !== null && previousTicket !== null
      ? percentDelta(ticket, previousTicket, `em relação a ${previousRange}`)
      : null;
  let value: string | null = cards.ticket;
  if (!atRest) {
    value = ticket === null ? null : Money.fromMinorUnits(ticket).toString();
  }
  return {
    // nothing under the number at rest: what it is and what it compares with are in the (i)
    count: value === null ? "Sem vendas no período" : "",
    date: range,
    delta,
    help: ticketHelp(range, delta ? previousRange : null),
    note: null,
    value,
  };
}

/**
 * The three cards of the month (§ 3 items 3 to 5), read together on the same day. The previous month must be whole
 * in B up to the day compared (a short B, from an old copy, compares with nothing rather than with less), and the
 * same day of a shorter month is its last day (31 March against 1 to 28 February). `quality` is the month's: with
 * no cost of the goods known the result is not estimated at all.
 */
export function monthKpis(
  before: readonly Day[],
  month: readonly Day[],
  today: string,
  cards: {
    netSales: string;
    operatingResult: string;
    salesCount: number;
    ticket: string | null;
  },
  quality: Pick<StoredQuality, "itemLines" | "itemLinesWithUnknownCost">
): MonthKpis {
  const days = month.filter(
    (day) => day.date >= firstOfMonth(today) && day.date <= today
  );
  const sums = cumulate(days);
  const previousFirst = firstOfMonth(addDays(firstOfMonth(today), -1));
  const known = byDate(before);
  const previousDays: Day[] = [];
  for (
    let date = previousFirst;
    date.startsWith(previousFirst.slice(0, 7));
    date = addDays(date, 1)
  ) {
    const entry = known.get(date);
    if (!entry) {
      break;
    }
    previousDays.push(entry);
  }
  const previousLength = Number(addDays(firstOfMonth(today), -1).slice(8, 10));
  const previousSums = cumulate(previousDays);

  const unknown = days.filter((day) => day.operatingResult === null).length;
  let result: ResultSeries = { kind: "known" };
  if (cogsCoverageOf(quality) === "none") {
    // before the days: every day with a sale has a null result then, and "N de N dias" would say less than the dash
    result = { kind: "noCost" };
  } else if (unknown > 0) {
    result = { kind: "incomplete", total: days.length, unknown };
  } else if (
    days.length === 0 ||
    days.some((day) => day.operatingResult === undefined)
  ) {
    // no series at all (a copy kept before it existed) is no known result either: never a sum of no day as "0,00"
    result = { kind: "unsent" };
  }

  const read = (index: number | null) => {
    const at = index === null ? sums.length - 1 : index;
    // the same days of the previous month: as many as from the 1st to the day read, at most the whole month
    const compared = Math.min(at + 1, previousLength);
    const previousTo = addDays(previousFirst, compared - 1);
    const context: ReadContext = {
      atRest: index === null,
      cards,
      date: days[at]?.date ?? today,
      previous:
        previousSums.length >= compared
          ? previousSums[compared - 1]
          : undefined,
      previousRange: rangeText(previousFirst, previousTo),
      range: "",
      result,
      sum: sums[at] ?? { count: 0, net: 0n, result: 0n },
      wholeMonth: `${monthTitle(today).toLowerCase()} inteiro`,
    };
    context.range = rangeText(firstOfMonth(today), context.date);
    return {
      result: resultReading(context),
      sales: salesReading(context),
      ticket: ticketReading(context),
    };
  };

  // before the first sale the ticket has no value: the drawing starts flat at the first one, the reading says "sem vendas"
  const firstTicket = sums.find((sum) => sum.count > 0);
  const firstTicketValue = drawing(ticketOf(firstTicket) ?? 0n);
  return {
    days,
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
        return ticket === null ? firstTicketValue : drawing(ticket);
      }),
    },
  };
}

/** The warning of the result card that is never hidden: what the number is not. */
export const NOT_PROFIT_NOR_CASH = "Não é lucro líquido nem caixa";

/** "5 de 23 dias sem custo": the days of the period that still have no cost informed (AC-6, AC-9). */
export function unknownDaysText(unknown: number, total: number): string {
  return `${unknown} de ${total} ${total === 1 ? "dia" : "dias"} sem custo`;
}

/**
 * Whether "estimativa incompleta · N de M dias sem custo" fits one line of the card at 360 px (13 px text, with room
 * left for two digits on each side: a month never has more). A longer count, which a long period of the Resultado
 * can have, goes to the (i), which says it in words (`resultHelp`).
 */
export function unknownDaysFit(unknown: number, total: number): boolean {
  return unknown <= 99 && total <= 99;
}

/**
 * What the (i) of the result card says: what the number is for `span` ("de 1 a 23/10", "do mês inteiro") and what it
 * compares with. With a count of days that does not fit the card, the sentence of the days takes the place of the
 * comparison (the chip, which has none then, would not say it).
 */
export function resultHelp(
  span: string,
  compare: string | null,
  missing: { total: number; unknown: number } | null
): string {
  const first = `Vendas menos custos, taxas e despesas ${span}.`;
  if (missing && !unknownDaysFit(missing.unknown, missing.total)) {
    return `${first} ${missing.unknown} de ${missing.total} dias ainda sem custo informado.`;
  }
  return compare ? `${first} Compara com ${compare}.` : first;
}

/** What the (i) of the ticket says. */
export function ticketHelp(range: string, compare: string | null): string {
  const first = `Vendas líquidas divididas pelo número de vendas, de ${range}.`;
  return compare ? `${first} Compara com ${compare}.` : first;
}
