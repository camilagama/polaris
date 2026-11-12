import { MoneyText } from "@/ui/hidden-values";
import {
  MASKED_MONEY,
  MASKED_SPOKEN,
  maskMoney,
  useHiddenValues,
} from "../lib/hidden-values";
import { useCallback, useId, useMemo } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";
import { ChartDataTable } from "@/ui/charts/chart-data-table";
import { OnDemandAreaChart, useChartsFailed } from "@/ui/charts/on-demand";
import { HelpTip } from "@/ui/help-tip";
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
  supportParts,
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
      <p className="text-muted-foreground text-support">
        O gráfico não abriu. Os totais estão acima e a tabela, abaixo.
      </p>
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

const COLUMNS_WITH_COSTS = (unit: string) =>
  [
    { header: unit === "mês" ? "Mês" : "Dia" },
    { header: "Vendas líquidas", numeric: true },
    { header: "Custos", numeric: true },
    { header: `Resultado do ${unit}`, numeric: true },
    { header: "Despesas do período", numeric: true },
  ] as const;

function isNegative(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().startsWith("-");
}

const RESULT_CELL = 3;

/**
 * The table of the numbers: every day (or month) with its sales, its costs, its result and its expenses. Invisible, it is
 * the way to the numbers for a screen reader (the chart's `aria-details` points at it); shown, it is what stays when the
 * chart does not open. A day whose cost is unknown says "sem custo", never a zero.
 */
export function NumbersTable({
  hasCosts,
  id,
  series,
  visible,
}: {
  hasCosts: boolean;
  id: string;
  series: ResultSeries;
  visible: boolean;
}) {
  const unit = series.grouped ? "mês" : "dia";
  const columns = hasCosts
    ? COLUMNS_WITH_COSTS(unit)
    : ([
        { header: unit === "mês" ? "Mês" : "Dia" },
        { header: "Vendas líquidas", numeric: true },
      ] as const);
  return (
    <ChartDataTable
      caption={`Vendas e custos de cada ${unit} do período`}
      columns={columns}
      footer={
        series.afterToday
          ? `Depois de hoje: despesas ${formatBrlAmount(series.afterToday)}`
          : undefined
      }
      id={id}
      rows={series.rows.map((row: ResultRow) => ({
        cells: hasCosts
          ? [
              row.tableLabel,
              formatBrlAmount(row.netSales),
              costText(row.costs),
              costText(row.operatingResult),
              row.expenses ? formatBrlAmount(row.expenses) : EMPTY_CELL,
            ]
          : [row.tableLabel, formatBrlAmount(row.netSales)],
        key: row.key,
        ...(hasCosts && isNegative(row.operatingResult)
          ? { negativeCells: [RESULT_CELL] }
          : {}),
      }))}
      visible={visible}
    />
  );
}

/** What the block says in place of the cost line when the costs of the days were not sent at all: no zero is made up. */
function costsNote(fromCopy: boolean): string {
  return fromCopy
    ? "Esta cópia guardada não tem os custos por dia."
    : "Os custos por dia não estão disponíveis agora.";
}

/**
 * The room the lines of the card keep so the box does not change height between periods: `min-h` of the tallest form the
 * line takes at that width, never `max-h` nor a clamp, so nothing is cut. The title row (with its two (i) and the seal
 * of an incomplete estimate, which wraps below 460 px; the two (i) are 20 px apart so their touch areas do not overlap) and the row that holds the reading of the day and the legend
 * (side by side from 400 px, stacked below) were measured every 4 px from 320 to 500 px, every 20 up to 820 and every 50 up
 * to 1360, over the month, 30 days, the year and 366 days, whole, with unknown days and with amounts of R$ 999.999,99, and a
 * month with an expense on its last day, with the values shown and hidden; a step is placed at the first width where the tallest form changes.
 * The row takes `content-start`, so the room goes below the text and not between its fragments.
 */
