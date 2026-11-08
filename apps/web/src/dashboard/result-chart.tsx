import { MoneyText } from "@/ui/hidden-values";
import {
  MASKED_MONEY,
  MASKED_SPOKEN,
  maskMoney,
  useHiddenValues,
} from "../lib/hidden-values";
import ChevronDownIcon from "lucide-react/dist/esm/icons/chevron-down";
import { useCallback, useMemo } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/ui/card";
import { OnDemandAreaChart } from "@/ui/charts/on-demand";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@/ui/collapsible";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/table";
import { useConnectionOnline } from "../lib/browser-connection";
import { calendarDayInTimezone } from "../lib/dates";
import { formatBrlAmount } from "../lib/format";
import type { StoredPeriodSummary } from "../lib/period-summary-cache";
import { isIncompleteEstimate } from "./dashboard-model";
import { IncompleteBadge } from "./result-cards";
import { periodText } from "./result-period";
import {
  axisMoney,
  bestRowText,
  chartNumber,
  costParts,
  costSeries,
  costsKnown,
  costText,
  hasAnyValue,
  moneyText,
  NO_COST_TEXT,
  type ResultRow,
  type ResultSeries,
  readingNote,
  resultSeries,
  supportText,
  unknownDaysCount,
} from "./result-series";

const TITLE_ID = "dashboard-chart-title";
const EMPTY_CELL = "—";

/** Loading the page again is how the chart asks for its chunk once more: the form is not kept on the address. */
function reloadPage() {
  window.location.reload();
}

/** The text of the Resultado when the chart does not open: the totals sit above the chart and the table below it. */
export function ChartFailed() {
  const online = useConnectionOnline();
  return online ? (
    <div className="grid justify-items-start gap-2">
      <p className="text-muted-foreground text-support">O gráfico não abriu.</p>
      <Button onClick={reloadPage} size="sm" type="button" variant="outline">
        Tentar novamente
      </Button>
    </div>
  ) : (
    <p className="text-muted-foreground text-support">
      O gráfico abre quando a internet voltar. Os totais estão acima e a tabela,
      abaixo.
    </p>
  );
}

function isNegative(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().startsWith("-");
}

/* The table measures its own box (`@container`), like the one of the return of a sale: narrower than 48rem (a phone, or
   a tablet with the sidebar open) each day is a card, with the date as its title and the name of each column
   (`data-label`) beside its value; the head row is only for the screen reader. Nothing scrolls sideways, and "Depois de
   hoje" stays in view under the cards. */
const CARD_ROW =
  "@max-3xl:grid @max-3xl:gap-1 @max-3xl:border-b @max-3xl:py-3 @max-3xl:hover:bg-transparent";
const CARD_CELL =
  "text-right tabular-nums @max-3xl:grid @max-3xl:grid-cols-[minmax(7rem,45%)_minmax(0,1fr)] @max-3xl:items-center @max-3xl:gap-2 @max-3xl:whitespace-normal @max-3xl:px-0! @max-3xl:py-0.5 @max-3xl:text-left @max-3xl:before:text-muted-foreground @max-3xl:before:text-support @max-3xl:before:content-[attr(data-label)]";
const CARD_TITLE =
  "h-auto whitespace-normal py-2.5 text-left align-middle font-medium text-foreground text-sm @max-3xl:px-0 @max-3xl:py-0";

interface NumbersTableProps {
  hasCosts: boolean;
  series: ResultSeries;
}

