import ArrowRightIcon from "lucide-react/dist/esm/icons/arrow-right";
import { useCallback, useMemo, useState } from "react";
import { Badge } from "@/ui/badge";
import { OnDemandSparkline } from "@/ui/charts/on-demand";
import {
  DeltaChip,
  HeroPercent,
  HeroValue,
  KPI_STRIP,
  type KpiRange,
  KpiTile,
} from "@/ui/kpi-card";
import type { KpiReading } from "../home/home-kpis";
import { IncompleteSign, incompleteDetail } from "../home/home-kpi-cards";
import { salesCountText } from "../home/home-model";
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
  NO_SALES_UNTIL_DAY,
} from "./dashboard-model";
import {
  type MissingDays,
  type MissingInput,
  missingShort,
} from "./missing-input";
import { type ResultKpis, resultKpis, untilText } from "./result-kpis";
import { type Period, periodRangeLabel } from "./result-period";
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

/** What the margin says when no cost of the period is known (never a margin made of zero costs). */
const NO_COST_MARGIN = "Sem custo informado";

/** What the result says while a day with no cost is read, in place of the dash: the cause, not "sem valor". */
const NO_COST_DAY = (input: MissingInput) => `${missingShort(input)} neste dia`;

/**
 * What the result says in place of the dash when the day under the pointer is itself a day with no cost (undefined
 * otherwise): a month of a long period is not "this day", and a known day after an unknown one keeps its dash (its
 * running total is unknown, but its cost is not what is missing).
 */
export function noCostDayText(
  kpis: Pick<ResultKpis, "days" | "monthly" | "result">,
  index: number | null,
  noCost: boolean
): string | undefined {
  if (noCost || kpis.monthly || index === null) {
    return undefined;
  }
  const day = kpis.days[Math.min(index, kpis.days.length - 1)];
  return day?.operatingResult === null
    ? NO_COST_DAY(
        kpis.result.kind === "incomplete" ? kpis.result.input : "cost"
      )
    : undefined;
}

/**
 * The sign of an estimate that is not whole, on the one support line of the tile, and what it adds after the rest of the
 * line (the cause when no cost is known, else the days with no cost when they fit the words): a warning is not hidden.
 */
export function resultWarning({
  incomplete,
  missing,
  noCost,
}: {
  incomplete: boolean;
  missing: MissingDays | null;
  noCost: boolean;
}) {
  return incomplete
    ? {
        warning: <IncompleteSign />,
        warningDetail: incompleteDetail({ missing, noCost }),
      }
    : {};
}

/** No day: the same array on every render, so a copy without the series does not redo the memoized cards. */
const NO_DAYS: readonly never[] = [];

/**
 * What the keyboard control says of a reading: "Até 17/10: R$ 1.926,30", with the amount hidden when asked. A day with
 * no sale yet in a period that has sales says so after the amount, in the words of the support line.
 */
function spoken(prefix: string, reading: KpiReading, hidden: boolean): string {
  const amount =
    reading.value === null ? "sem valor" : formatBrlAmount(reading.value);
  const noSales =
    reading.count === NO_SALES_UNTIL_DAY ? `. ${NO_SALES_UNTIL_DAY}` : "";
  const text = `${prefix}: ${amount}${noSales}`;
  return hidden ? maskMoney(text, MASKED_SPOKEN) : text;
}

const SPARK_HEIGHT = 36;

/** A sparkline of fewer points than this says nothing: the tile ends with its text. */
const MIN_SPARK_POINTS = 3;

function chipOf(reading: KpiReading) {
  return reading.delta ? <DeltaChip delta={reading.delta} /> : undefined;
}

type SparkColor =
  | "var(--chart-sales)"
  | "var(--chart-result)"
  | "var(--chart-ticket)"
  | "var(--destructive)";