const TITLE_RESERVE = "min-h-[2.875rem] min-[28.75rem]:min-h-[1.375rem]";
const TOP_RESERVE =
  "min-h-[8.5rem] min-[20.75rem]:min-h-[7.375rem] min-[21.75rem]:min-h-[6.25rem] min-[23.75rem]:min-h-[5rem] min-[25rem]:min-h-[5.5rem] min-[28.25rem]:min-h-[4.5rem] min-[40rem]:min-h-[3.5rem] min-[45rem]:min-h-[2.25rem]";
const NOTE_RESERVE = "min-h-[1.125rem]";

interface HeaderProps {
  incomplete: boolean;
  range: string;
  source: "cache" | "server";
  support: { count: string | null; tail: string | null };
  unit: string;
}

/**
 * What the first (i) of the title says: the dates (and "cópia guardada" when they are this device's copy) and how many
 * days have no cost. At most 160 characters, whatever the period and the state; the caveat that this is not net profit
 * is said by the (i) of the screen, the quality warning and the foot of the chain, not here.
 */
export function periodHelp({
  count,
  range,
  source,
}: {
  count: string | null;
  range: string;
  source: "cache" | "server";
}): string {
  return [`${range}${source === "cache" ? " · cópia guardada" : ""}.`, count]
    .filter((part): part is string => part !== null)
    .join(" ");
}

/** The title with its two (i) and, beside them, the seal of an incomplete estimate: the dates and the sentences that support the drawing are in the (i). */
function ChartHeader({
  incomplete,
  range,
  source,
  support,
  unit,
}: HeaderProps) {
  const title = `Vendas × custos por ${unit}`;
  return (
    <CardHeader className="border-b py-(--card-spacing)">
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-2 gap-y-1",
          TITLE_RESERVE
        )}
      >
        <div className="flex min-w-0 items-center gap-1">
          <CardTitle aria-level={2} id={TITLE_ID} role="heading">
            {title}
          </CardTitle>
          <HelpTip about={`${title}: o período`} className="-my-1">
            {periodHelp({ count: support.count, range, source })}
          </HelpTip>
          {support.tail ? (
            <HelpTip about={`${title}: as linhas`} className="-my-1 ml-4">
              {support.tail}
            </HelpTip>
          ) : null}
        </div>
        {incomplete ? <IncompleteBadge /> : null}
      </div>
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
  details,
  empty,
  label,
  series,
}: {
  details: string;
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
      details={details}
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
      reserve={TOP_RESERVE}
      spokenNote={spoken}
      {...(secondary ? { secondary } : {})}
    />
  );
}

/** What goes between the totals and the table: the drawing, or the sentence that says why there is none. */
function Body({
  details,
  label,
  series,
}: {
  details: string;
  label: string;
  series: ResultSeries;
}) {
  if (series.rows.length === 0) {
    return (
      <p className="text-muted-foreground">Este período ainda não começou.</p>
    );
  }
  // a period with returns only still has a drawing: "Sem vendas" is for a period with nothing in it
  return (
    <Drawing
      details={details}
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
 * day whose cost is unknown (AC-9). The total of sales, the total of costs and the best day are written above the drawing,
 * and the table of every day closes the card: invisible, tied to the chart by `aria-details`, and shown in the place of
 * the drawing when the charts chunk does not open. The period is cut at the store's today, read from the server's
 * clock; what the days to come cost closes the table.
 */
export function ResultChart({ source, summary, timezone }: ResultChartProps) {
  const numbersId = useId();
  const drawingFailed = useChartsFailed();
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
        support={supportParts(series, summary.chain)}
        unit={series.grouped ? "mês" : "dia"}
      />
      <CardContent className="grid grid-cols-[minmax(0,1fr)] gap-2 py-(--card-spacing)">
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
        <Body details={numbersId} label={label} series={series} />
        {rows.length > 0 ? (
          <NumbersTable
            hasCosts={sent}
            id={numbersId}
            series={series}
            visible={drawingFailed}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
