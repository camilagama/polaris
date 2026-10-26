import { useCallback, useMemo, useState } from "react";
import { OnDemandSparkline } from "@/ui/charts/on-demand";
import { DeltaChip, HeroValue, KpiCard, type KpiRange } from "@/ui/kpi-card";
import { isIncompleteEstimate } from "../dashboard/dashboard-model";
import { IncompleteBadge } from "../dashboard/result-cards";
import { formatBrlAmount } from "../lib/format";
import {
  MASKED_SPOKEN,
  maskMoney,
  useHiddenValues,
} from "../lib/hidden-values";
import { useIsMobile } from "../lib/use-mobile";
import {
  dayReading,
  type KpiReading,
  monthKpis,
  todaySeries,
  unknownDaysText,
} from "./home-kpis";
import { chartValue, monthTitle } from "./home-model";
import type { HomeFigures } from "./use-home";

/**
 * The row of four KPI cards of the Início (revisão de UI v7, § 3, items 2 to 6): Vendas hoje, Vendas no mês, Resultado
 * estimado and Ticket médio. Passing the pointer or dragging the finger over a sparkline, or the arrows on its
 * keyboard control, reads one day: the number, the date, the chip and the count follow it. The three cards of the
 * month read the same day together; "Vendas hoje" reads alone (its series is another). Leaving, everything goes back
 * to today. On a phone the sparklines are drawn finished, with no entrance; the reading by the finger stays.
 */

/** No day: the same array on every render, so a copy without the series does not redo the memoized series. */
const NO_DAYS: readonly never[] = [];

const LINK =
  "touch-hit focus-ring w-fit rounded-sm text-xs underline decoration-input underline-offset-4 hover:decoration-foreground";

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

function Chip({ reading }: { reading: KpiReading }) {
  return reading.delta ? <DeltaChip delta={reading.delta} /> : null;
}

/** The reading of a sparkline: the index read (null at rest), set by the pointer and by the keyboard control. */
function useReading(): [
  number | null,
  (index: number | null) => void,
  () => void,
] {
  const [index, setIndex] = useState<number | null>(null);
  const clear = useCallback(() => setIndex(null), []);
  return [index, setIndex, clear];
}

function TodayCard({
  figures,
  still,
}: {
  figures: HomeFigures;
  still: boolean;
}) {
  const [hidden] = useHiddenValues();
  const before = figures.before.daily ?? NO_DAYS;
  const month = figures.month.daily ?? NO_DAYS;
  const series = useMemo(
    () => todaySeries(before, month, figures.today),
    [before, month, figures.today]
  );
  const [index, setIndex, clear] = useReading();
  const last = series.length - 1;
  const day = series[index ?? last]?.date ?? figures.today;
  const reading = dayReading(before, month, day, figures.today);
  const values = useMemo(
    () => series.map((entry) => chartValue(entry.netSales)),
    [series]
  );
  const range: KpiRange = {
    label: "Vendas por dia, últimos 30 dias",
    max: last,
    onBlur: clear,
    onChange: setIndex,
    value: index ?? last,
    valueText: spoken(reading.date, reading, hidden),
  };
  return (
    <KpiCard
      chip={<Chip reading={reading} />}
      className="col-span-2 lg:col-span-1"
      date={reading.date}
      entity="sales"
      footer={reading.count}
      id="home-today"
      note={reading.note}
      range={range}
      spark={
        <OnDemandSparkline
          color="var(--chart-sales)"
          domain="zero"
          height={sparkHeight(still, false)}
          onRead={setIndex}
          readIndex={index}
          still={still}
          values={values}
        />
      }
      title="Vendas hoje"
      value={<HeroValue amount={reading.value} />}
    />
  );
}

