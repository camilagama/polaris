import type { StoredQuality } from "../lib/period-summary-cache";
import { monthName } from "./result-period";

/**
 * What a day with an unknown result lacks. The server marks the day (`costs` null) when a cost, a processing fee or an
 * anticipation fee of one of its sales is unknown, and does not say which: the quality of the period does. With no item
 * line of unknown cost and some fee unknown, every unknown day lacks only the fee; with any item line of unknown cost,
 * or no count that explains it (a copy kept before the counts), the day lacks the cost.
 */
export type MissingInput = "cost" | "fee";

/** The days of a period with an unknown result, and the month they are in when all of them are in one. */
export interface MissingDays {
  input: MissingInput;
  /** "novembro" when the days counted are those of one month of a period by month; null for the days of the period. */
  month: string | null;
  total: number;
  unknown: number;
}

export type MissingQuality = Pick<
  StoredQuality,
  | "anticipationFeesUnknown"
  | "itemLinesWithUnknownCost"
  | "processingFeesUnknown"
>;

export function missingInputOf(quality: MissingQuality): MissingInput {
  const feesUnknown =
    quality.processingFeesUnknown + quality.anticipationFeesUnknown > 0;
  return quality.itemLinesWithUnknownCost === 0 && feesUnknown ? "fee" : "cost";
}

const WORDS = {
  cost: { informed: "sem custo informado", short: "sem custo" },
  fee: { informed: "sem taxa informada", short: "sem taxa" },
} as const;

/** "sem custo informado" or "sem taxa informada": what the table, the tooltip and the hatch call an unknown day. */
export function missingInformed(input: MissingInput): string {
  return WORDS[input].informed;
}

/** "sem custo" or "sem taxa": the same, for a line that is short. */
export function missingShort(input: MissingInput): string {
  return WORDS[input].short;
}

/**
 * "novembro: 3 de 25 dias sem custo informado", the month only when the days are those of one. `opensSentence` starts
 * the month with a capital ("Novembro: ..."), for a count that begins a sentence of its own.
 */
export function missingDaysText(
  { input, month, total, unknown }: MissingDays,
  words: "informed" | "short",
  opensSentence = false
): string {
  const tail =
    words === "informed" ? missingInformed(input) : missingShort(input);
  const named =
    month !== null && opensSentence
      ? `${month.charAt(0).toUpperCase()}${month.slice(1)}`
      : month;
  return `${named === null ? "" : `${named}: `}${unknown} de ${total} ${total === 1 ? "dia" : "dias"} ${tail}`;
}

/** "novembro" for a month of `thisYear`, "novembro de 2025" for one of another year, so it is never taken for this one. */
export function monthLabel(date: string, thisYear: string): string {
  const name = monthName(date);
  return date.startsWith(thisYear) ? name : `${name} de ${date.slice(0, 4)}`;
}

interface MonthEntry {
  date: string;
  days?: number | undefined;
  unknownDays?: number | undefined;
}

/**
 * The one month that holds every unknown day of a period by month, with its own count ("novembro", 1 of 7), or null
 * when there is none, or when two months have some, or when an entry is a day: then the count is of the whole period.
 * A month of another year than `thisYear` carries it ("novembro de 2025"), so that it is never taken for this one.
 */
export function singleUnknownMonth(
  entries: readonly MonthEntry[],
  thisYear: string
): Pick<MissingDays, "month" | "total" | "unknown"> | null {
  const withUnknown = entries.filter((entry) => (entry.unknownDays ?? 0) > 0);
  const [only] = withUnknown;
  if (
    withUnknown.length !== 1 ||
    only === undefined ||
    only.days === undefined ||
    only.unknownDays === undefined
  ) {
    return null;
  }
  return {
    month: monthLabel(only.date, thisYear),
    total: only.days,
    unknown: only.unknownDays,
  };
}
