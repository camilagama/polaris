import { useCallback, useId, useMemo } from "react";
import { cn } from "@/lib/utils";
import { Block, BlockHeader, BlockPanel } from "@/ui/block";
import { BlockHeader as Heading } from "@/ui/block-header";
import { CardFrame, CardFrameHeader, CardFramePanel } from "@/ui/card";
import { ChartDataTable } from "@/ui/charts/chart-data-table";
import {
  EXTRA_HEIGHT,
  OnDemandAreaChart,
  useChartsFailed,
} from "@/ui/charts/on-demand";
import { MoneyText } from "@/ui/hidden-values";
import { RetryButton } from "@/ui/retry-button";
import { Skeleton } from "@/ui/skeleton";
import { SlowReadNote } from "../app-shell/read-wait";
import { useConnectionOnline } from "../lib/browser-connection";
import { calendarDayInTimezone } from "../lib/dates";
import { formatBrlAmount } from "../lib/format";
import {
  MASKED_MONEY,
  MASKED_SPOKEN,
  maskMoney,
  useHiddenValues,
} from "../lib/hidden-values";
import type { StoredPeriodSummary } from "../lib/period-summary-cache";
import { useIsMobile } from "../lib/use-mobile";
import { isIncompleteEstimate } from "./dashboard-model";
import { missingInformed, missingInputOf } from "./missing-input";
import { IncompleteBadge } from "./result-cards";
import { periodText } from "./result-period";
import {
  axisMoney,
  bestMark,
  bestRowText,
  chartNumber,
  costParts,
  costSeries,
  costsKnown,
  costText,
  hasAnyValue,
  moneyText,
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
      <RetryButton onClick={reloadPage} />
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
              costText(row.costs, series.missing),
              costText(row.operatingResult, series.missing),
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

const NOTE_RESERVE = "min-h-5.5";

interface HeaderProps {
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

/**
 * What the legend of the header names: the sales line, the cost line when it is drawn, and the hatch of an unknown day.
 * `shown` false is a card with nothing to name (no cost line sent, or nothing to draw).
 */
interface LegendModel {
  costs: boolean;
  hatched: boolean;
  hatchedText: string;
  shown: boolean;
}

const LEGEND_COSTS = "Custos (CMV, taxas e despesas)";
const COST_DASH = "5,4";

function legendOf(series: ResultSeries, drawn: boolean): LegendModel {
  const hatchedText = `${series.grouped ? "mês com dia" : "dia"} ${missingInformed(series.missing)}`;
  if (!series.costsSent || series.rows.length === 0 || !drawn) {
    return { costs: false, hatched: false, hatchedText, shown: false };
  }
  const costs = costSeries(series.rows);
  return {
    costs: costs.some((value) => value !== null),
    hatched: costs.some((value) => value === null),
    hatchedText,
    shown: true,
  };
}

function LegendLine({ dash, color }: { color: string; dash?: string }) {
  return (
    <svg aria-hidden="true" height={8} width={16}>
      <line
        stroke={color}
        strokeDasharray={dash}
        strokeLinecap="round"
        strokeWidth={2}
        x1={1}
        x2={15}
        y1={4}
        y2={4}
      />
    </svg>
  );
}

function LegendHatch() {
  return (
    <svg aria-hidden="true" height={10} width={10}>
      <rect
        fill="var(--chart-unknown)"
        fillOpacity={0.08}
        height={10}
        width={10}
      />
      {[2, 6, 10, 14].map((offset) => (
        <line
          key={offset}
          stroke="var(--chart-unknown)"
          strokeWidth={1.6}
          x1={offset - 10}
          x2={offset}
          y1={10}
          y2={0}
        />
      ))}
    </svg>
  );
}

/**
 * An absent name keeps its place unseen (`invisible` leaves it out of the accessibility tree too), so the names take the
 * same room, wrap at the same width and the card keeps its height with and without them. From 760 px, where the names
 * sit at the right of the title, the unseen one goes first, so what is drawn stays against the right edge.
 */
const LEGEND_ABSENT = "invisible md:order-first";
const HATCH_LONGEST = "mês com dia sem custo informado";

/**
 * The names of the lines, each with its own trace (color is never the only sign), on the right of the header of the card
 * as the blocks of the Início put what they show at the side of the title; on a narrow window the list wraps under the
 * title, whole, with the three names laid out whatever is drawn.
 */
function HeaderLegend({ legend }: { legend: LegendModel }) {
  const item = (present: boolean) =>
    cn("flex items-center gap-1.5", !present && LEGEND_ABSENT);
  const hatched = legend.shown && legend.hatched;
  return (
    <ul
      aria-hidden={legend.shown ? undefined : "true"}
      className="flex min-w-0 flex-wrap justify-end gap-x-4 gap-y-1 text-muted-foreground text-xs"
      {...(legend.shown ? { "data-chart-legend": "" } : {})}
    >
      <li className={item(legend.shown)}>
        <LegendLine color="var(--chart-sales)" />
        Vendas líquidas
      </li>
      <li className={item(legend.shown && legend.costs)}>
        <LegendLine color="var(--chart-context)" dash={COST_DASH} />
        {LEGEND_COSTS}
      </li>
      <li
        className={item(hatched)}
        {...(hatched ? { "data-chart-legend-unknown": "" } : {})}
      >
        <LegendHatch />
        <span className="grid">
          <span className="col-start-1 row-start-1">{legend.hatchedText}</span>
          <span
            aria-hidden="true"
            className="invisible col-start-1 row-start-1"
          >
            {HATCH_LONGEST}
          </span>
        </span>
      </li>
    </ul>
  );
}

/** The title with its (i): the dates and the sentences that support the drawing are in the (i); a second (i) says the lines when there are any. */
function ChartHeader({
  legend,
  range,
  source,
  support,
  unit,
}: HeaderProps & { legend: LegendModel }) {
  const title = `Vendas × custos por ${unit}`;
  const tips = [
    {
      about: `${title}: o período`,
      text: periodHelp({ count: support.count, range, source }),
    },
    ...(support.tail
      ? [{ about: `${title}: as linhas`, text: support.tail }]
      : []),
  ];
  return (
    <BlockHeader
      aside={<HeaderLegend legend={legend} />}
      className="md:flex-wrap"
      help={tips}
      id={TITLE_ID}
      title={title}
    />
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
        <dd className="font-semibold text-lg">
          <MoneyText text={formatBrlAmount(salesTotal)} />
        </dd>
      </div>
      {costsTotal ? (
        <div className="grid gap-0.5">
          <dt className="text-muted-foreground text-support">Custos</dt>
          <dd className="font-semibold text-lg">
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
function useDrawingData(series: ResultSeries, thisYear: string) {
  const { costsSent, grouped, missing, rows } = series;
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
      color: "var(--chart-context)" as const,
      data: rows.map((row, index) => ({
        label: row.label,
        value: costs[index] ?? null,
      })),
      legend: LEGEND_COSTS,
      legendInHeader: true,
      name: "Custos",
      unknown: {
        // a month with one unknown day is unknown as a whole (never a partial sum): the hatch names it so
        legend: `${grouped ? "mês com dia" : "dia"} ${missingInformed(missing)}`,
        text: missingInformed(missing),
      },
    };
  }, [costsSent, grouped, missing, rows]);
  const [hidden] = useHiddenValues();
  const noteOf = useCallback(
    (index: number) =>
      [readingNote(rows[index], missing, thisYear), bestMark(series, index)]
        .filter((part): part is string => part !== null)
        .join(" · ") || null,
    [missing, rows, series, thisYear]
  );
  const note = useCallback(
    (index: number) => {
      const text = noteOf(index);
      return text && hidden ? maskMoney(text) : text;
    },
    [hidden, noteOf]
  );
  const spoken = useCallback(
    (index: number) => {
      const text = noteOf(index);
      return text && hidden ? maskMoney(text, MASKED_SPOKEN) : text;
    },
    [hidden, noteOf]
  );
  return { data, note, secondary, spoken };
}

const maskedValue = () => MASKED_MONEY;
const spokenMasked = () => MASKED_SPOKEN;
const noAxis = () => "";

/**
 * The height of the plot of the Início (140 px on a phone, 200 from 760 px), one for every period and every cost
 * state, so the card of the chart never changes its box and the two screens draw the same area.
 */
function usePlotHeight() {
  const still = useIsMobile();
  return { height: still ? 140 : 200, still };
}

/**
 * The area chart of the charts chunk, with the sales and the dashed cost line, broken on a hatched day whose cost is
 * unknown (AC-9).
 */
function Drawing({
  details,
  empty,
  label,
  series,
  thisYear,
}: {
  details: string;
  empty: boolean;
  label: string;
  series: ResultSeries;
  thisYear: string;
}) {
  const { data, note, secondary, spoken } = useDrawingData(series, thisYear);
  const [hidden] = useHiddenValues();
  const { height, still } = usePlotHeight();
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
      height={height}
      label={hidden ? maskMoney(label, MASKED_SPOKEN) : label}
      legend="Vendas líquidas"
      name="Vendas"
      rangeLabel={series.grouped ? "Mês" : "Dia"}
      readingAtRest={false}
      readingNote={note}
      spokenNote={spoken}
      still={still}
      {...(secondary ? { secondary } : {})}
    />
  );
}

/** What goes between the totals and the table: the drawing, or the sentence that says why there is none. */
function Body({
  details,
  label,
  series,
  thisYear,
}: {
  details: string;
  label: string;
  series: ResultSeries;
  thisYear: string;
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
      thisYear={thisYear}
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
 * day whose cost is unknown (AC-9). The total of sales and the total of costs are written above the drawing; the best
 * day is written for the screen reader only (`sr-only`). The table of every day closes the card: invisible, tied to the
 * chart by `aria-details`, and shown in the place of the drawing when the charts chunk does not open. The period is
 * cut at the store's today, read from the server's clock; what the days to come cost closes the table.
 */
export function ResultChart({ source, summary, timezone }: ResultChartProps) {
  const numbersId = useId();
  const drawingFailed = useChartsFailed();
  const [hidden] = useHiddenValues();
  const { afterToday, daily, granularity } = summary;
  const today = calendarDayInTimezone(new Date(summary.generatedAt), timezone);
  const series = useMemo(
    () =>
      daily
        ? resultSeries(daily, today, {
            afterToday,
            granularity,
            missing: missingInputOf(summary.quality),
          })
        : null,
    [afterToday, daily, granularity, summary.quality, today]
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
  const label = `Vendas líquidas${costsDrawn ? " e custos" : ""} por ${series.grouped ? "mês" : "dia"}, ${range}: ${formatBrlAmount(salesTotal)} de vendas${costsTotal ? ` e ${formatBrlAmount(costsTotal)} de custos` : ""}${unknown ? `. ${unknownDaysCount({ ...days, input: series.missing })}` : ""}`;

  return (
    <Block aria-labelledby={TITLE_ID}>
      <ChartHeader
        legend={legendOf(series, hasAnyValue(rows, costsDrawn))}
        range={range}
        source={source}
        support={supportParts(series, summary.chain)}
        unit={series.grouped ? "mês" : "dia"}
      />
      <BlockPanel className="grid grid-cols-[minmax(0,1fr)] gap-2">
        <Totals costsTotal={costsTotal} salesTotal={salesTotal} />
        <div
          className={cn(
            "flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-support",
            NOTE_RESERVE
          )}
        >
          {isIncompleteEstimate(summary.quality) || unknown ? (
            <IncompleteBadge />
          ) : null}
          {sent ? null : <span>{costsNote(source === "cache")}</span>}
        </div>
        {best ? (
          <p className="sr-only">{hidden ? maskMoney(best) : best}</p>
        ) : null}
        <Body
          details={numbersId}
          label={label}
          series={series}
          thisYear={today.slice(0, 4)}
        />
        {rows.length > 0 ? (
          <NumbersTable
            hasCosts={sent}
            id={numbersId}
            series={series}
            visible={drawingFailed}
          />
        ) : null}
      </BlockPanel>
    </Block>
  );
}

/**
 * The card while the figures are read: the header, the labels of the totals, the line of the note and the box of the plot
 * with its floor, at the heights they have with figures, so nothing moves when they come. Under the
 * line of the note goes the "Demorando mais que o normal" of a read that takes long.
 */
export function ResultChartSkeleton() {
  const { height } = usePlotHeight();
  return (
    <CardFrame>
      <CardFrameHeader aria-hidden="true">
        <Heading
          aside={
            <HeaderLegend
              legend={{
                costs: true,
                hatched: false,
                hatchedText: "dia sem custo informado",
                shown: true,
              }}
            />
          }
          id="dashboard-chart-loading"
          title="Vendas × custos por dia"
        />
      </CardFrameHeader>
      <CardFramePanel className="grid grid-cols-[minmax(0,1fr)] gap-2">
        <div aria-hidden="true" className="flex flex-wrap gap-x-6 gap-y-2">
          {["Vendas líquidas", "Custos"].map((name) => (
            <div className="grid gap-0.5" key={name}>
              <span className="text-muted-foreground text-support">{name}</span>
              <span className="flex h-7 items-center">
                <Skeleton aria-hidden="true" className="h-5 w-28" />
              </span>
            </div>
          ))}
        </div>
        <div
          className={cn(
            "flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-support",
            NOTE_RESERVE
          )}
        >
          <SlowReadNote announce={false} />
        </div>
        <div
          aria-hidden="true"
          className="relative w-full"
          data-chart-loading=""
          style={{ height: height + EXTRA_HEIGHT }}
        >
          <div
            className="absolute inset-x-0 border-border border-t"
            style={{ bottom: 32 }}
          />
        </div>
      </CardFramePanel>
    </CardFrame>
  );
}
