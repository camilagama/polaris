import { Money } from "@polaris/domain/money/money";
import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/ui/button";
import { ChartDataTable } from "@/ui/charts/chart-data-table";
import {
  EXTRA_HEIGHT,
  OnDemandAreaChart,
  useChartsFailed,
} from "@/ui/charts/on-demand";
import { EmptyState } from "@/ui/empty-state";
import { MoneyText } from "@/ui/hidden-values";
import { useConnectionOnline } from "../lib/browser-connection";
import { formatBrlAmount } from "../lib/format";
import type { StoredPeriodSummary } from "../lib/period-summary-cache";
import {
  axisMoney,
  moneyText,
  type ResultSeries,
  resultSeries,
} from "../dashboard/result-series";
import {
  MASKED_MONEY,
  MASKED_SPOKEN,
  maskMoney,
  useHiddenValues,
} from "../lib/hidden-values";
import { useIsMobile } from "../lib/use-mobile";
import { chartValue, periodShort } from "./home-model";
import { HomeBlock } from "./home-parts";

/**
 * The chart of net sales of the period the Início looks at (AC-17, AC-18, § 6): in the header the title with its (i);
 * under it the total and the period it adds up, and the area chart of the charts chunk with only the peak written (with
 * its date). The table of every day is invisible on the screen and tied to the chart by `aria-details`, so the drawing
 * hides nothing from assistive technology. A period longer than 62 days comes by month, as the server adds it up.
 * A period with no sale keeps the box of the chart, with its floor, and says so in the middle of it. When the chunk
 * does not open the table is shown in the place of the drawing, and the sentence of § 5.5 says why.
 */

/** The least height of the plot: 140 px on a phone, 200 from 768 px; the empty period keeps the same one. */
function useChartHeight() {
  const still = useIsMobile();
  return { height: still ? 140 : 200, still };
}

/**
 * The height of the plot is the least one until the card is taller than its own content (the pair of a row takes
 * the height of the taller card): the plot then grows to the box, so the card never has an empty foot. The box is the
 * one the drawing is placed in, out of the flow, so the drawing never asks the card for height.
 */
function useFilledHeight(least: number) {
  const box = useRef<HTMLDivElement>(null);
  const [filled, setFilled] = useState(least);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) {
      return;
    }
    const read = () =>
      setFilled(
        Math.max(
          least,
          Math.round(element.getBoundingClientRect().height) - EXTRA_HEIGHT
        )
      );
    read();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [least]);
  return { box, filled };
}

const maskedValue = () => MASKED_MONEY;
const spokenMasked = () => MASKED_SPOKEN;
const noAxis = () => "";
const NO_SALE = <EmptyState afterRead bare title="Sem vendas no período." />;

/** The Início has no form: loading the page again is the way to ask for the chunk once more. */
function reloadPage() {
  window.location.reload();
}

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
      O gráfico abre quando a internet voltar. Os números estão abaixo.
    </p>
  );
}

type Row = ResultSeries["rows"][number];

const points = (rows: readonly Row[]) =>
  rows.map((row) => ({ label: row.label, value: chartValue(row.netSales) }));

/**
 * The area of the period, in the green of the sales (v7 § 4): a ring on the best day and on today (full when it sold,
 * hollow on a zero), only the value of the best day written, with its date. With the values hidden the amounts, the
 * axis and the spoken values are masked; the shape stays.
 */
function DayChart({
  details,
  empty,
  grouped,
  rows,
  summary,
}: {
  /** The id of the table of the numbers the drawing points at. */
  details: string;
  /** A period with no sale: the chart keeps its box and says this in the middle of it. */
  empty: boolean;
  grouped: boolean;
  rows: readonly Row[];
  summary: string;
}) {
  const [hidden] = useHiddenValues();
  const { height: least, still } = useChartHeight();
  const { box, filled: height } = useFilledHeight(least);
  return (
    <div
      className="relative flex-1"
      data-chart-box=""
      ref={box}
      style={{ minHeight: least + EXTRA_HEIGHT }}
    >
      <div className="absolute inset-0">
        <OnDemandAreaChart
          color="var(--chart-sales)"
          data={points(rows)}
          details={details}
          failed={<ChartFailed />}
          {...(empty ? { empty: NO_SALE } : {})}
          formatAxis={hidden ? noAxis : axisMoney}
          formatSpoken={hidden ? spokenMasked : moneyText}
          formatValue={hidden ? maskedValue : moneyText}
          height={height}
          label={hidden ? maskMoney(summary, MASKED_SPOKEN) : summary}
          markers="key"
          name="Vendas"
          rangeLabel={grouped ? "Mês do período" : "Dia do período"}
          readingAtRest={false}
          still={still}
          valueLabels="peak"
          {...(hidden ? {} : { axisUnit: "R$" })}
        />
      </div>
    </div>
  );
}

