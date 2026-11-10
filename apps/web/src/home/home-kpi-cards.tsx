import { useCallback, useMemo, useState } from "react";
import { OnDemandSparkline } from "@/ui/charts/on-demand";
import {
  DeltaChip,
  HeroValue,
  KPI_GRID,
  type KpiRange,
  KpiTile,
  KpiTileSkeleton,
} from "@/ui/kpi-card";
import {
  isIncompleteEstimate,
  NO_KNOWN_COST_RESULT,
} from "../dashboard/dashboard-model";
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
  NOT_PROFIT_NOR_CASH,
  todaySeries,
  unknownDaysFit,
  unknownDaysText,
} from "./home-kpis";
import { chartValue, monthTitle } from "./home-model";
import type { HomeFigures } from "./use-home";

/**
 * The tiles of the Início: Vendas hoje, and the three of the month, Vendas, Resultado estimado and Ticket médio. Each is
 * about 92 px: the name with the (i), the number with the sparkline to its right, and one line of support. Passing the
 * pointer or dragging the finger over a sparkline, or the arrows on its keyboard control, reads one day: the number and the
 * count follow it, and the date takes the place of the chip. The three tiles of the month read the same
 * day together; "Vendas hoje" reads alone (its series is another). Leaving, everything goes back to today. On a phone
 * the tiles are one column, up to 759 px, and the sparklines are drawn finished, with no entrance; the reading by the
 * finger stays.
 */

/** No day: the same array on every render, so a copy without the series does not redo the memoized series. */
const NO_DAYS: readonly never[] = [];

const SPARK_HEIGHT = 36;

/** What the keyboard control says of a reading: "Até 17/10: R$ 1.926,30", with the amount hidden when asked. */
function spoken(prefix: string, reading: KpiReading, hidden: boolean): string {
  const amount =
    reading.value === null ? "sem valor" : formatBrlAmount(reading.value);
  const text = `${prefix}: ${amount}`;
  return hidden ? maskMoney(text, MASKED_SPOKEN) : text;
}

