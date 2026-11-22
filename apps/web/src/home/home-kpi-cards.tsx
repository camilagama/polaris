import TriangleAlertIcon from "lucide-react/dist/esm/icons/triangle-alert";
import { useCallback, useMemo, useState } from "react";
import { OnDemandSparkline } from "@/ui/charts/on-demand";
import {
  DeltaChip,
  HeroValue,
  KPI_STRIP_THREE,
  type KpiRange,
  KpiTile,
  KpiTileSkeleton,
} from "@/ui/kpi-card";
import {
  isIncompleteEstimate,
  NO_SALES_UNTIL_DAY,
} from "../dashboard/dashboard-model";
import type { MissingDays } from "../dashboard/missing-input";
import { resultKpis, untilText } from "../dashboard/result-kpis";
import type {
  ComparisonDays,
  ComparisonSales,
} from "../dashboard/use-period-summary";
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
  dayReading,
  type KpiReading,
  type MonthKpis,
  monthKpis,
  todaySeries,
  unknownDaysFit,
  unknownDaysText,
} from "./home-kpis";
import { chartValue, monthTitle } from "./home-model";
import type { HomeFigures } from "./use-home";

/**
 * The tiles of the Início: Vendas hoje, the hero, alone on its line and as wide as the page, and the three of the month,
 * Vendas, Resultado estimado and Ticket médio, under the line of the period. Each is about 92 px (the hero a little
 * more, its number a step up): the name with the (i), the number with the sparkline to its right, and one line of support. Passing the
 * pointer or dragging the finger over a sparkline, or the arrows on its keyboard control, reads one day: the number and the
 * count follow it, and the date takes the place of the chip. The three tiles of the month read the same
 * day together; "Vendas hoje" reads alone (its series is another). Leaving, everything goes back to today. The three of
 * the month are one column up to 1023 px, three columns from there and one strip from 1280 px; on a phone the sparklines are drawn finished, with no entrance; the reading by the
 * finger stays.
 */

/** No day: the same array on every render, so a copy without the series does not redo the memoized series. */
const NO_DAYS: readonly never[] = [];

const SPARK_HEIGHT = 36;

const START_SALE_LINK =
  "touch-hit focus-ring w-fit rounded-sm text-xs underline decoration-input underline-offset-4 hover:decoration-foreground";

/**
 * What the keyboard control says of a reading: "Até 17/10: R$ 1.926,30", with the amount hidden when asked. A day with
 * no sale yet in a month that has sales says so after the amount, in the words of the support line.
 */
function spoken(prefix: string, reading: KpiReading, hidden: boolean): string {
  const amount =
    reading.value === null ? "sem valor" : formatBrlAmount(reading.value);
  const noSales =
    reading.count === NO_SALES_UNTIL_DAY ? `. ${NO_SALES_UNTIL_DAY}` : "";
  const text = `${prefix}: ${amount}${noSales}`;
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
      hero
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
      value={
        <HeroValue
          amount={reading.value}
          reading={index !== null}
          size="xl"
          tile
        />
      }
    />
  );
}

/** The sign of an estimate that is not whole, always in sight on the support line of the Resultado. */
function IncompleteSign() {
  return (
    <span
      className="inline-flex items-center gap-1 font-medium text-warning"
      data-kpi-incomplete=""
    >
      <TriangleAlertIcon aria-hidden="true" className="size-3 shrink-0" />
      Incompleta
    </span>
  );
}

/** What the sign adds, after the rest of the line: the cause when no cost is known, else the days with no cost, when they fit the words. */
function incompleteDetail({
  missing,
  noCost,
}: {
  missing: MissingDays | null;
  noCost: boolean;
}) {
  if (noCost) {
    return (
      <>
        <span aria-hidden="true">· </span>
        <span data-kpi-no-cost="">
          Sem custo informado
          <span className="sr-only">: não dá para estimar.</span>
        </span>
      </>
    );
  }
  return missing && unknownDaysFit(missing) ? (
    <>
      <span aria-hidden="true">· </span>
      <span data-kpi-unknown="">{unknownDaysText(missing)}</span>
    </>
  ) : null;
}

