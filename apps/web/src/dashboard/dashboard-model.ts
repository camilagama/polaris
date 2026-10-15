import type { PeriodSummaryReadModel } from "@polaris/contracts";
import { formatBrlAmount, formatQuantity } from "../lib/format";

/**
 * Pure helpers of the period result screen: text for the figures the server
 * computed, how complete the estimate is and the chain from gross sales to the
 * estimated result. Money stays exact decimal text; nothing is recomputed here.
 */

export type PeriodQuality = PeriodSummaryReadModel["quality"];
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

/** "Atualizado às 14:32": the time of the last successful load, in the given or the device's zone. */
export function formatUpdatedAt(instant: Date, timeZone?: string): string {
  const time = new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(instant);
  return `Atualizado às ${time}`;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
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
      return `${count} ${plural(count, "item vendido sem custo conhecido", "itens vendidos sem custo conhecido")}: o custo ${plural(count, "dele", "deles")} não entrou no CMV.`;
    }
    case "unknown_processing_fee": {
      const count = quality.processingFeesUnknown;
      return `${count} ${plural(count, "venda sem taxa de processamento conhecida", "vendas sem taxa de processamento conhecida")}: ${plural(count, "ela", "elas")} não ${plural(count, "entrou", "entraram")} no resultado.`;
    }
    case "unknown_anticipation_fee": {
      const count = quality.anticipationFeesUnknown;
      return `${count} ${plural(count, "venda com antecipação sem taxa conhecida", "vendas com antecipação sem taxa conhecida")}: ${plural(count, "ela", "elas")} não ${plural(count, "entrou", "entraram")} no resultado.`;
    }
    default:
      return "Nenhuma despesa registrada neste período: o resultado pode estar acima do real.";
  }
}

/** One plain sentence for each input the server reports as missing, in the server's order. */
export function qualityMessages(quality: PeriodQuality): string[] {
  return quality.missing.map((code) => missingMessage(code, quality));
}

type QualityTone = "complete" | "empty" | "partial";

export interface QualityView {
  messages: string[];
  title: string;
  tone: QualityTone;
}

/** What the quality banner says: complete is quiet, partial warns, no data is an empty state. */
export function qualityView(quality: PeriodQuality): QualityView {
  if (quality.level === "no_data") {
    return {
      messages: qualityMessages(quality),
      title: "Sem dados neste período",
      tone: "empty",
    };
  }
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
  /** What was left out of this line because it was unknown, when anything was. */
  note: string | null;
  /** True for a negative exact amount, so a loss reads as one without relying on color. */
  negative: boolean;
  value: string;
}

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
    label: "(−) Taxas de processamento do cartão",
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

/** The rows of "Como chegamos a este resultado", with the unknowns that were left out marked on their line. */
export function chainRows(
  chain: PeriodChain,
  quality: PeriodQuality
): ChainRow[] {
  return CHAIN_LINES.map((line) => {
    const amount = chain[line.id];
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