function chipOf(reading: KpiReading) {
  return reading.delta ? <DeltaChip delta={reading.delta} /> : undefined;
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

function TodayTile({
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
    valueText: spoken(reading.date || "Hoje", reading, hidden),
  };
  return (
    <KpiTile
      chip={chipOf(reading)}
      date={index === null ? undefined : reading.date || undefined}
      entity="sales"
      help={{ about: "Vendas hoje", text: reading.help }}
      id="home-today"
      note={reading.count}
      range={range}
      spark={
        <OnDemandSparkline
          color="var(--chart-sales)"
          domain="zero"
          height={SPARK_HEIGHT}
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

function resultWarning({
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
      {missing && unknownDaysFit(missing.unknown, missing.total) ? (
        <span data-kpi-unknown="">
          {unknownDaysText(missing.unknown, missing.total)}
        </span>
      ) : null}
    </>
  ) : null;
}

function MonthTiles({
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
    () => monthKpis(before, month, figures.today, cards, quality),
    [before, month, figures.today, cards, quality]
  );
  const [index, setIndex, clear] = useReading();
  const last = kpis.days.length - 1;
  const read = kpis.read(index);
  const until = `Até ${read.sales.date.replace("1 a ", "")}`;
  const date = index === null ? undefined : until;
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
  const name = monthTitle(figures.today).toLowerCase();
  // a month with no sale says so; a copy kept before the series existed has the totals only, nothing drawn
  const noSale = cards.salesCount === 0;
  const drawn = !noSale && kpis.days.length > 0;
  // the line is red when the result up to today is below zero: its color does not change while a day is read
  const resultNegative = (kpis.read(null).result.value ?? "")
    .trim()
    .startsWith("-");
  const incomplete =
    kpis.result.kind === "noCost" || isIncompleteEstimate(quality);
  const missing = kpis.result.kind === "incomplete" ? kpis.result : null;
  return (
    <>
      <KpiTile
        chip={chipOf(read.sales)}
        date={date}
        entity="sales"
        help={{ about: `Vendas em ${name}`, text: read.sales.help }}
        id="home-month"
        note={read.sales.count}
        {...(drawn
          ? {
              range: range(read.sales, `Vendas em ${name}, acumulado por dia`),
              spark: spark(kpis.series.sales, "var(--chart-sales)", "zero"),
            }
          : {})}
        title={`Vendas em ${name}`}
        value={<HeroValue amount={read.sales.value} />}
      />
      <KpiTile
        chip={chipOf(read.result)}
        date={date}
        entity="result"
        help={{
          about: "Resultado estimado",
          text: `${read.result.help} ${NOT_PROFIT_NOR_CASH}.`,
        }}
        id="home-result"
        warning={resultWarning({
          incomplete,
          missing,
          noCost: kpis.result.kind === "noCost",
        })}
        {...(kpis.series.result && drawn
          ? {
              range: range(
                read.result,
                "Resultado estimado, acumulado por dia"
              ),
              spark: spark(
                kpis.series.result,
                resultNegative ? "var(--destructive)" : "var(--chart-result)",
                kpis.series.result.some((value) => value < 0) ? "range" : "zero"
              ),
            }
          : {})}
        title={
          <a
            className="after:absolute after:inset-0 after:rounded-xl hover:underline hover:decoration-input hover:underline-offset-4 focus-visible:outline-none focus-visible:after:outline-3 focus-visible:after:outline-ring focus-visible:after:-outline-offset-3"
            href="/dashboard"
          >
            Resultado estimado
          </a>
        }
        value={<HeroValue amount={read.result.value} />}
      />
      <KpiTile
        chip={chipOf(read.ticket)}
        date={date}
        entity="ticket"
        help={{ about: "Ticket médio", text: read.ticket.help }}
        id="home-ticket"
        note={read.ticket.count || null}
        {...(drawn
          ? {
              range: range(read.ticket, "Ticket médio, por dia do mês"),
              spark: spark(kpis.series.ticket, "var(--chart-ticket)", "range"),
            }
          : {})}
        title="Ticket médio"
        value={<HeroValue amount={read.ticket.value} />}
      />
    </>
  );
}

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
    <div className={KPI_GRID} data-kpi-row="">
      {todayShown ? (
        <TodayTile figures={figures} still={still} />
      ) : (
        <KpiTile
          entity="sales"
          id="home-today"
          title="Vendas hoje"
          value={<p className="text-muted-foreground">Sem números de hoje</p>}
        />
      )}
      <MonthTiles figures={figures} still={still} />
    </div>
  );
}

export const NO_CONNECTION_NOTE = "Sem conexão";

/**
 * The four tiles without a connection and without a copy on the device (§ 7.4): in their places and with the height
 * they have with figures, each with its name, "—" (an unknown value is never a zero) and "Sem conexão". Nothing moves
 * when the connection goes or comes back.
 */
export function NoFiguresCards({ today }: { today: string }) {
  const name = monthTitle(today).toLowerCase();
  return (
    <div className={KPI_GRID} data-kpi-row="">
      <KpiTile
        entity="sales"
        id="home-today"
        note={NO_CONNECTION_NOTE}
        title="Vendas hoje"
        value={<HeroValue amount={null} />}
      />
      <KpiTile
        entity="sales"
        id="home-month"
        note={NO_CONNECTION_NOTE}
        title={`Vendas em ${name}`}
        value={<HeroValue amount={null} />}
      />
      <KpiTile
        entity="result"
        id="home-result"
        note={NO_CONNECTION_NOTE}
        title="Resultado estimado"
        value={<HeroValue amount={null} />}
      />
      <KpiTile
        entity="ticket"
        id="home-ticket"
        note={NO_CONNECTION_NOTE}
        title="Ticket médio"
        value={<HeroValue amount={null} />}
      />
    </div>
  );
}

/**
 * The four tiles while the figures are read: the shape of `KpiCards`, each with the rows it has with figures, so the
 * tiles that come take the same places.
 */
export function KpiCardsSkeleton() {
  return (
    <div className={KPI_GRID} data-kpi-row="">
      <KpiTileSkeleton />
      <KpiTileSkeleton />
      <KpiTileSkeleton />
      <KpiTileSkeleton />
    </div>
  );
}