/** What the three tiles of the month are made of: the month of today's figures, or the period the person chose. */
export type MonthSource =
  | { figures: HomeFigures; kind: "month" }
  | PeriodSource;

export interface PeriodSource {
  comparison: ComparisonDays | null;
  kind: "period";
  salesComparison: ComparisonSales | null;
  summary: StoredPeriodSummary;
  today: string;
}

/** The tiles' model in the shape both sources give: the readings, the drawings, and the words that name the period. */
interface MonthModel {
  cards: StoredPeriodSummary["cards"];
  kpis: Pick<MonthKpis, "days" | "read" | "series" | "result">;
  labels: { result: string; sales: string; ticket: string };
  noCost: boolean;
  /** "em outubro", or "do período": what the tile of Vendas is of, in the words read after its title. */
  of: string;
  /** The result has days with no cost informed: the month of today says it by its quality line, a period by its days. */
  partialDays: boolean;
  quality: StoredPeriodSummary["quality"];
  until: (read: KpiReading, index: number | null) => string;
}

function monthModel(figures: HomeFigures): MonthModel {
  const { cards, quality } = figures.month;
  const before = figures.before.daily ?? NO_DAYS;
  const month = figures.month.daily ?? NO_DAYS;
  const kpis = monthKpis(before, month, figures.today, cards, quality);
  const name = monthTitle(figures.today).toLowerCase();
  return {
    cards,
    kpis,
    labels: {
      result: "Resultado estimado, acumulado por dia",
      sales: `Vendas em ${name}, acumulado por dia`,
      ticket: "Ticket médio, por dia do mês",
    },
    noCost: kpis.result.kind === "noCost",
    of: `em ${name}`,
    partialDays: false,
    quality,
    until: (read) => `Até ${read.date.replace("1 a ", "")}`,
  };
}

function periodModel(source: PeriodSource): MonthModel {
  const { comparison, salesComparison, summary, today } = source;
  const { cards, quality } = summary;
  const kpis = resultKpis({
    cards,
    daily: summary.daily ?? NO_DAYS,
    period: summary.period,
    previous: comparison,
    previousSales: salesComparison,
    quality,
    today,
  });
  const unit = kpis.monthly ? "mês" : "dia";
  return {
    cards,
    kpis,
    labels: {
      result: `Resultado estimado, acumulado por ${unit}`,
      sales: `Vendas do período, acumulado por ${unit}`,
      ticket: `Ticket médio, por ${unit} do período`,
    },
    noCost: cogsCoverageOf(quality) === "none",
    of: kpis.month ? `em ${kpis.month}` : "do período",
    partialDays: kpis.result.kind === "incomplete",
    quality,
    until: (_read, index) =>
      untilText(
        kpis.days[
          Math.min(index ?? kpis.days.length - 1, kpis.days.length - 1)
        ],
        today
      ),
  };
}