/** The three cards of the month, reading the same day together. */
function MonthCards({
  figures,
  still,
}: {
  figures: HomeFigures;
  still: boolean;
}) {
  const [hidden] = useHiddenValues();
  const { cards, quality } = figures.month;
  const before = figures.before.daily ?? NO_DAYS;
  const month = figures.month.daily ?? NO_DAYS;
  const kpis = useMemo(
    () => monthKpis(before, month, figures.today, cards),
    [before, month, figures.today, cards]
  );
  const [index, setIndex, clear] = useReading();
  const last = kpis.days.length - 1;
  const read = kpis.read(index);
  const until = `Até ${read.sales.date.replace("1 a ", "")}`;
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
    color:
      | "var(--chart-sales)"
      | "var(--chart-result)"
      | "var(--chart-ticket)"
      | "var(--destructive)",
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
  const name = monthTitle(figures.today).toLowerCase();
  // a month with no sale says so; a copy kept before the series existed has the totals only, nothing drawn
  const noSale = cards.salesCount === 0;
  const drawn = !noSale && kpis.days.length > 0;
  // the line is red when the result up to today is below zero: its color does not change while a day is read
  const resultNegative = (kpis.read(null).result.value ?? "")
    .trim()
    .startsWith("-");
  const incomplete = isIncompleteEstimate(quality);
  return (
    <>
      <KpiCard
        action={
          noSale ? (
            <a className={LINK} href="/sales">
              Fazer uma venda
            </a>
          ) : null
        }
        chip={<Chip reading={read.sales} />}
        className="col-span-2 lg:col-span-1"
        date={read.sales.date}
        entity="sales"
        footer={noSale ? "Nenhuma venda este mês ainda" : read.sales.count}
        id="home-month"
        note={read.sales.note}
        {...(drawn
          ? {
              range: range(read.sales, `Vendas em ${name}, acumulado por dia`),
              spark: spark(
                kpis.series.sales,
                "var(--chart-sales)",
                "zero",
                false
              ),
            }
          : {})}
        title={`Vendas em ${name}`}
        value={<HeroValue amount={read.sales.value} />}
      />
      <KpiCard
        action={
          <a className={LINK} href="/dashboard">
            Ver o resultado
          </a>
        }
        chip={<Chip reading={read.result} />}
        compact
        date={read.result.date}
        entity="result"
        footer={
          <>
            {incomplete ? (
              <span className="mb-1 block">
                <IncompleteBadge />
              </span>
            ) : null}
            {read.result.count}
            {kpis.result.kind === "incomplete" ? (
              <span className="mt-1 block" data-kpi-unknown="">
                {unknownDaysText(kpis.result.unknown, kpis.result.total)}
              </span>
            ) : null}
          </>
        }
        id="home-result"
        note={read.result.note}
        {...(kpis.series.result && drawn
          ? {
              range: range(
                read.result,
                "Resultado estimado, acumulado por dia"
              ),
              spark: spark(
                kpis.series.result,
                resultNegative ? "var(--destructive)" : "var(--chart-result)",
                "range",
                true
              ),
            }
          : {})}
        title="Resultado estimado"
        value={<HeroValue amount={read.result.value} size="md" />}
      />
      <KpiCard
        chip={<Chip reading={read.ticket} />}
        compact
        date={read.ticket.date}
        entity="ticket"
        footer={read.ticket.count}
        id="home-ticket"
        note={read.ticket.note}
        {...(drawn
          ? {
              range: range(read.ticket, "Ticket médio, por dia do mês"),
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
    </>
  );
}

/** The four cards, in a row from 1024 px; on a phone Hoje and the month take the whole width, the other two share it. */
export function KpiCards({
  figures,
  todayShown = true,
}: {
  figures: HomeFigures;
  /** False when the figures are a copy of another day of the store (or have no series): never yesterday's as today's. */
  todayShown?: boolean;
}) {
  const still = useIsMobile();
  return (
    <div
      className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4"
      data-kpi-row=""
    >
      {todayShown ? (
        <TodayCard figures={figures} still={still} />
      ) : (
        <KpiCard
          className="col-span-2 lg:col-span-1"
          date=""
          entity="sales"
          id="home-today"
          title="Vendas hoje"
          value={
            <p className="text-muted-foreground">
              Sem números de hoje neste aparelho
            </p>
          }
        />
      )}
      <MonthCards figures={figures} still={still} />
    </div>
  );
}