/**
 * The way from the sales card to the Histórico: the whole card is the target. The button is an arrow at the end of the
 * title row, and its `::after` covers the tile (the button stays static, so the cover is measured against the tile);
 * the (i) and the keyboard control of the sparkline stay above it (`z-10`), as the title of the Resultado card of the
 * Início does. Its name says what it opens and the dates, from the first day to today, the ones of the pill it opens.
 * The count on the support line is text, as on the Início, so the line stays one line.
 */
function SalesCover({
  count,
  onOpen,
  period,
  today,
}: {
  count: number;
  onOpen: (period: Period) => void;
  period: Period;
  today: string;
}) {
  const label = count === 1 ? "Ver a venda" : `Ver as ${salesCountText(count)}`;
  const handleClick = useCallback(() => onOpen(period), [onOpen, period]);
  return (
    <button
      aria-label={`${label} de ${periodRangeLabel(period, today)} no Histórico`}
      className="focus-ring -my-1 inline-flex size-6 touch:size-11 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground after:absolute after:inset-0 after:rounded-xl hover:text-foreground focus-visible:-outline-offset-2"
      data-kpi-sales-link=""
      onClick={handleClick}
      type="button"
    >
      <ArrowRightIcon aria-hidden="true" className="size-4" />
    </button>
  );
}

/**
 * The cover of the sales card when the count is the server's for the whole period (none while a day is read on the
 * sparkline, whose count is another, nor with no sale, no connection or a copy of the device). The period is from its
 * first day to today, since nothing is sold after it.
 */
function salesCover({
  count,
  onOpen,
  period,
  reading,
  today,
}: {
  count: number;
  onOpen: ((period: Period) => void) | null;
  period: Period;
  reading: boolean;
  today: string;
}) {
  const to = period.to < today ? period.to : today;
  if (onOpen && !reading && count > 0 && period.from <= to) {
    return (
      <SalesCover
        count={count}
        onOpen={onOpen}
        period={{ from: period.from, to }}
        today={today}
      />
    );
  }
  return null;
}

interface ResultCardsProps {
  /** The days of the period before, read for the chips; null while not read (or not readable): no chip. */
  comparison: ComparisonDays | null;
  /** Opens the Histórico on the period of the sales card; null: the count stays text (no connection, or not the server's figures). */
  onOpenSales: ((period: Period) => void) | null;
  /** The same days as `dailySales` read them: the chips of sales and ticket; null while not read (or not readable). */
  salesComparison: ComparisonSales | null;
  summary: StoredPeriodSummary;
  today: string;
}

/** The cards of the Resultado, with the day under the pointer kept here. */
export function ResultCards(props: ResultCardsProps) {
  const [index, setIndex] = useState<number | null>(null);
  return <ResultCardsView {...props} index={index} onIndex={setIndex} />;
}

/**
 * The sparklines of sales, ticket and result read the same day together, and the date of the day read takes the place of
 * the chip. The result has its sparkline and chip only when every day up to today has a known cost (AC-9). With no cost
 * of the goods known (`cogsCoverageOf` is "none") the server's figures are the sales, never an estimate, so the result
 * and the margin show a dash and the badge.
 */
