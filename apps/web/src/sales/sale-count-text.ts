import { formatQuantity } from "../lib/format";

export interface SaleCount {
  /** Lines of the sale: different products or variants, one per row. */
  lines: number;
  /** Sum of the quantities of those lines. */
  units: number;
}

function plural(count: number, one: string, many: string): string {
  return `${formatQuantity(count)} ${count === 1 ? one : many}`;
}

/** "3 linhas · 8 unidades" ("1 linha · 1 unidade"): the two counts a sale has, never lines alone. */
export function saleCountText({ lines, units }: SaleCount): string {
  return `${plural(lines, "linha", "linhas")} · ${plural(units, "unidade", "unidades")}`;
}

/** The same counts as a reader says them: a comma, because the middle dot is read as a symbol or skipped. */
export function saleCountSpoken({ lines, units }: SaleCount): string {
  return `${plural(lines, "linha", "linhas")}, ${plural(units, "unidade", "unidades")}`;
}

/** The sentence said before "Limpar venda" takes the lines out. */
export function clearSaleConsequenceText(count: SaleCount): string {
  return `Isso tira da venda ${plural(count.lines, "linha", "linhas")} e ${plural(count.units, "unidade", "unidades")}.`;
}
