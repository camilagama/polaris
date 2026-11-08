import ChevronRightIcon from "lucide-react/dist/esm/icons/chevron-right";
import { useCallback, useMemo, useState } from "react";
import { OnDemandSparkline } from "@/ui/charts/on-demand";
import { Skeleton } from "@/ui/skeleton";
import {
  DeltaChip,
  HeroValue,
  KPI_GRID,
  KpiCard,
  KpiCardSkeleton,
  KpiGroup,
  type KpiRange,
} from "@/ui/kpi-card";
import { isIncompleteEstimate } from "../dashboard/dashboard-model";
import { ResultFooter } from "../dashboard/result-cards";
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
  rangeText,
  todaySeries,
} from "./home-kpis";
import { chartValue, firstOfMonth, monthTitle } from "./home-model";
import type { HomeFigures } from "./use-home";

/**
 * The cards of the Início (revisão de UI v7, § 3, items 2 to 6): Vendas hoje, and the three of the month, Vendas,
 * Resultado estimado and Ticket médio, under one line that says the month and its period once ("Outubro · 1 a 23/10").
 * Passing the pointer or dragging the finger over a sparkline, or the arrows on its keyboard control, reads one day: the
 * number, the date, the chip and the count follow it. The three cards of the month read the same day together; "Vendas
 * hoje" reads alone (its series is another). Leaving, everything goes back to today. On a phone the cards are one
 * column, up to 759 px, and the sparklines are drawn finished, with no entrance; the reading by the finger stays.
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

/** The height of a sparkline: 64 px from 760 px, 52 on a phone. */
function sparkHeight(still: boolean): number {
  return still ? 52 : 64;
}

/** The date of the result card when it is not the period of the group, which its group already says. */
function ownDate(read: {
  result: KpiReading;
  sales: KpiReading;
}): string | undefined {
  return read.result.date === read.sales.date ? undefined : read.result.date;
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
    valueText: spoken(reading.date || "Hoje", reading, hidden),
  };
  // one line of support: what it compares with, and the count ("vs. média das sextas · 2 vendas")
  const support = [reading.note, reading.count].filter(Boolean).join(" · ");
  return (
    <KpiCard
      chip={<Chip reading={reading} />}
      className="md:col-span-2 lg:col-span-1 lg:col-start-1 lg:row-start-2"
      date={reading.date}
      entity="sales"
      help={{ about: "Vendas hoje", text: reading.help }}
      id="home-today"
      note={support}
      noteLines={2}
      range={range}
      spark={
        <OnDemandSparkline
          color="var(--chart-sales)"
          domain="zero"
          height={sparkHeight(still)}
          onRead={setIndex}
          readIndex={index}
          still={still}
          values={values}
        />
      }
      title="Vendas hoje"
      value={<HeroValue amount={reading.value} size="xl" />}
    />
  );
}

/** The three cards of the month, reading the same day together, under the line that names the month and its period. */
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
    () => monthKpis(before, month, figures.today, cards, quality),
    [before, month, figures.today, cards, quality]
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
    domain: "range" | "zero"
  ) => (
    <OnDemandSparkline
      color={color}
      domain={domain}
      height={sparkHeight(still)}
      onRead={setIndex}
      readIndex={index}
      still={still}
      values={values}
    />
  );
  const title = monthTitle(figures.today);
  const name = title.toLowerCase();
  // a month with no sale says so; a copy kept before the series existed has the totals only, nothing drawn
  const noSale = cards.salesCount === 0;
  const drawn = !noSale && kpis.days.length > 0;
  // the line is red when the result up to today is below zero: its color does not change while a day is read
  const resultNegative = (kpis.read(null).result.value ?? "")
    .trim()
    .startsWith("-");
  const incomplete =
    kpis.result.kind === "noCost" || isIncompleteEstimate(quality);
  // the result card has a date of its own only when it is not the period of the group ("outubro inteiro")
  const resultDate = ownDate(read);
  const rest = kpis.read(null);
  const resultDateAtRest = ownDate(rest);
  return (
    <KpiGroup
      className="md:col-span-2 lg:col-span-3 lg:col-start-2 lg:row-start-1"
      period={read.sales.date}
      title={title}
    >
      <KpiCard
        action={
          noSale ? (
            <a className={LINK} href="/sales">
              Fazer uma venda
            </a>
          ) : null
        }
        chip={<Chip reading={read.sales} />}
        className="md:col-span-2 lg:col-span-1 lg:col-start-2 lg:row-start-2"
        entity="sales"
        help={{ about: "Vendas", text: read.sales.help }}
        id="home-month"
        note={read.sales.count}
        {...(drawn
          ? {
              range: range(read.sales, `Vendas em ${name}, acumulado por dia`),
              spark: spark(kpis.series.sales, "var(--chart-sales)", "zero"),
            }
          : {})}
        title={
          <>
            Vendas<span className="sr-only"> em {name}</span>
          </>
        }
        value={<HeroValue amount={read.sales.value} />}
      />
      <KpiCard
        action={
          <a className={`${LINK} inline-flex items-center`} href="/dashboard">
            Ver o resultado
            <ChevronRightIcon aria-hidden="true" className="size-3" />
          </a>
        }
        chip={<Chip reading={read.result} />}
        className="lg:col-start-3 lg:row-start-2"
        {...(resultDate ? { date: resultDate } : {})}
        {...(resultDateAtRest ? { dateReserve: resultDateAtRest } : {})}
        entity="result"
        footer={
          <ResultFooter
            incomplete={incomplete}
            line={read.result.count}
            missing={kpis.result.kind === "incomplete" ? kpis.result : null}
            noCost={kpis.result.kind === "noCost"}
          />
        }
        help={{ about: "Resultado estimado", text: read.result.help }}
        id="home-result"
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
        title="Resultado estimado"
        value={<HeroValue amount={read.result.value} />}
      />
      <KpiCard
        chip={<Chip reading={read.ticket} />}
        className="lg:col-start-4 lg:row-start-2"
        entity="ticket"
        footer={read.ticket.count || null}
        help={{ about: "Ticket médio", text: read.ticket.help }}
        id="home-ticket"
        {...(drawn
          ? {
              range: range(read.ticket, "Ticket médio, por dia do mês"),
              spark: spark(kpis.series.ticket, "var(--chart-ticket)", "range"),
            }
          : {})}
        title="Ticket médio"
        value={<HeroValue amount={read.ticket.value} />}
      />
    </KpiGroup>
  );
}

