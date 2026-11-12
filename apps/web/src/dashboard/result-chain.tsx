import { Fragment } from "react";
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
import { type ChainRow, chainRows, EMPTY_VALUE } from "./dashboard-model";
import { PartsBar } from "./parts-bar";

const CHAIN_TITLE_ID = "dashboard-chain-title";

/**
 * The chain as a receipt (revisão de UI v7, § 8): no lines between the rows, a dotted leader from the name to the
 * value, a subtotal ("=") in a heavier weight, and the result after the perforation of the receipt (a dashed line
 * across the card), larger. The leader and the perforation are drawing: the row is still a header cell and its value.
 */
function rowClass(row: ChainRow): string {
  const base = cn("border-b-0 hover:bg-transparent", STACKED_ROW);
  if (row.kind === "result") {
    return cn(
      base,
      "border-t-2 border-t-input border-dashed font-semibold text-base"
    );
  }
  return row.kind === "subtotal" ? cn(base, "font-semibold") : base;
}

/**
 * The dotted line from the end of the name to the value: it fills what is left of the cell and says nothing. Its 1 rem
 * floor holds the line apart from the name, but in a window of 22 rem or less (320 px with the font at 14.6 px or more)
 * the floor plus the longest word of a name is wider than the card, so there the line may shrink to nothing; below
 * 18 rem of card it is hidden, with the name above the value. The limit is in rem because a media query follows the
 * browser font, what makes a window of 320 px with 17 px letters narrow in rem; in px it would not catch that case.
 */
const LEADER =
  "min-w-4 max-[22rem]:min-w-0 flex-1 translate-y-[-0.3em] border-input border-b border-dotted @max-[18rem]:hidden";

/**
 * The card measures its own box (`@container`): narrower than 18 rem (320 px with the font at 17 px or more, 360 px
 * with 19 px or more) the name of the line and its value no longer fit side by side, so each row stacks them, the name
 * above the value, and the value keeps the whole width of the card instead of rolling the table sideways. The dotted
 * line has nothing to lead to.
 */
const STACKED_TABLE = "@max-[18rem]:block @max-[18rem]:[&_tbody]:block";
const STACKED_ROW = "@max-[18rem]:grid";
const STACKED_VALUE =
  "@max-[18rem]:pt-0 @max-[18rem]:pl-4 @max-[18rem]:text-left";

/** On a line of its own, so the row is as wide as the others. */
const EXPENSES_LINK =
  "touch-hit focus-ring whitespace-nowrap rounded-sm font-normal text-muted-foreground text-xs underline decoration-input underline-offset-4 hover:text-foreground hover:decoration-foreground";

/** "Como chegamos a este resultado": from gross sales to the estimated result, line by line. */
export function ResultChain({
  canCreateExpense,
  summary,
}: {
  /** `expense:create`: the line of the period's expenses leads to the screen that registers them only for who can. */
  canCreateExpense: boolean;
  summary: StoredPeriodSummary;
}) {
  const rows = chainRows(summary.chain, summary.quality);
  return (
    <Card
      aria-labelledby={CHAIN_TITLE_ID}
      className="@container gap-0 py-0"
      role="region"
    >
      <CardHeader className="border-b py-(--card-spacing)">
        <CardTitle aria-level={2} id={CHAIN_TITLE_ID} role="heading">
          Como chegamos a este resultado
        </CardTitle>
        <CardDescription>
          Das vendas brutas ao resultado estimado, linha a linha.
        </CardDescription>
      </CardHeader>
      <Table className={STACKED_TABLE}>
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
            <Fragment key={row.id}>
              <TableRow className={rowClass(row)}>
                <TableHead
                  className={cn(
                    "h-auto w-full whitespace-normal pr-0 align-top font-[weight:inherit] text-[length:inherit] text-foreground",
                    row.kind === "result" ? "pt-4 pb-2.5" : "py-2",
                    "@max-[18rem]:pr-4 @max-[18rem]:pb-0"
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
                    STACKED_VALUE,
                    row.kind === "result" ? "pt-4 pb-2.5" : "py-2",
                    row.negative && row.kind !== "line" && "text-destructive"
                  )}
                >
                  {row.value === EMPTY_VALUE ? (
                    <>
                      <span aria-hidden="true">{EMPTY_VALUE}</span>
                      <span className="sr-only">sem valor</span>
                    </>
                  ) : (
                    <MoneyText text={row.value} />
                  )}
                </TableCell>
              </TableRow>
              {row.id === "operatingExpenses" && canCreateExpense ? (
                <TableRow className="border-b-0 hover:bg-transparent">
                  <TableCell
                    className="pt-0 pb-2 @max-[18rem]:pl-4"
                    colSpan={2}
                  >
                    <a className={EXPENSES_LINK} href="/expenses">
                      Ver despesas
                    </a>
                  </TableCell>
                </TableRow>
              ) : null}
            </Fragment>
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
