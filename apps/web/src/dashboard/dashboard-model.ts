import type { PeriodSummaryReadModel } from "@polaris/contracts";
import { type ClockParts, clockPartsInTimezone } from "../lib/dates";
import { formatBrlAmount, formatQuantity } from "../lib/format";
import { cogsCoverageOf, type StoredQuality } from "../lib/period-summary-cache";

/**
 * Pure helpers of the period result screen: text for the figures the server
 * computed, how complete the estimate is and the chain from gross sales to the
 * estimated result. Money stays exact decimal text; nothing is recomputed here.
 */

/** The quality as the screen reads it: a copy kept on the device may have no `cogsCoverage` (`cogsCoverageOf`). */
export type PeriodQuality = StoredQuality;
export type PeriodChain = PeriodSummaryReadModel["chain"];

/** Shown where a figure does not exist (a margin without sales, say). */
export const EMPTY_VALUE = "—";

const percentTextPattern = /^(-?)(\d+)(?:\.(\d+))?$/;

/** An exact BRL text ("-12.30") as "-R$ 12,30", or the dash for no value. */
export function formatMoneyOrDash(value: string | null): string {
  return value === null ? EMPTY_VALUE : formatBrlAmount(value);
}

/** A percent text with two places ("72.50") as "72,50%", or the dash for no value. */
export function formatPercentOrDash(value: string | null): string {
  if (value === null) {
    return EMPTY_VALUE;
  }
  const match = percentTextPattern.exec(value.trim());
  if (!match) {
    return value;
  }
  const sign = match[1] ?? "";
  const whole = formatQuantity(Number(match[2] ?? "0"));
  const fraction = (match[3] ?? "").padEnd(2, "0");
  return `${sign}${whole},${fraction}%`;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** The server's read time (`generatedAt`) as dd/mm/aaaa and HH:mm in the organization's zone. */
function readClock(generatedAt: string, timezone: string | null): ClockParts {
  const instant = new Date(generatedAt);
  return Number.isNaN(instant.getTime())
    ? { date: EMPTY_VALUE, time: EMPTY_VALUE }
    : clockPartsInTimezone(instant, timezone);
}

/** "Atualizado até 14/10/2026 12:30": when the server read the figures on screen. */
export function formatUpdatedUntil(
  generatedAt: string,
  timezone: string | null
): string {
  const { date, time } = readClock(generatedAt, timezone);
  return `Atualizado até ${date} ${time}`;
}

/** "Último resultado confirmado: 14/10/2026 12:30": the line beside the month when the figures are the device's copy. */
export function formatLastConfirmed(
  generatedAt: string,
  timezone: string | null
): string {
  const { date, time } = readClock(generatedAt, timezone);
  return `Último resultado confirmado: ${date} ${time}`;
}

/**
 * What the screen says, under the title "Não foi possível falar com o servidor." (the server may be out, not only the network), when the figures come from the device's copy
 * of the last confirmed result.
 */
export function offlineCopyNotice(
  generatedAt: string,
  timezone: string | null,
  waitingOperations: number
): { pending: string | null; summary: string } {
  const { date, time } = readClock(generatedAt, timezone);
  return {
    pending:
      waitingOperations > 0
        ? `Há ${waitingOperations} ${plural(waitingOperations, "operação guardada", "operações guardadas")} neste aparelho que ainda não ${plural(waitingOperations, "entra", "entram")} no resultado.`
        : null,
    summary: `Mostrando o último resultado confirmado, de ${date} às ${time}. Vendas e despesas feitas depois, ou ainda não enviadas deste aparelho, não estão nestes números.`,
  };
}

/** The sale is in the totals (its revenue counts); only its unknown fee is left out of the calculation. */
function feeLeftOut(count: number): string {
  return count === 1
    ? "a venda entra nos totais, mas a taxa dela ficou fora do cálculo."
    : "as vendas entram nos totais, mas as taxas delas ficaram fora do cálculo.";
}

function missingMessage(
  code: PeriodQuality["missing"][number],
  quality: PeriodQuality
): string {
  switch (code) {
    case "no_sales":
      return "Sem vendas neste período.";
    case "unknown_cost": {
      const count = quality.itemLinesWithUnknownCost;
      return `${count} ${plural(count, "linha de item vendido sem custo conhecido", "linhas de itens vendidos sem custo conhecido")}: o custo ${plural(count, "dela", "delas")} não entrou no CMV.`;
    }
    case "unknown_processing_fee": {
      const count = quality.processingFeesUnknown;
      return `${count} ${plural(count, "venda sem taxa de processamento conhecida", "vendas sem taxa de processamento conhecida")}: ${feeLeftOut(count)}`;
    }
    case "unknown_anticipation_fee": {
      const count = quality.anticipationFeesUnknown;
      return `${count} ${plural(count, "venda com antecipação sem taxa conhecida", "vendas com antecipação sem taxa conhecida")}: ${feeLeftOut(count)}`;
    }
    default:
      return "Nenhuma despesa registrada neste período: o resultado pode estar acima do real.";
  }
}

/** One plain sentence for each input the server reports as missing, in the server's order. */
export function qualityMessages(quality: PeriodQuality): string[] {
  return quality.missing.map((code) => missingMessage(code, quality));
}

type QualityTone = "complete" | "partial";

export interface QualityView {
  messages: string[];
  title: string;
  tone: QualityTone;
}

/**
 * What the quality banner says: complete is quiet, partial warns. A period with no data never gets here: the
 * screen says it with its own empty state (`dashboard-page.tsx`).
 */
export function qualityView(quality: PeriodQuality): QualityView {
  if (quality.level === "partial") {
    return {
      messages: qualityMessages(quality),
      title: "Estimativa incompleta",
      tone: "partial",
    };
  }
  return {
    messages:
      quality.salesCount === 0
        ? ["Sem vendas neste período: só as despesas entraram no resultado."]
        : [],
    title: "Dados completos para este período",
    tone: "complete",
  };
}

/** True when the result must not be read with more certainty than the data allows. */
export function isIncompleteEstimate(quality: PeriodQuality): boolean {
  return quality.level === "partial";
}

type ChainRowKind = "line" | "result" | "subtotal";

export interface ChainRow {
  id: keyof PeriodChain;
  kind: ChainRowKind;
  label: string;
  /** True for a negative exact amount, so a loss reads as one without relying on color. */
  negative: boolean;
  /** What was left out of this line because it was unknown, when anything was. */
  note: string | null;
  value: string;
}

/** What the subtotals from the CMV on say when no cost of the period is known: the dash, and why. */
export const NO_KNOWN_COST_NOTE = "Sem custo conhecido no período.";

/** The subtotals that follow from the cost of goods: with no cost known they are the sales, not an estimate. */
const COST_SUBTOTALS: ReadonlySet<keyof PeriodChain> = new Set([
  "grossProfit",
  "contributionMargin",
  "estimatedOperatingResult",
]);

interface ChainLine {
  id: keyof PeriodChain;
  kind: ChainRowKind;
  label: string;
}

/** The chain in the order it is read: each "=" row follows from the rows above it. */
const CHAIN_LINES: readonly ChainLine[] = [
  { id: "grossSales", kind: "line", label: "Vendas brutas" },
  { id: "discounts", kind: "line", label: "(−) Descontos" },
  { id: "returns", kind: "line", label: "(−) Devoluções" },
  { id: "netSales", kind: "subtotal", label: "(=) Vendas líquidas" },
  {
    id: "cogs",
    kind: "line",
    label: "(−) Custo das mercadorias vendidas (CMV)",
  },
  { id: "grossProfit", kind: "subtotal", label: "(=) Lucro bruto" },
  { id: "commercialSurcharges", kind: "line", label: "(+) Acréscimos e frete" },
  {
    id: "processingFees",
    kind: "line",
    label: "(−) Taxas de processamento",
  },
  {
    id: "anticipationFees",
    kind: "line",
    label: "(−) Taxas de antecipação",
  },
  {
    id: "linkedExpenses",
    kind: "line",
    label: "(−) Despesas ligadas à venda",
  },
  {
    id: "contributionMargin",
    kind: "subtotal",
    label: "(=) Margem de contribuição",
  },
  {
    id: "operatingExpenses",
    kind: "line",
    label: "(−) Despesas do período (sem venda)",
  },
  {
    id: "estimatedOperatingResult",
    kind: "result",
    label: "(=) Resultado operacional estimado",
  },
];

function lineNote(
  id: keyof PeriodChain,
  quality: PeriodQuality
): string | null {
  if (id === "cogs" && quality.itemLinesWithUnknownCost > 0) {
    const count = quality.itemLinesWithUnknownCost;
    return `Não inclui ${count} ${plural(count, "item sem custo conhecido", "itens sem custo conhecido")}.`;
  }
  if (id === "processingFees" && quality.processingFeesUnknown > 0) {
    const count = quality.processingFeesUnknown;
    return `Não inclui ${count} ${plural(count, "venda sem taxa conhecida", "vendas sem taxa conhecida")}.`;
  }
  if (id === "anticipationFees" && quality.anticipationFeesUnknown > 0) {
    const count = quality.anticipationFeesUnknown;
    return `Não inclui ${count} ${plural(count, "venda sem taxa conhecida", "vendas sem taxa conhecida")}.`;
  }
  if (id === "operatingExpenses" && quality.operatingExpenses === 0) {
    return "Nenhuma despesa registrada.";
  }
  return null;
}

/**
 * The rows of "Como chegamos a este resultado", with the unknowns that were left out marked on their line. With no cost
 * of the goods known in the period (`cogsCoverageOf` is "none") the subtotals from the CMV on are a dash with their
 * note: the server's figures there are the sales, and a partial cost stays as it is.
 */
export function chainRows(
  chain: PeriodChain,
  quality: PeriodQuality
): ChainRow[] {
  const noKnownCost = cogsCoverageOf(quality) === "none";
  return CHAIN_LINES.map((line) => {
    const amount = chain[line.id];
    if (noKnownCost && COST_SUBTOTALS.has(line.id)) {
      return {
        id: line.id,
        kind: line.kind,
        label: line.label,
        negative: false,
        note: NO_KNOWN_COST_NOTE,
        value: EMPTY_VALUE,
      };
    }
    return {
      id: line.id,
      kind: line.kind,
      label: line.label,
      negative: amount.trim().startsWith("-"),
      note: lineNote(line.id, quality),
      value: formatBrlAmount(amount),
    };
  });
}
