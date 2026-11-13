import ArrowRightIcon from "lucide-react/dist/esm/icons/arrow-right";
import { useCallback, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
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
import {
  type KpiReading,
  unknownDaysFit,
  unknownDaysText,
} from "../home/home-kpis";
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
  NO_KNOWN_COST_RESULT,
} from "./dashboard-model";
import { resultKpis, untilText } from "./result-kpis";
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
const NO_COST_DAY = "sem custo neste dia";

/**
 * What the result says in place of the dash when the day under the pointer is itself a day with no cost (undefined
 * otherwise): a month of a long period is not "this day", and a known day after an unknown one keeps its dash (its
 * running total is unknown, but its cost is not what is missing).
 */
export function noCostDayText(
  kpis: {
    days: readonly { operatingResult?: string | null }[];
    monthly: boolean;
  },
  index: number | null,
  noCost: boolean
): string | undefined {
  if (noCost || kpis.monthly || index === null) {
    return undefined;
  }
  const day = kpis.days[Math.min(index, kpis.days.length - 1)];
  return day?.operatingResult === null ? NO_COST_DAY : undefined;
}

/**
 * The warning of an estimate that is not whole, on a row of its own under the support line of the tile (the badge, the
 * cause when no cost is known, and the days with no cost beside it when the line fits: a warning is not hidden).
 */
export function resultWarning({
  incomplete,
  missing,
  noCost,
}: {
  incomplete: boolean;
  missing: { total: number; unknown: number } | null;
  noCost: boolean;
}) {
  return incomplete ? (
    <>
      <IncompleteBadge />
      {noCost ? <span data-kpi-no-cost="">{NO_KNOWN_COST_RESULT}</span> : null}
      {!noCost && missing && unknownDaysFit(missing.unknown, missing.total) ? (
        <span data-kpi-unknown="">
          {unknownDaysText(missing.unknown, missing.total)}
        </span>
      ) : null}
    </>
  ) : null;
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

const LINK_CLASS =
  "touch-hit focus-ring -my-1 inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-sm font-medium text-foreground hover:underline";
const LINK_ARROW = "@min-[11.5rem]:block hidden size-4";

/**
 * "Ver as 8 vendas" on the support line of the sales card, in the place of the count: a text button with an arrow, no
 * underline and no outline, whose name says the dates and where it goes. With the comparison chip it takes a line of
 * its own under the chip, on the left, and the tile grows by that line; without the chip it stays on the support line.
 * The box is 24 px tall in a 20 px line (negative margin), the least a target may have; the arrow goes first when the
 * tile is narrower than the words need (320 px with the letter at 20 px).
 */
function SalesLink({
  count,
  onOpen,
  period,
  today,
  underChip,
}: {
  count: number;
  onOpen: (period: Period) => void;
  period: Period;
  today: string;
  underChip: boolean;
}) {
  const label = count === 1 ? "Ver a venda" : `Ver as ${salesCountText(count)}`;
  const handleClick = useCallback(() => onOpen(period), [onOpen, period]);
  return (
    <>
      {underChip ? (
        <span aria-hidden="true" className="h-0 basis-full" />
      ) : null}
      <button
        aria-label={`${label} de ${periodRangeLabel(period, today)} no Histórico`}
        className={LINK_CLASS}
        data-kpi-sales-link=""
        onClick={handleClick}
        type="button"
      >
        {label}
        <ArrowRightIcon aria-hidden="true" className={LINK_ARROW} />
      </button>
    </>
  );
}

/**
 * What the support line of the sales card says of the count: the link to the Histórico when the count is the server's
 * for the whole period (none while a day is read on the sparkline, whose count is another), the text otherwise. The
 * period is from its first day to today, since nothing is sold after it. With the comparison chip the link or the text
 * is always on the line under it, so the tile has the same height with or without sales, with or without connection,
 * and while a day is read (the date is 4 px shorter than the chip, and the text line makes it up).
 */
function salesNote({
  chip,
  count,
  onOpen,
  period,
  reading,
  text,
  today,
}: {
  chip: boolean;
  count: number;
  onOpen: ((period: Period) => void) | null;
  period: Period;
  reading: boolean;
  text: string;
  today: string;
}) {
  const to = period.to < today ? period.to : today;
  if (onOpen && !reading && count > 0 && period.from <= to) {
    return (
      <SalesLink
        count={count}
        onOpen={onOpen}
        period={{ from: period.from, to }}
        today={today}
        underChip={chip}
      />
    );
  }
  return chip ? (
    <span className={cn("flex basis-full items-center", reading && "min-h-5")}>
      {text}
    </span>
  ) : (
    text
  );
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

/**
 * The sparklines of sales, ticket and result read the same day together, and the date of the day read takes the place of
 * the chip. The result has its sparkline and chip only when every day up to today has a known cost (AC-9). With no cost
 * of the goods known (`cogsCoverageOf` is "none") the server's figures are the sales, never an estimate, so the result
 * and the margin show a dash and the badge.
 */
export function ResultCards({
  comparison,
  onOpenSales,
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
  const until = untilText(kpis.days[Math.min(index ?? last, last)], today);
  const date = index === null ? undefined : until;
  const unit = kpis.monthly ? "mês" : "dia";
  const salesName = kpis.month ? `Vendas em ${kpis.month}` : "Vendas líquidas";
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
    domain: "range" | "zero"
  ) => (
    <OnDemandSparkline
      color={color}
      domain={domain}
      height={SPARK_HEIGHT}
      onRead={setIndex}
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
        notice={resultWarning({ incomplete, missing, noCost })}
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
        help={{ about: salesName, text: read.sales.help }}
        id="result-kpi-sales"
        note={salesNote({
          chip: Boolean(kpis.read(null).sales.delta),
          count: cards.salesCount,
          onOpen: onOpenSales,
          period: summary.period,
          reading: index !== null,
          text: read.sales.count,
          today,
        })}
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
      notice={incomplete ? <IncompleteBadge /> : null}
    />
  );
}
