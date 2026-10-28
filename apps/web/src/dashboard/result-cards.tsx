import { useCallback, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { OnDemandSparkline } from "@/ui/charts/on-demand";
import { DeltaChip, HeroValue, KpiCard, type KpiRange } from "@/ui/kpi-card";
import { type KpiReading, unknownDaysText } from "../home/home-kpis";
import { shortDate } from "../home/home-model";
import { formatBrlAmount } from "../lib/format";
import {
  MASKED_SPOKEN,
  maskMoney,
  useHiddenValues,
} from "../lib/hidden-values";
import {
  cogsCoverageOf,
  type StoredPeriodSummary,
} from "../lib/period-summary-cache";
import { useIsMobile } from "../lib/use-mobile";
import {
  formatPercentOrDash,
  isIncompleteEstimate,
  NO_KNOWN_COST_NOTE,
  NO_KNOWN_COST_RESULT,
} from "./dashboard-model";
import { type ResultKpis, resultKpis } from "./result-kpis";
import type { ComparisonDays, ComparisonSales } from "./use-period-summary";

export function IncompleteBadge() {
  // two columns at 320 px leave less room than the words: the badge breaks its line inside its own box
  return (
    <Badge
      className="h-auto min-h-5 max-w-full whitespace-normal py-0.5 text-left leading-4"
      variant="warning"
    >
      estimativa incompleta
    </Badge>
  );
}

/** The lines of the two cards when no cost of the period is known (never a margin or a result made of zero costs). */
const NO_COST_MARGIN = NO_KNOWN_COST_NOTE;

function IncompleteBadgeLine() {
  return (
    <span className="mb-1 block">
      <IncompleteBadge />
    </span>
  );
}

/** The foot of the result card: the badge, then the line of the card, or what is missing (and never both). */
function ResultFooter({
  incomplete,
  kind,
  line,
  noCost,
}: {
  incomplete: boolean;
  kind: ResultKpis["result"];
  line: string;
  noCost: boolean;
}) {
  return (
    <>
      {incomplete ? <IncompleteBadgeLine /> : null}
      {noCost ? <span data-kpi-no-cost="">{NO_KNOWN_COST_RESULT}</span> : line}
      {!noCost && kind.kind === "incomplete" ? (
        <span className="mt-1 block" data-kpi-unknown="">
          {unknownDaysText(kind.unknown, kind.total)}
        </span>
      ) : null}
    </>
  );
}

/** No day: the same array on every render, so a copy without the series does not redo the memoized cards. */
const NO_DAYS: readonly never[] = [];

/** What the keyboard control says of a reading: "Até 17/10: R$ 1.926,30", with the amount hidden when asked. */
function spoken(prefix: string, reading: KpiReading, hidden: boolean): string {
  const amount =
    reading.value === null ? "sem valor" : formatBrlAmount(reading.value);
  const text = `${prefix}: ${amount}`;
  return hidden ? maskMoney(text, MASKED_SPOKEN) : text;
}

/** The height of a sparkline: 64 px from 760 px; on a phone 52, and 48 in a card of half the width (its touch area). */
function sparkHeight(still: boolean, compact: boolean): number {
  if (!still) {
    return 64;
  }
  return compact ? 48 : 52;
}

/** The chip of a reading, or nothing: no empty row under the number when there is no change to show. */
function chip(reading: KpiReading) {
  return reading.delta ? { chip: <DeltaChip delta={reading.delta} /> } : {};
}

type SparkColor =
  | "var(--chart-sales)"
  | "var(--chart-result)"
  | "var(--chart-ticket)"
  | "var(--destructive)";

interface ResultCardsProps {
  /** The days of the period before, read for the chips; null while not read (or not readable): no chip. */
  comparison: ComparisonDays | null;
  /** The same days as `dailySales` read them: the chips of sales and ticket; null while not read (or not readable). */
  salesComparison: ComparisonSales | null;
  summary: StoredPeriodSummary;
  today: string;
}

/**
 * The row of KPI cards of the Resultado (revisão de UI v7, § 8), in the mold of the Início: Resultado estimado, Vendas,
 * Ticket médio and Margem. The sparklines of sales, ticket and result read the same day together (the pointer, the
 * finger or the arrows); leaving, they go back to the period up to today. The result has its sparkline and its chip
 * (in reais) only when every day up to today has a known cost; otherwise the badge "estimativa incompleta" and "N de M
 * dias sem custo informado", with neither (AC-9). With no cost of the goods known (`cogsCoverageOf` is "none") the
 * result and the margin show a dash, the badge and one line each: the server's figures are then the sales, never an
 * estimate. The margin is the server's, with no sparkline. On a phone the sparklines are drawn finished; the reading
 * by the finger stays.
 */
export function ResultCards({
  comparison,
  salesComparison,
  summary,
  today,
}: ResultCardsProps) {
  const still = useIsMobile();
  const [hidden] = useHiddenValues();
  const { cards, quality } = summary;
  const daily = summary.daily ?? NO_DAYS;
  const kpis = useMemo(
    () =>
      resultKpis({
        cards,
        daily,
        period: summary.period,
        previous: comparison,
        previousSales: salesComparison,
        today,
      }),
    [cards, comparison, daily, salesComparison, summary.period, today]
  );
  const [index, setIndex] = useState<number | null>(null);
  const clear = useCallback(() => setIndex(null), []);
  const last = kpis.days.length - 1;
  const read = kpis.read(index);
  const rest = kpis.read(null);
  // the day read (or today at rest), never the range of the card: "Até 17/10: R$ 1.926,30"
  const until = `Até ${shortDate(kpis.days[Math.min(index ?? last, last)]?.date ?? today)}`;
  const range = (reading: KpiReading, label: string): KpiRange => ({
    label,
    max: last,
    onBlur: clear,
    onChange: setIndex,
    value: index ?? last,
    valueText: spoken(until, reading, hidden),
  });
  const spark = (
    values: number[],
    color: SparkColor,
    domain: "range" | "zero",
    compact: boolean
  ) => (
    <OnDemandSparkline
      color={color}
      domain={domain}
      height={sparkHeight(still, compact)}
      onRead={setIndex}
      readIndex={index}
      still={still}
      values={values}
    />
  );
  // a period with no sale draws nothing; a copy kept before the series existed has the totals only
  const drawn = cards.salesCount > 0 && kpis.days.length > 0;
  // no cost of the goods known: the server's margin and result are the sales, so the two cards say so, with no number
  const noCost = cogsCoverageOf(quality) === "none";
  const incomplete =
    noCost ||
    isIncompleteEstimate(quality) ||
    kpis.result.kind === "incomplete";
  const resultNegative = (rest.result.value ?? "").trim().startsWith("-");
  const salesTitle = kpis.month ? `Vendas em ${kpis.month}` : "Vendas líquidas";
  return (
    <div
      className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4"
      data-kpi-row=""
    >
      <KpiCard
        {...(noCost ? {} : chip(read.result))}
        className="col-span-2 lg:col-span-1"
        date={read.result.date}
        entity="result"
        footer={
          <ResultFooter
            incomplete={incomplete}
            kind={kpis.result}
            line={read.result.count}
            noCost={noCost}
          />
        }
        id="result-kpi-result"
        note={noCost ? null : read.result.note}
        {...(kpis.series.result && drawn && !noCost
          ? {
              range: range(
                read.result,
                "Resultado estimado, acumulado por dia"
              ),
              spark: spark(
                kpis.series.result,
                resultNegative ? "var(--destructive)" : "var(--chart-result)",
                "range",
                false
              ),
            }
          : {})}
        title="Resultado estimado"
        value={<HeroValue amount={noCost ? null : read.result.value} />}
      />
      <KpiCard
        {...chip(read.sales)}
        className="col-span-2 lg:col-span-1"
        date={read.sales.date}
        entity="sales"
        footer={read.sales.count}
        id="result-kpi-sales"
        note={read.sales.note}
        {...(drawn
          ? {
              range: range(read.sales, `${salesTitle}, acumulado por dia`),
              spark: spark(
                kpis.series.sales,
                "var(--chart-sales)",
                "zero",
                false
              ),
            }
          : {})}
        title={salesTitle}
        value={<HeroValue amount={read.sales.value} />}
      />
      <KpiCard
        {...chip(read.ticket)}
        compact
        date={read.ticket.date}
        entity="ticket"
        footer={
          read.ticket.countNarrow ? (
            <>
              <span className="md:hidden">{read.ticket.countNarrow}</span>
              <span className="max-md:hidden">{read.ticket.count}</span>
            </>
          ) : (
            read.ticket.count
          )
        }
        id="result-kpi-ticket"
        note={read.ticket.note}
        {...(drawn
          ? {
              range: range(read.ticket, "Ticket médio, por dia do período"),
              spark: spark(
                kpis.series.ticket,
                "var(--chart-ticket)",
                "range",
                true
              ),
            }
          : {})}
        title="Ticket médio"
        value={<HeroValue amount={read.ticket.value} size="md" />}
      />
      <KpiCard
        compact
        date={rest.sales.date}
        entity="result"
        footer={
          <>
            {incomplete ? <IncompleteBadgeLine /> : null}
            {noCost ? NO_COST_MARGIN : "Contribuição sobre as vendas líquidas."}
          </>
        }
        id="result-kpi-margin"
        title="Margem"
        value={<MarginValue percent={noCost ? null : cards.marginPercent} />}
      />
    </div>
  );
}

/** The margin as a display: "41,2%", the sign of a percent a step smaller; a dash when there is none. Never hidden. */
function MarginValue({ percent }: { percent: string | null }) {
  const text = formatPercentOrDash(percent);
  const box =
    "whitespace-nowrap font-[650] text-[1.3125rem] tabular-nums leading-[1.05] tracking-[-0.035em]";
  if (percent === null) {
    return (
      <p className={cn(box, "text-muted-foreground")}>
        <span aria-hidden="true">—</span>
        <span className="sr-only">sem valor</span>
      </p>
    );
  }
  const negative = percent.trim().startsWith("-");
  return (
    <p className={cn(box, negative && "text-destructive")} data-kpi-value="">
      {text.replace("%", "")}
      <span className="font-medium text-[0.56em] tracking-normal">%</span>
    </p>
  );
}