/** The four cards, in a row from 1024 px; up to 759 px one column, and from there Hoje and Vendas take the row each. */
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
        <TodayCard figures={figures} still={still} />
      ) : (
        <KpiCard
          className="md:col-span-2 lg:col-span-1 lg:col-start-1 lg:row-start-2"
          entity="sales"
          id="home-today"
          noteLines={2}
          title="Vendas hoje"
          value={<p className="text-muted-foreground">Sem números de hoje</p>}
        />
      )}
      <MonthCards figures={figures} still={still} />
    </div>
  );
}

/** The text of each card without a connection and without a copy: the reason is said once, in the line under the title. */
export const NO_CONNECTION_NOTE = "Sem conexão";

/** The place of a sparkline, empty: a card without figures keeps the height it has with them. */
const EMPTY_SPARK = <span aria-hidden="true" />;

const EMPTY_ACTION = <span aria-hidden="true" className="block h-4" />;

/**
 * The four cards without a connection and without a copy on the device (§ 7.4): in their places and with the height
 * they have with figures (the support line, the foot, the link and the sparkline kept empty), each with its name, "—"
 * (an unknown value is never a zero) and "Sem conexão". Nothing moves when the connection goes or comes back.
 */
export function NoFiguresCards({ today }: { today: string }) {
  const title = monthTitle(today);
  const name = title.toLowerCase();
  const empty = <HeroValue amount={null} />;
  return (
    <div className={KPI_GRID} data-kpi-row="">
      <KpiCard
        className="md:col-span-2 lg:col-span-1 lg:col-start-1 lg:row-start-2"
        entity="sales"
        id="home-today"
        note={NO_CONNECTION_NOTE}
        noteLines={2}
        spark={EMPTY_SPARK}
        title="Vendas hoje"
        value={<HeroValue amount={null} size="xl" />}
      />
      <KpiGroup
        className="md:col-span-2 lg:col-span-3 lg:col-start-2 lg:row-start-1"
        period={rangeText(firstOfMonth(today), today)}
        title={title}
      >
        <KpiCard
          className="md:col-span-2 lg:col-span-1 lg:col-start-2 lg:row-start-2"
          entity="sales"
          id="home-month"
          note={NO_CONNECTION_NOTE}
          spark={EMPTY_SPARK}
          title={
            <>
              Vendas<span className="sr-only"> em {name}</span>
            </>
          }
          value={empty}
        />
        <KpiCard
          action={EMPTY_ACTION}
          className="lg:col-start-3 lg:row-start-2"
          entity="result"
          footer={null}
          id="home-result"
          note={NO_CONNECTION_NOTE}
          spark={EMPTY_SPARK}
          title="Resultado estimado"
          value={<HeroValue amount={null} />}
        />
        <KpiCard
          className="lg:col-start-4 lg:row-start-2"
          entity="ticket"
          footer={null}
          id="home-ticket"
          note={NO_CONNECTION_NOTE}
          spark={EMPTY_SPARK}
          title="Ticket médio"
          value={<HeroValue amount={null} />}
        />
      </KpiGroup>
    </div>
  );
}

/**
 * The four cards while the figures are read: the shape of `KpiCards` (Hoje, the line of the month and its three cards,
 * each with the rows it has with figures), so the cards that come take the same places.
 */
export function KpiCardsSkeleton() {
  return (
    <div className={KPI_GRID} data-kpi-row="">
      <KpiCardSkeleton
        className="md:col-span-2 lg:col-span-1 lg:col-start-1 lg:row-start-2"
        noteLines={2}
        size="xl"
      />
      <div
        aria-hidden="true"
        className="flex h-[1.125rem] items-center md:col-span-2 lg:col-span-3 lg:col-start-2 lg:row-start-1"
      >
        <Skeleton className="h-3 w-28" />
      </div>
      <KpiCardSkeleton className="md:col-span-2 lg:col-span-1 lg:col-start-2 lg:row-start-2" />
      <KpiCardSkeleton
        action
        className="lg:col-start-3 lg:row-start-2"
        footer={1}
      />
      <KpiCardSkeleton className="lg:col-start-4 lg:row-start-2" footer={1} />
    </div>
  );
}
