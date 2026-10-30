import ChevronRightIcon from "lucide-react/dist/esm/icons/chevron-right";
import { useCallback, useMemo, useState } from "react";
import { OnDemandSparkline } from "@/ui/charts/on-demand";
import {
  DeltaChip,
  HeroValue,
  KPI_GRID,
  KpiCard,
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
  todaySeries,
} from "./home-kpis";
import { chartValue, monthTitle } from "./home-model";
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
      value={<HeroValue amount={reading.value} />}
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
  const resultDate =
    read.result.date === read.sales.date ? undefined : read.result.date;
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
                "range"
              ),
            }
          : {})}
        title="Resultado estimado"
        value={<HeroValue amount={read.result.value} size="md" />}
      />
      <KpiCard
        chip={<Chip reading={read.ticket} />}
        className="lg:col-start-4 lg:row-start-2"
        entity="ticket"
        {...(read.ticket.count ? { footer: read.ticket.count } : {})}
        help={{ about: "Ticket médio", text: read.ticket.help }}
        id="home-ticket"
        {...(drawn
          ? {
              range: range(read.ticket, "Ticket médio, por dia do mês"),
              spark: spark(kpis.series.ticket, "var(--chart-ticket)", "range"),
            }
          : {})}
        title="Ticket médio"
        value={<HeroValue amount={read.ticket.value} size="md" />}
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
          title="Vendas hoje"
          value={<p className="text-muted-foreground">Sem números de hoje</p>}
        />
      )}
      <MonthCards figures={figures} still={still} />
    </div>
  );
}
