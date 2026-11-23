import ArrowRightIcon from "lucide-react/dist/esm/icons/arrow-right";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { BlockHeader } from "@/ui/block-header";
import { buttonVariants } from "@/ui/button";
import { Card, CardContent, CardHeader } from "@/ui/card";
import { Figure } from "@/ui/figure";
import { MoneyText } from "@/ui/hidden-values";
import { Skeleton } from "@/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/table";
import type { StoredPeriodSummary } from "../lib/period-summary-cache";
import {
  CHAIN_LINES,
  type ChainRow,
  chainRows,
  EMPTY_VALUE,
} from "./dashboard-model";
import { PartsBar, PartsBarSkeleton } from "./parts-bar";

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
 * 19 rem of card it is hidden, with the name above the value. The limit is in rem because a media query follows the
 * browser font, what makes a window of 320 px with 17 px letters narrow in rem; in px it would not catch that case.
 */
const LEADER =
  "min-w-4 max-[22rem]:min-w-0 flex-1 translate-y-[-0.3em] border-input border-b border-dotted @max-[19rem]:hidden";

/**
 * The card measures its own box (`@container`): narrower than 19 rem (320 px at the default font of 16 px, 360 px
 * with 18 px or more; the value is in Geist Mono, wider than the Geist of the name) the name of the line and its value
 * no longer fit side by side, so each row stacks them, the name
 * above the value, and the value keeps the whole width of the card instead of rolling the table sideways. The dotted
 * line has nothing to lead to.
 */
const STACKED_TABLE = "@max-[19rem]:block @max-[19rem]:[&_tbody]:block";
const STACKED_ROW = "@max-[19rem]:grid";
const STACKED_VALUE = "@max-[19rem]:pt-0 @max-[19rem]:pl-4";

/**
 * Side by side, the value is at least as wide as "R$ 9.999,99" in the Geist Mono of a line (11 characters of 0.6 em at
 * `text-sm`, 0.875 rem: 5.775 rem, in rem so the larger result line has the same floor): the name, which takes the rest of
 * the row (`w-full`), then has the same width in every period whose values fit there, so a name does not wrap in one
 * period and not in the other and the card keeps its height. A wider value widens the column, as before. The floor is on
 * the value and not on the cell because the name's `w-full` shrinks the cell to its content.
 */
const VALUE_FLOOR = "inline-block min-w-[5.775rem] @max-[19rem]:min-w-0";

const EXPENSES_LINK = buttonVariants({ size: "sm", variant: "ghost" });

const SKELETON_ROWS: readonly ChainRow[] = CHAIN_LINES.map((line) => ({
  id: line.id,
  kind: line.kind,
  label: line.label,
  negative: false,
  note: null,
  value: EMPTY_VALUE,
}));

/** "Como chegamos a este resultado": from gross sales to the estimated result, line by line. */
export function ResultChain({
  canCreateExpense,
  summary,
}: {
  /** `expense:create`: the line of the period's expenses leads to the screen that registers them only for who can. */
  canCreateExpense: boolean;
  summary: StoredPeriodSummary;
}) {
  return (
    <ChainCard
      canCreateExpense={canCreateExpense}
      parts={<PartsBar chain={summary.chain} quality={summary.quality} />}
      rows={chainRows(summary.chain, summary.quality)}
    />
  );
}

/** The card while the figures are read: the same rows and the same footer, with the figures in `Skeleton`, so nothing moves when they come. */
export function ResultChainSkeleton({
  canCreateExpense,
}: {
  canCreateExpense: boolean;
}) {
  return (
    <ChainCard
      canCreateExpense={canCreateExpense}
      loading
      parts={<PartsBarSkeleton />}
      rows={SKELETON_ROWS}
    />
  );
}

function ChainValue({ loading, value }: { loading: boolean; value: string }) {
  if (loading) {
    return (
      <span className="flex h-5 items-center">
        <Skeleton aria-hidden="true" className="h-4 w-full" />
      </span>
    );
  }
  if (value === EMPTY_VALUE) {
    return (
      <>
        <span aria-hidden="true">{EMPTY_VALUE}</span>
        <span className="sr-only">sem valor</span>
      </>
    );
  }
  return <MoneyText text={value} />;
}

function ChainCard({
  canCreateExpense = false,
  loading = false,
  parts,
  rows,
}: {
  canCreateExpense?: boolean;
  loading?: boolean;
  parts: ReactNode;
  rows: readonly ChainRow[];
}) {
  return (
    <Card
      aria-hidden={loading ? "true" : undefined}
      aria-labelledby={CHAIN_TITLE_ID}
      className="@container gap-0 py-0"
      role="region"
    >
      <CardHeader className="border-b py-(--card-spacing)">
        <BlockHeader
          {...(canCreateExpense
            ? {
                action: loading ? (
                  <Skeleton className="h-8 w-32 rounded-md" />
                ) : (
                  <a className={EXPENSES_LINK} href="/expenses">
                    Ver despesas
                    <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
                  </a>
                ),
              }
            : {})}
          {...(loading
            ? {}
            : {
                help: {
                  about: "Como chegamos a este resultado: o que é",
                  text: "Das vendas brutas ao resultado estimado, linha a linha.",
                },
              })}
          id={CHAIN_TITLE_ID}
          title="Como chegamos a este resultado"
        />
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
            <TableRow className={rowClass(row)} key={row.id}>
              <TableHead
                className={cn(
                  "h-auto w-full whitespace-normal pr-0 align-top font-[weight:inherit] text-[length:inherit] text-foreground",
                  row.kind === "result" ? "pt-4 pb-2.5" : "py-3",
                  "@max-[19rem]:pr-4 @max-[19rem]:pb-0"
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
                  "pl-2 text-right align-top",
                  STACKED_VALUE,
                  row.kind === "result" ? "pt-4 pb-2.5" : "py-3",
                  row.negative && row.kind !== "line" && "text-destructive"
                )}
              >
                <Figure className={cn(VALUE_FLOOR, loading && "align-top")}>
                  <ChainValue loading={loading} value={row.value} />
                </Figure>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <CardContent className="grid gap-4 border-t py-(--card-spacing)">
        {parts}
        <p className="text-muted-foreground text-support">
          Despesas do período são as que não estão ligadas a uma venda, contadas
          pelo mês de competência. O resultado é uma estimativa operacional, não
          lucro líquido nem caixa liquidado.
        </p>
      </CardContent>
    </Card>
  );
}
