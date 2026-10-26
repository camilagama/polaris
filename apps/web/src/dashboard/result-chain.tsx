import { MoneyText } from "@/ui/hidden-values";
import { cn } from "@/lib/utils";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/table";
import type { StoredPeriodSummary } from "../lib/period-summary-cache";
import { type ChainRow, chainRows } from "./dashboard-model";
import { PartsBar } from "./parts-bar";

const CHAIN_TITLE_ID = "dashboard-chain-title";

/**
 * The chain as a receipt (revisão de UI v7, § 8): no lines between the rows, a dotted leader from the name to the
 * value, a subtotal ("=") in a heavier weight, and the result after the perforation of the receipt (a dashed line
 * across the card), larger. The leader and the perforation are drawing: the row is still a header cell and its value.
 */
function rowClass(row: ChainRow): string {
  const base = "border-b-0 hover:bg-transparent";
  if (row.kind === "result") {
    return cn(
      base,
      "border-t-2 border-t-input border-dashed font-semibold text-base"
    );
  }
  return row.kind === "subtotal" ? cn(base, "font-semibold") : base;
}

/** The dotted line from the end of the name to the value: it fills what is left of the cell and says nothing. */
const LEADER =
  "min-w-4 flex-1 translate-y-[-0.3em] border-input border-b border-dotted";

/** "Como chegamos a este resultado": from gross sales to the estimated result, line by line. */
export function ResultChain({ summary }: { summary: StoredPeriodSummary }) {
  const rows = chainRows(summary.chain, summary.quality);
  return (
    <Card aria-labelledby={CHAIN_TITLE_ID} className="gap-0 py-0" role="region">
      <CardHeader className="border-b py-(--card-spacing)">
        <CardTitle aria-level={2} id={CHAIN_TITLE_ID} role="heading">
          Como chegamos a este resultado
        </CardTitle>
        <CardDescription>
          Das vendas brutas ao resultado estimado, linha a linha.
        </CardDescription>
      </CardHeader>
      <Table>
        <caption className="sr-only">
          Das vendas brutas ao resultado operacional estimado
        </caption>
        {/* the names of the columns are for the screen reader: the receipt shows only names and values */}
        <TableHeader className="sr-only">
          <TableRow>
            <TableHead scope="col">Etapa</TableHead>
            <TableHead className="text-right" scope="col">
              Valor
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow className={rowClass(row)} key={row.id}>
              <TableHead
                className={cn(
                  "h-auto w-full whitespace-normal pr-0 align-top font-[weight:inherit] text-[length:inherit] text-foreground",
                  row.kind === "result" ? "pt-4 pb-2.5" : "py-2"
                )}
                scope="row"
              >
                <span className="flex items-baseline gap-2">
                  <span>{row.label}</span>
                  <span aria-hidden="true" className={LEADER} />
                </span>
                {row.note ? (
                  <span className="mt-0.5 block font-normal text-warning text-xs italic">
                    <MoneyText text={row.note} />
                  </span>
                ) : null}
              </TableHead>
              <TableCell
                className={cn(
                  "pl-2 text-right align-top tabular-nums",
                  row.kind === "result" ? "pt-4 pb-2.5" : "py-2",
                  row.negative && row.kind !== "line" && "text-destructive"
                )}
              >
                <MoneyText text={row.value} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <CardContent className="grid gap-4 border-t py-(--card-spacing)">
        <PartsBar chain={summary.chain} quality={summary.quality} />
        <p className="text-muted-foreground text-support">
          Despesas do período são as que não estão ligadas a uma venda, contadas
          pelo mês de competência. O resultado é uma estimativa operacional, não
          lucro líquido nem caixa liquidado.
        </p>
      </CardContent>
    </Card>
  );
}