function MonthTiles({
  clear,
  index,
  model,
  setIndex,
  still,
}: {
  clear: () => void;
  index: number | null;
  model: MonthModel;
  setIndex: (index: number | null) => void;
  still: boolean;
}) {
  const [hidden] = useHiddenValues();
  const { cards, kpis, noCost, quality } = model;
  const last = kpis.days.length - 1;
  const read = kpis.read(index);
  const until = model.until(read.sales, index);
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
  // a month with no sale says so; a copy kept before the series existed has the totals only, nothing drawn
  const noSale = cards.salesCount === 0;
  const drawn = !noSale && kpis.days.length > 0;
  // the line is red when the result up to today is below zero: its color does not change while a day is read
  const resultNegative = (kpis.read(null).result.value ?? "")
    .trim()
    .startsWith("-");
  const incomplete =
    noCost || isIncompleteEstimate(quality) || model.partialDays;
  const missing = kpis.result.kind === "incomplete" ? kpis.result : null;
  return (
    <>
      <KpiTile
        action={
          noSale ? (
            <a className={START_SALE_LINK} href="/sales">
              Fazer uma venda
            </a>
          ) : null
        }
        chip={chipOf(read.sales)}
        date={date}
        entity="sales"
        help={{ about: `Vendas ${model.of}`, text: read.sales.help }}
        id="home-month"
        strip
        note={read.sales.count}
        {...(drawn
          ? {
              range: range(read.sales, model.labels.sales),
              spark: spark(kpis.series.sales, "var(--chart-sales)", "zero"),
            }
          : {})}
        title={`Vendas ${model.of}`}
        value={
          <HeroValue amount={read.sales.value} reading={index !== null} tile />
        }
      />
      <KpiTile
        chip={noCost ? undefined : chipOf(read.result)}
        date={date}
        entity="result"
        help={{
          about: "Resultado estimado",
          text: read.result.help,
        }}
        id="home-result"
        strip
        warning={incomplete ? <IncompleteSign /> : null}
        warningDetail={
          incomplete ? incompleteDetail({ missing, noCost }) : null
        }
        {...(kpis.series.result && drawn && !noCost
          ? {
              range: range(read.result, model.labels.result),
              spark: spark(
                kpis.series.result,
                resultNegative ? "var(--destructive)" : "var(--chart-result)",
                kpis.series.result.some((value) => value < 0) ? "range" : "zero"
              ),
            }
          : {})}
        title={
          <a
            className="focus-ring touch:flex touch:min-h-11 touch:items-center rounded-sm after:absolute after:inset-0 after:rounded-xl hover:underline hover:decoration-input hover:underline-offset-4 touch:focus-visible:-outline-offset-3"
            href="/dashboard"
          >
            Resultado estimado
          </a>
        }
        value={
          <HeroValue
            amount={noCost ? null : read.result.value}
            reading={index !== null}
            tile
          />
        }
      />
      <KpiTile
        chip={chipOf(read.ticket)}
        date={date}
        entity="ticket"
        help={{ about: "Ticket médio", text: read.ticket.help }}
        id="home-ticket"
        strip
        note={read.ticket.count || null}
        {...(drawn
          ? {
              range: range(read.ticket, model.labels.ticket),
              spark: spark(kpis.series.ticket, "var(--chart-ticket)", "range"),
            }
          : {})}
        title="Ticket médio"
        value={
          <HeroValue amount={read.ticket.value} reading={index !== null} tile />
        }
      />
    </>
  );
}

/** The three tiles of the month while the period the person chose is read. */
function PeriodTilesSkeleton() {
  return (
    <>
      <KpiTileSkeleton strip />
      <KpiTileSkeleton strip />
      <KpiTileSkeleton strip />
    </>
  );
}

/** What the three tiles of the month show: the month of the figures, or the period chosen (loading, failed, read). */
export type MonthPart =
  | { kind: "figures" }
  | { kind: "loading" }
  | { error: React.ReactNode; kind: "error" }
  | { kind: "period"; source: PeriodSource };

/** Which period the tiles show: what is read apart from the reading of a day, which starts over when it changes. */
function partKey(month: MonthPart): string {
  if (month.kind !== "period") {
    return month.kind;
  }
  const { from, to } = month.source.summary.period;
  return `${from}/${to}`;
}

function monthSource(month: MonthPart, own: MonthSource): MonthSource | null {
  if (month.kind === "period") {
    return month.source;
  }
  return month.kind === "figures" ? own : null;
}

/** The three tiles of the month, or their skeletons or the error, in the same place. */
function MonthGroup({
  month,
  own,
  still,
}: {
  month: MonthPart;
  own: MonthSource;
  still: boolean;
}) {
  const source = monthSource(month, own);
  const model = useMemo<MonthModel | null>(() => {
    if (source === null) {
      return null;
    }
    return source.kind === "month"
      ? monthModel(source.figures)
      : periodModel(source);
  }, [source]);
  const [index, setIndex, clear] = useReading();
  const key = partKey(month);
  const [shown, setShown] = useState(key);
  if (shown !== key) {
    setShown(key);
    clear();
  }
  return <>{monthBody(month, model, { clear, index, key, setIndex, still })}</>;
}

