import { Money } from "../money/money";
import type { PeriodResult } from "./sale-economics";

/**
 * What the dashboard shows for a period (plan PR68 and PR69): the cards and an
 * honest account of how complete the result is. Pure and exact, like the
 * engine it reads from.
 */
export interface DashboardCards {
  /** Units sold, net of returns. */
  items: number;
  /** Contribution margin over net sales, in percent with two places; null when net sales are not positive. */
  marginPercent: string | null;
  netSales: string;
  /** Estimated operating result (never "net profit" or settled cash). */
  operatingResult: string;
  /** Confirmed, not cancelled sales. */
  salesCount: number;
  /** Net sales per sale, rounded half-up to the cent; null without sales. */
  ticket: string | null;
}

/** round-half-up(numerator / denominator), sending ties away from zero; denominator > 0. */
function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const rounded = (absolute * 2n + denominator) / (denominator * 2n);
  return negative ? -rounded : rounded;
}

function formatPercent(basisPoints: bigint): string {
  const negative = basisPoints < 0n;
  const absolute = negative ? -basisPoints : basisPoints;
  const whole = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, "0");
  return `${negative && absolute !== 0n ? "-" : ""}${whole}.${fraction}`;
}

export function dashboardCards(result: PeriodResult): DashboardCards {
  const net = Money.from(result.netSales).minorUnits;
  const margin = Money.from(result.contributionMargin).minorUnits;
  return {
    items: result.unitsSold,
    marginPercent:
      net > 0n ? formatPercent(divideHalfUp(margin * 10_000n, net)) : null,
    netSales: result.netSales,
    operatingResult: result.estimatedOperatingResult,
    salesCount: result.salesCount,
    ticket:
      result.salesCount > 0
        ? Money.fromMinorUnits(
            divideHalfUp(net, BigInt(result.salesCount))
          ).toString()
        : null,
  };
}

/** What is missing for the estimate to be trusted as it stands. */
export type MissingInput =
  | "no_expenses"
  | "no_sales"
  | "unknown_anticipation_fee"
  | "unknown_cost"
  | "unknown_processing_fee";

export type ResultQualityLevel = "complete" | "no_data" | "partial";

export interface ResultQuality {
  /** Sales whose anticipation fee was unknown (left out of the result). */
  anticipationFeesUnknown: number;
  /** Item lines of the period (the denominator of the cost coverage). */
  itemLines: number;
  /** Item lines whose cost was unknown (left out of the CMV). */
  itemLinesWithUnknownCost: number;
  level: ResultQualityLevel;
  /** Expenses with no sale recorded in the period. */
  operatingExpenses: number;
  /** Expenses linked to sales in the period. */
  linkedExpenses: number;
  missing: MissingInput[];
  processingFeesUnknown: number;
  salesCount: number;
}

/**
 * How complete the result is, to avoid false precision. An unknown cost or fee
 * is left out of the amounts (never counted as zero), so the result is
 * "partial" whenever any was left out; a period with sales and no expense
 * recorded at all is "partial" too, because the result would otherwise read as
 * if the business had no costs besides the goods. A period with nothing at all
 * is "no_data".
 */
export function resultQuality(result: PeriodResult): ResultQuality {
  const missing: MissingInput[] = [];
  if (result.salesCount === 0 && result.operatingExpenseCount === 0) {
    missing.push("no_sales");
  }
  if (result.unknown.costItems > 0) {
    missing.push("unknown_cost");
  }
  if (result.unknown.processingFees > 0) {
    missing.push("unknown_processing_fee");
  }
  if (result.unknown.anticipationFees > 0) {
    missing.push("unknown_anticipation_fee");
  }
  if (result.salesCount > 0 && result.operatingExpenseCount === 0) {
    missing.push("no_expenses");
  }
  let level: ResultQualityLevel = "partial";
  if (missing.length === 0) {
    level = "complete";
  } else if (missing[0] === "no_sales") {
    level = "no_data";
  }
  return {
    anticipationFeesUnknown: result.unknown.anticipationFees,
    itemLines: result.itemLines,
    itemLinesWithUnknownCost: result.unknown.costItems,
    level,
    linkedExpenses: result.linkedExpenseCount,
    missing,
    operatingExpenses: result.operatingExpenseCount,
    processingFeesUnknown: result.unknown.processingFees,
    salesCount: result.salesCount,
  };
}
