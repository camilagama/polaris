import type { RangeOnly } from "@/ui/date-range-picker";
import {
  monthName,
  type Period,
  type PeriodPreset,
  presetPeriod,
  wholeMonthOf,
} from "../dashboard/result-period";

/**
 * The period the Início looks at (the cards of the month, Vendas por dia and Mais vendidos). "Este mês" is the page's
 * own read, with its copy; any other choice is one more read of `periodSummary`, made only once it is chosen. Hoje, the
 * goal and the map are always "now" and never read this.
 */
export interface HomeSelection {
  /** The range of "Período", once the person gave a valid one. */
  custom: Period | null;
  preset: PeriodPreset;
}

export const THIS_MONTH: HomeSelection = { custom: null, preset: "this-month" };

export function isThisMonth(selection: HomeSelection): boolean {
  return selection.preset === "this-month";
}

/** What the selection reads on the store's `today`; "Este mês" when a "Período" has no valid range. */
export function selectionPeriod(
  selection: HomeSelection,
  today: string
): Period {
  return (
    presetPeriod(selection.preset, today, selection.custom) ??
    (presetPeriod("this-month", today, null) as Period)
  );
}

/**
 * Without a connection only the two months the device may keep a copy of can be chosen (the Resultado's rule, AC-16):
 * the others stay in the list, off, with the reason.
 */
export const OFFLINE_ONLY: RangeOnly = {
  reason: "Sem conexão: só este mês e o anterior.",
  shortcuts: ["este-mes", "mes-passado"],
};

/** The title of Mais vendidos: "do mês" for this month, "de outubro" for another whole month, "do período" otherwise. */
export function topProductsTitle(
  selection: HomeSelection,
  period: Period
): string {
  if (isThisMonth(selection)) {
    return "Mais vendidos do mês";
  }
  const month = wholeMonthOf(period);
  return month
    ? `Mais vendidos de ${monthName(month)}`
    : "Mais vendidos do período";
}