/**
 * The table of the numbers: every day (or month) of the period with its net sales. Invisible, it is the way to the
 * numbers for a screen reader; shown, it is what stays when the chart does not open.
 */
export function NumbersTable({
  grouped,
  id,
  rows,
  visible,
}: {
  grouped: boolean;
  id: string;
  rows: readonly Row[];
  visible: boolean;
}) {
  return (
    <ChartDataTable
      caption={`Vendas líquidas por ${grouped ? "mês" : "dia"}, do período mostrado, do mais antigo ao mais novo.`}
      columns={[
        { header: grouped ? "Mês" : "Dia" },
        { header: "Vendas líquidas", numeric: true },
      ]}
      id={id}
      rows={rows.map((row) => ({
        cells: [row.tableLabel, formatBrlAmount(row.netSales)],
        key: row.key,
      }))}
      visible={visible}
    />
  );
}

const sumRows = (rows: readonly Row[]): string =>
  rows
    .reduce(
      (total, row) => total.add(Money.from(row.netSales)),
      Money.fromMinorUnits(0n)
    )
    .toString();

function Period({
  summary,
  today,
}: {
  summary: StoredPeriodSummary;
  today: string;
}) {
  const numbersId = useId();
  const drawingFailed = useChartsFailed();
  const series = useMemo(
    () => resultSeries(summary.daily ?? [], today, summary),
    [summary, today]
  );
  const { rows } = series;
  const first = summary.period.from;
  const last = summary.period.to < today ? summary.period.to : today;
  const total = sumRows(rows);
  // a period of returns only (net below zero) still has a drawing: "Sem vendas" is for a period with nothing
  const sold = rows.some((row) => chartValue(row.netSales) !== 0);
  const where = periodShort(first, last, today.slice(0, 4));
  const summaryText = `Vendas líquidas por ${series.grouped ? "mês" : "dia"}, de ${where}: ${formatBrlAmount(total)} no total. A tabela ${series.grouped ? "mês a mês" : "dia a dia"} está no fim deste bloco.`;
  return (
    <div className="flex flex-1 flex-col gap-3">
      <p className="grid gap-0.5">
        <span className="font-semibold text-lg tabular-nums">
          <MoneyText text={formatBrlAmount(total)} />
        </span>
        <span className="text-muted-foreground text-support">{where}</span>
      </p>
      <DayChart
        details={numbersId}
        empty={!sold}
        grouped={series.grouped}
        rows={rows}
        summary={summaryText}
      />
      <NumbersTable
        grouped={series.grouped}
        id={numbersId}
        rows={rows}
        visible={drawingFailed && sold}
      />
    </div>
  );
}

/** What the (i) of the block says: how to read a day, or a month when the period is long. */
export function chartHelp(grouped: boolean): string {
  return grouped
    ? "Vendas líquidas de cada mês do período. Toque num mês para ver o valor."
    : "Vendas líquidas de cada dia do período. Toque num dia para ver o valor.";
}

/** Vendas por dia of the period the Início looks at: the days up to today, or the months when it is longer than 62 days. */
export function ChartBlock({
  summary,
  today,
}: {
  summary: StoredPeriodSummary;
  today: string;
}) {
  const grouped = summary.granularity === "month";
  const title = grouped ? "Vendas por mês" : "Vendas por dia";
  return (
    <HomeBlock
      help={{ about: title, text: chartHelp(grouped) }}
      id="home-chart"
      title={title}
    >
      <Period summary={summary} today={today} />
    </HomeBlock>
  );
}