function monthBody(
  month: MonthPart,
  model: MonthModel | null,
  reading: {
    clear: () => void;
    index: number | null;
    key: string;
    setIndex: (index: number | null) => void;
    still: boolean;
  }
) {
  if (month.kind === "loading") {
    return (
      <div className={KPI_STRIP_THREE} data-kpi-month="" role="status">
        <span className="sr-only">Carregando o período…</span>
        <PeriodTilesSkeleton />
      </div>
    );
  }
  if (month.kind === "error") {
    return <div>{month.error}</div>;
  }
  if (model === null) {
    return null;
  }
  const { key, ...rest } = reading;
  return (
    <div className={KPI_STRIP_THREE} data-kpi-month="">
      <MonthTiles key={key} model={model} {...rest} />
    </div>
  );
}

/** The hero and the tiles of the month, one under the other: each in its own row, whatever the width. */
const KPI_COLUMN = "flex flex-col gap-3 xl:gap-4";

export function KpiCards({
  figures,
  month = { kind: "figures" },
  todayShown = true,
}: {
  figures: HomeFigures;
  month?: MonthPart;
  /** False when the figures are a copy of another day of the store (or have no series): never yesterday's as today's. */
  todayShown?: boolean;
}) {
  const still = useIsMobile();
  const own = useMemo<MonthSource>(
    () => ({ figures, kind: "month" }),
    [figures]
  );
  return (
    <div className={KPI_COLUMN} data-kpi-row="">
      {todayShown ? (
        <TodayTile figures={figures} still={still} />
      ) : (
        <KpiTile
          entity="sales"
          hero
          id="home-today"
          title="Vendas hoje"
          value={
            <HeroValue
              amount={null}
              emptyText="Sem números de hoje"
              size="xl"
            />
          }
        />
      )}
      <MonthGroup month={month} own={own} still={still} />
    </div>
  );
}

export const NO_CONNECTION_NOTE = "Sem conexão";

/**
 * The four tiles without a connection and without a copy on the device (§ 7.4): in their places and with the height
 * of a tile without the cost warning, each with its name, "—" (an unknown value is never a zero) and "Sem conexão". Only the
 * Result tile grows, by the line of its cost warning, when the figures come.
 */
export function NoFiguresCards({ today }: { today: string }) {
  const name = monthTitle(today).toLowerCase();
  return (
    <div className={KPI_COLUMN} data-kpi-row="">
      <KpiTile
        entity="sales"
        hero
        id="home-today"
        note={NO_CONNECTION_NOTE}
        title="Vendas hoje"
        value={<HeroValue amount={null} size="xl" />}
      />
      <div className={KPI_STRIP_THREE} data-kpi-month="">
        <KpiTile
          entity="sales"
          id="home-month"
          note={NO_CONNECTION_NOTE}
          strip
          title={`Vendas em ${name}`}
          value={<HeroValue amount={null} />}
        />
        <KpiTile
          entity="result"
          id="home-result"
          note={NO_CONNECTION_NOTE}
          strip
          title="Resultado estimado"
          value={<HeroValue amount={null} />}
        />
        <KpiTile
          entity="ticket"
          id="home-ticket"
          note={NO_CONNECTION_NOTE}
          strip
          title="Ticket médio"
          value={<HeroValue amount={null} />}
        />
      </div>
    </div>
  );
}

/**
 * The four tiles while the figures are read: the shape of `KpiCards`, each with the rows it has with figures, so the
 * tiles that come take the same places (the Result tile, with a cost warning, adds its line).
 */
export function KpiCardsSkeleton() {
  return (
    <div className={KPI_COLUMN} data-kpi-row="">
      <KpiTileSkeleton hero />
      <div className={KPI_STRIP_THREE} data-kpi-month="">
        <PeriodTilesSkeleton />
      </div>
    </div>
  );
}
