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

/** A subtotal ("=") sits on a tinted band; the result closes the table under a 2 px line. */
function rowClass(row: ChainRow): string | undefined {
  if (row.kind === "result") {
    return "border-t-2 border-t-foreground/20 bg-muted/40 font-semibold";
  }
  return row.kind === "subtotal" ? "bg-muted/40 font-medium" : undefined;
}

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
        <TableHeader>
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
                className="h-auto whitespace-normal py-2.5 align-top font-[weight:inherit] text-foreground text-sm"
                scope="row"
              >
                {row.label}
                {row.note ? (
                  <span className="mt-0.5 block font-normal text-warning text-xs italic">
                    {row.note}
                  </span>
                ) : null}
              </TableHead>
              <TableCell
                className={cn(
                  "text-right align-top tabular-nums",
                  row.negative && row.kind !== "line" && "text-destructive"
                )}
              >
                {row.value}
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