export function ResultCardsView({
  comparison,
  index,
  onIndex,
  onOpenSales,
  salesComparison,
  summary,
  today,
}: ResultCardsProps & {
  index: number | null;
  onIndex: (index: number | null) => void;
}) {
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
        quality,
        today,
      }),
    [cards, comparison, daily, quality, salesComparison, summary.period, today]
  );
  const clear = useCallback(() => onIndex(null), [onIndex]);
  const last = kpis.days.length - 1;
  const read = kpis.read(index);
  const until = untilText(kpis.days[Math.min(index ?? last, last)], today);
  const date = index === null ? undefined : until;
  const unit = kpis.monthly ? "mês" : "dia";
  const salesName = kpis.month ? `Vendas em ${kpis.month}` : "Vendas líquidas";
  const range = (reading: KpiReading, label: string): KpiRange => ({
    label,
    max: last,
    onBlur: clear,
    onChange: onIndex,
    value: index ?? last,
    valueText: spoken(until, reading, hidden),
  });
  const spark = (
    values: number[],
    color: SparkColor,
    domain: "range" | "zero"
  ) => (
    <OnDemandSparkline
      color={color}
      domain={domain}
      height={SPARK_HEIGHT}
      onRead={onIndex}
      readIndex={index}
      still={still}
      values={values}
    />
  );
  // a copy kept before the series existed has the totals only
  const drawn = cards.salesCount > 0 && kpis.days.length >= MIN_SPARK_POINTS;
  // no cost of the goods known: the server's margin and result are the sales, so the two cards say so, with no number
  const noCost = cogsCoverageOf(quality) === "none";
  const incomplete =
    noCost ||
    isIncompleteEstimate(quality) ||
    kpis.result.kind === "incomplete";
  const resultNegative = (kpis.read(null).result.value ?? "")
    .trim()
    .startsWith("-");
  const missing = kpis.result.kind === "incomplete" ? kpis.result : null;
  return (
    <div className={KPI_STRIP} data-kpi-row="">
      <KpiTile
        chip={noCost ? undefined : chipOf(read.result)}
        date={date}
        entity="result"
        help={{ about: "Resultado estimado", text: read.result.help }}
        id="result-kpi-result"
        strip
        {...resultWarning({ incomplete, missing, noCost })}
        {...(kpis.series.result && drawn && !noCost
          ? {
              range: range(
                read.result,
                `Resultado estimado, acumulado por ${unit}`
              ),
              spark: spark(
                kpis.series.result,
                resultNegative ? "var(--destructive)" : "var(--chart-result)",
                kpis.series.result.some((value) => value < 0) ? "range" : "zero"
              ),
            }
          : {})}
        title="Resultado estimado"
        value={
          <HeroValue
            amount={noCost ? null : read.result.value}
            emptyText={noCostDayText(kpis, index, noCost)}
            reading={index !== null}
            tile
          />
        }
      />
      <KpiTile
        chip={chipOf(read.sales)}
        date={date}
        entity="sales"
        help={{
          about: salesName,
          text: `${read.sales.help} ${read.sales.count}.`,
        }}
        id="result-kpi-sales"
        cover={salesCover({
          count: cards.salesCount,
          onOpen: onOpenSales,
          period: summary.period,
          reading: index !== null,
          today,
        })}
        oneLine
        warningDetail={read.sales.count}
        strip
        {...(drawn
          ? {
              range: range(read.sales, `${salesName}, acumulado por ${unit}`),
              spark: spark(kpis.series.sales, "var(--chart-sales)", "zero"),
            }
          : {})}
        title={salesName}
        value={
          <HeroValue amount={read.sales.value} reading={index !== null} tile />
        }
      />
      <KpiTile
        chip={chipOf(read.ticket)}
        date={date}
        entity="ticket"
        help={{ about: "Ticket médio", text: read.ticket.help }}
        id="result-kpi-ticket"
        note={read.ticket.count || null}
        strip
        {...(drawn
          ? {
              range: range(read.ticket, `Ticket médio, por ${unit} do período`),
              spark: spark(kpis.series.ticket, "var(--chart-ticket)", "range"),
            }
          : {})}
        title="Ticket médio"
        value={
          <HeroValue amount={read.ticket.value} reading={index !== null} tile />
        }
      />
      <MarginCard
        incomplete={incomplete}
        noCost={noCost}
        percent={cards.marginPercent}
      />
    </div>
  );
}

function MarginCard({
  incomplete,
  noCost,
  percent,
}: {
  incomplete: boolean;
  noCost: boolean;
  percent: string | null;
}) {
  return (
    <KpiTile
      entity="result"
      help={{
        about: "Margem",
        text: "Resultado estimado dividido pelas vendas líquidas do período.",
      }}
      id="result-kpi-margin"
      {...(noCost ? { note: NO_COST_MARGIN } : {})}
      strip
      title="Margem"
      value={
        <HeroPercent
          text={
            noCost || percent === null ? null : formatPercentOrDash(percent)
          }
        />
      }
      warning={incomplete ? <IncompleteSign /> : null}
    />
  );
}