/** "Ver os números": the day by day (or month by month) table, which is the proof that the drawing hides nothing. */
export function NumbersTable({ hasCosts, series }: NumbersTableProps) {
  const columns = hasCosts ? 5 : 2;
  const unit = series.grouped ? "mês" : "dia";
  return (
    <div className="@container">
      <Table className="@max-3xl:block @max-3xl:[&_tbody]:block @max-3xl:[&_tfoot]:block">
        <TableCaption className="sr-only">
          {`Vendas e custos de cada ${unit} do período`}
        </TableCaption>
        <TableHeader className="@max-3xl:sr-only">
          <TableRow className="hover:bg-transparent">
            <TableHead scope="col">{series.grouped ? "Mês" : "Dia"}</TableHead>
            <TableHead className="text-right" scope="col">
              Vendas líquidas
            </TableHead>
            {hasCosts ? (
              <>
                <TableHead className="text-right" scope="col">
                  Custos
                </TableHead>
                <TableHead className="text-right" scope="col">
                  {`Resultado do ${unit}`}
                </TableHead>
                <TableHead className="text-right" scope="col">
                  Despesas do período
                </TableHead>
              </>
            ) : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {series.rows.map((row: ResultRow) => (
            <TableRow className={CARD_ROW} key={row.key}>
              <TableHead className={CARD_TITLE} scope="row">
                {row.tableLabel}
              </TableHead>
              <TableCell className={CARD_CELL} data-label="Vendas líquidas">
                <MoneyText text={formatBrlAmount(row.netSales)} />
              </TableCell>
              {hasCosts ? (
                <>
                  <TableCell className={CARD_CELL} data-label="Custos">
                    <MoneyText text={costText(row.costs)} />
                  </TableCell>
                  <TableCell
                    className={cn(
                      CARD_CELL,
                      isNegative(row.operatingResult) && "text-destructive"
                    )}
                    data-label={`Resultado do ${unit}`}
                  >
                    <MoneyText text={costText(row.operatingResult)} />
                  </TableCell>
                  <TableCell
                    className={CARD_CELL}
                    data-label="Despesas do período"
                  >
                    {row.expenses ? (
                      <MoneyText text={formatBrlAmount(row.expenses)} />
                    ) : (
                      EMPTY_CELL
                    )}
                  </TableCell>
                </>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
        {series.afterToday ? (
          <TableFooter className="@max-3xl:block">
            <TableRow className="@max-3xl:block">
              <TableCell
                className="@max-3xl:block @max-3xl:whitespace-normal @max-3xl:px-0 @max-3xl:py-3 @max-3xl:text-left text-right tabular-nums"
                colSpan={columns}
              >
                <MoneyText
                  text={`Depois de hoje: despesas ${formatBrlAmount(series.afterToday)}`}
                />
              </TableCell>
            </TableRow>
          </TableFooter>
        ) : null}
      </Table>
    </div>
  );
}

/** What the block says in place of the cost line when the costs of the days were not sent at all: no zero is made up. */
function costsNote(fromCopy: boolean): string {
  return fromCopy
    ? "Esta cópia guardada não tem os custos por dia."
    : "Os custos por dia não estão disponíveis agora.";
}

/**
 * The room the lines of the card keep so the box does not change height between periods: `min-h` in lines of text
 * (1.125rem), never `max-h` nor a clamp, so nothing is cut. Each line count is that of the longest form the line takes
 * at that width (measured at 320, 340, 360, 375, 390, 412, 430, 480, 540, 600, 680, 767, 820, 1000, 1280 and 1440 px,
 * with "366 de 366 dias sem custo informado", amounts of R$ 123.456,78 and the values hidden), and a step is placed at
 * the first width that reads fewer lines. The reading and the legend wrap in lines, so they also take `content-start`:
 * the room goes below the text, not between its fragments.
 */
const TITLE_RESERVE = "min-h-[2.875rem] min-[24.375rem]:min-h-[1.375rem]";
const DESCRIPTION_RESERVE =
  "min-h-[calc(6*1.125rem)] min-[22.5rem]:min-h-[calc(5*1.125rem)] min-[25.75rem]:min-h-[calc(4*1.125rem)] min-[33.75rem]:min-h-[calc(3*1.125rem)] min-[47.9375rem]:min-h-[calc(2*1.125rem)]";
const READING_RESERVE =
  "content-start min-h-[calc(5*1.125rem)] min-[21.25rem]:min-h-[calc(4*1.125rem)] min-[30rem]:min-h-[calc(3*1.125rem)] min-[37.5rem]:min-h-[calc(2*1.125rem)]";
const LEGEND_RESERVE =
  "content-start min-h-[3.5rem] min-[24.375rem]:min-h-[2.25rem] min-[42.5rem]:min-h-[1rem]";
const NOTE_RESERVE = "min-h-[1.125rem]";
const CHART_RESERVE = { legend: LEGEND_RESERVE, reading: READING_RESERVE };

interface HeaderProps {
  incomplete: boolean;
  range: string;
  source: "cache" | "server";
  support: string | null;
  unit: string;
}

/** The title with the seal of an incomplete estimate beside it, the dates, and the sentence that supports the drawing. */
function ChartHeader({
  incomplete,
  range,
  source,
  support,
  unit,
}: HeaderProps) {
  return (
    <CardHeader className="border-b py-(--card-spacing)">
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-2 gap-y-1",
          TITLE_RESERVE
        )}
      >
        <CardTitle aria-level={2} id={TITLE_ID} role="heading">
          {`Vendas × custos por ${unit}`}
        </CardTitle>
        {incomplete ? <IncompleteBadge /> : null}
      </div>
      <CardDescription className={DESCRIPTION_RESERVE}>
        {`${range}${source === "cache" ? " · cópia guardada" : ""}.`}
        {support ? ` ${support}` : null}
      </CardDescription>
      <p className={cn("text-muted-foreground text-support", NOTE_RESERVE)}>
        {incomplete ? "Não é lucro líquido nem dinheiro já recebido." : null}
      </p>
    </CardHeader>
  );
}

/**
 * The totals written above the drawing (AC-5): the numbers hold without it. The costs only when the line is drawn.
 * Each total is as wide as its own value, which never breaks, so a long one takes a line when the two do not fit side by side.
 */
function Totals({
  costsTotal,
  salesTotal,
}: {
  costsTotal: string | null;
  salesTotal: string;
}) {
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-2">
      <div className="grid gap-0.5">
        <dt className="text-muted-foreground text-support">Vendas líquidas</dt>
        <dd className="font-semibold text-lg tabular-nums">
          <MoneyText text={formatBrlAmount(salesTotal)} />
        </dd>
      </div>
      {costsTotal ? (
        <div className="grid gap-0.5">
          <dt className="text-muted-foreground text-support">Custos</dt>
          <dd className="font-semibold text-lg tabular-nums">
            <MoneyText text={formatBrlAmount(costsTotal)} />
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

/**
 * The numbers a drawing is given: the sales, the costs when they are sent (`null` on a day whose cost is unknown:
 * hatched, never a zero) and the note of a day. Memoized, so the layout is not redone.
 */
function useDrawingData({ costsSent, grouped, rows }: ResultSeries) {
  const data = useMemo(
    () =>
      rows.map((row) => ({
        label: row.label,
        value: chartNumber(row.netSales),
      })),
    [rows]
  );
  const secondary = useMemo(() => {
    if (!costsSent) {
      return null;
    }
    const costs = costSeries(rows);
    return {
      data: rows.map((row, index) => ({
        label: row.label,
        value: costs[index] ?? null,
      })),
      legend: "Custos (CMV, taxas e despesas)",
      name: "Custos",
      unknown: {
        // a month with one unknown day is unknown as a whole (never a partial sum): the hatch names it so
        legend: grouped
          ? "mês com dia sem custo informado"
          : "dia sem custo informado",
        text: NO_COST_TEXT,
      },
    };
  }, [costsSent, grouped, rows]);
  const [hidden] = useHiddenValues();
  const note = useCallback(
    (index: number) => {
      const text = readingNote(rows[index]);
      return text && hidden ? maskMoney(text) : text;
    },
    [hidden, rows]
  );
  const spoken = useCallback(
    (index: number) => {
      const text = readingNote(rows[index]);
      return text && hidden ? maskMoney(text, MASKED_SPOKEN) : text;
    },
    [hidden, rows]
  );
  return { data, note, secondary, spoken };
}

const maskedValue = () => MASKED_MONEY;
const spokenMasked = () => MASKED_SPOKEN;
const noAxis = () => "";

/** One height for every period and every cost state, so the card of the chart never changes its box. */
const PLOT_HEIGHT = 220;

/**
 * The area chart of the charts chunk, with the sales and the dashed cost line, broken on a hatched day whose cost is
 * unknown (AC-9).
 */
function Drawing({
  empty,
  label,
  series,
}: {
  empty: boolean;
  label: string;
  series: ResultSeries;
}) {
  const { data, note, secondary, spoken } = useDrawingData(series);
  const [hidden] = useHiddenValues();
  return (
    <OnDemandAreaChart
      color="var(--chart-sales)"
      data={data}
      failed={<ChartFailed />}
      {...(empty ? { empty: "Sem vendas no período." } : {})}
      formatAxis={hidden ? noAxis : axisMoney}
      formatSpoken={hidden ? spokenMasked : moneyText}
      formatValue={hidden ? maskedValue : moneyText}
      {...(hidden ? {} : { axisUnit: "R$" })}
      height={PLOT_HEIGHT}
      label={hidden ? maskMoney(label, MASKED_SPOKEN) : label}
      legend="Vendas líquidas"
      name="Vendas"
      rangeLabel={series.grouped ? "Mês" : "Dia"}
      readingNote={note}
      reserve={CHART_RESERVE}
      spokenNote={spoken}
      {...(secondary ? { secondary } : {})}
    />
  );
}

/** "Ver os números": the table of every day, which is the proof that the drawing hides nothing; it opens without the chart. */
function NumbersToggle({
  hasCosts,
  series,
}: {
  hasCosts: boolean;
  series: ResultSeries;
}) {
  return (
    <Collapsible>
      <CollapsibleTrigger
        className="group/numbers w-fit"
        render={<Button size="sm" variant="ghost" />}
      >
        Ver os números
        <ChevronDownIcon
          aria-hidden="true"
          className="motion-full:transition-transform group-data-[panel-open]/numbers:rotate-180"
          data-icon="inline-end"
        />
      </CollapsibleTrigger>
      <CollapsiblePanel className="pt-1">
        <NumbersTable hasCosts={hasCosts} series={series} />
      </CollapsiblePanel>
    </Collapsible>
  );
}

/** What goes between the totals and the table: the drawing, or the sentence that says why there is none. */
function Body({ label, series }: { label: string; series: ResultSeries }) {
  if (series.rows.length === 0) {
    return (
      <p className="text-muted-foreground">Este período ainda não começou.</p>
    );
  }
  // a period with returns only still has a drawing: "Sem vendas" is for a period with nothing in it
  return (
    <Drawing
      empty={!hasAnyValue(series.rows, series.costsDrawn)}
      label={label}
      series={series}
    />
  );
}

interface ResultChartProps {
  /** `cache` when the figures are this device's copy: the line under the title says so (AC-16). */
  source: "cache" | "server";
  summary: StoredPeriodSummary;
  timezone: string | null;
}

/**
 * "Vendas × custos por dia" (AC-4 to AC-12): the sales of each day and the costs against them, hatched and broken on a
 * day whose cost is unknown (AC-9). The total of sales, the total of costs and the best day are written above the drawing, and "Ver os
 * números" has the table: the numbers hold without the drawing. The period is cut at the store's today, read from the
 * server's clock; what the days to come cost closes the table.
 */
export function ResultChart({ source, summary, timezone }: ResultChartProps) {
  const { afterToday, daily, granularity } = summary;
  const today = calendarDayInTimezone(new Date(summary.generatedAt), timezone);
  const series = useMemo(
    () =>
      daily ? resultSeries(daily, today, { afterToday, granularity }) : null,
    [afterToday, daily, granularity, today]
  );
  if (!(daily && series)) {
    return null;
  }

  const { costsDrawn, costsSent: sent, days, rows } = series;
  const unknown = days.unknown > 0;
  const range = periodText(summary.period, today.slice(0, 4));
  const best = bestRowText(series);
  const salesTotal = summary.cards.netSales;
  // the total of the costs only when every day is known: never the sum of the known days as the total (AC-9)
  const costsTotal = costsKnown(daily)
    ? costParts(summary.chain, summary.quality).total
    : null;
  const label = `Vendas líquidas${costsDrawn ? " e custos" : ""} por ${series.grouped ? "mês" : "dia"}, ${range}: ${formatBrlAmount(salesTotal)} de vendas${costsTotal ? ` e ${formatBrlAmount(costsTotal)} de custos` : ""}${unknown ? `. ${unknownDaysCount(days.unknown, days.total)}` : ""}`;

  return (
    <Card aria-labelledby={TITLE_ID} className="gap-0 py-0" role="region">
      <ChartHeader
        incomplete={isIncompleteEstimate(summary.quality) || unknown}
        range={range}
        source={source}
        support={supportText(series, summary.chain)}
        unit={series.grouped ? "mês" : "dia"}
      />
      <CardContent className="grid grid-cols-[minmax(0,1fr)] gap-3 py-(--card-spacing)">
        <Totals costsTotal={costsTotal} salesTotal={salesTotal} />
        <p className={cn("text-muted-foreground text-support", NOTE_RESERVE)}>
          {sent ? null : costsNote(source === "cache")}
        </p>
        {/* the line of the best day keeps its height in a period with no sale, so the chart under it does not move */}
        {rows.length > 0 ? (
          <p className="min-h-[1.125rem] text-support">
            {best ? <MoneyText text={best} /> : null}
          </p>
        ) : null}
        <Body label={label} series={series} />
        {rows.length > 0 ? (
          <NumbersToggle hasCosts={sent} series={series} />
        ) : null}
      </CardContent>
    </Card>
  );
}
