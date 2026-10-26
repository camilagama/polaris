import ChevronDownIcon from "lucide-react/dist/esm/icons/chevron-down";
import {
  type ChangeEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import {
  type HeatmapDay,
  OnDemandHeatmap,
  OnDemandWeekdayBars,
} from "@/ui/charts/on-demand";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@/ui/collapsible";
import { MoneyText } from "@/ui/hidden-values";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/table";
import { formatBrlAmount, formatCalendarDate } from "../lib/format";
import {
  MASKED_SPOKEN,
  maskMoney,
  useHiddenValues,
} from "../lib/hidden-values";
import { useIsMobile } from "../lib/use-mobile";
import { ChartFailed } from "./home-chart";
import { chartValue, salesCountText } from "./home-model";
import { BlockError, BlockSkeleton, HomeBlock } from "./home-parts";
import {
  type DailySeries,
  PAST_UNTIL_YESTERDAY,
  RHYTHM_WEEKS,
  RHYTHM_WEEKS_PHONE,
  type RhythmDay,
  type RhythmView,
  rhythmDays,
  rhythmInsight,
  rhythmRangesText,
  rhythmReading,
  rhythmReadingText,
  rhythmSummary,
  rhythmView,
  WEEKDAY_SHORT,
} from "./home-rhythm-model";
import type { Block, HomeFigures } from "./use-home";

/**
 * "Ritmo de vendas" (revisão de UI v7, § 3 item 10): the map of the store's days, 26 weeks from 760 px and 13 on a
 * phone, Sunday on top; the reading of a day above it, which follows the pointer, the finger and the keyboard (the
 * best day at rest); under it the legend with the ranges in reais, the sentence of the best weekday and the mean by
 * weekday. The drawing (Bklit UI, its own chunk) is `aria-hidden`: the summary (`role="img"`), the reading, the
 * keyboard control (a transparent `input type="range"` over the map, as the charts have) and "Ver os números" are
 * ours. With the values hidden every amount is "R$ ••••"; the counts and the shape stay.
 */

/** The width of the initials of the weekdays and the contours around the map, in pixels (`MARGIN` of the drawing). */
const MAP_SIDES = 22;
const MAP_TOP = 20;

/** The size of the cells: fixed from 760 px (16 + 3, as many weeks as fit up to 26), and on a phone 13 weeks of up to 18 + 4. */
function mapLayout(width: number, phone: boolean) {
  if (phone) {
    const step =
      width > 0
        ? Math.max(14, Math.min(22, Math.floor((width - MAP_SIDES) / 13)))
        : 22;
    const gap = step >= 20 ? 4 : 3;
    return { cell: step - gap, gap, weeks: RHYTHM_WEEKS_PHONE };
  }
  const fit = width > 0 ? Math.floor((width - MAP_SIDES) / 19) : RHYTHM_WEEKS;
  return {
    cell: 16,
    gap: 3,
    weeks: Math.max(RHYTHM_WEEKS_PHONE, Math.min(RHYTHM_WEEKS, fit)),
  };
}

/** The width of the box the map is drawn in, followed as the window changes. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    setWidth(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry?.contentRect.width ?? 0)
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

/* transparent, with no track and no thumb (the map shows the day read) and deaf to the pointer (the map under it reads
   the pointer); the 3 px outline of the keyboard focus goes around the map */
const RANGE_CLASS =
  "pointer-events-none absolute inset-0 m-0 size-full appearance-none rounded-md bg-transparent focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-2 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-transparent [&::-moz-range-track]:bg-transparent [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:appearance-none";

/** The keys of the map: up and down a day (a column is a week), left and right a week, Home and End the ends. */
function keyMove(key: string, index: number, last: number): number | null {
  const moves: Record<string, number> = {
    ArrowDown: index + 1,
    ArrowLeft: index - 7,
    ArrowRight: index + 7,
    ArrowUp: index - 1,
    End: last,
    Home: 0,
  };
  const next = moves[key];
  return next === undefined ? null : Math.max(0, Math.min(last, next));
}

const SWATCHES = [
  "border border-input",
  "bg-(--chart-heat-1)",
  "bg-(--chart-heat-2)",
  "bg-(--chart-heat-3)",
  "bg-(--chart-heat-4)",
] as const;

function Legend({ view }: { view: RhythmView }) {
  const insight = rhythmInsight(view);
  return (
    <div className="grid min-w-0 flex-[1_1_16rem] content-start gap-1.5">
      <p className="flex items-center gap-2 text-muted-foreground text-xs">
        <span>Menos</span>
        <span aria-hidden="true" className="inline-flex gap-[3px]">
          {SWATCHES.map((swatch) => (
            <span
              className={cn("size-3.5 rounded-[3px]", swatch)}
              key={swatch}
            />
          ))}
        </span>
        <span>Mais</span>
      </p>
      <p className="text-muted-foreground text-xs">
        <MoneyText text={rhythmRangesText(view)} />
      </p>
      {insight.kind === "few" ? (
        <p className="text-support">
          {insight.text}{" "}
          <span className="text-muted-foreground">{insight.detail}</span>
        </p>
      ) : (
        <p className="flex items-baseline gap-1.5 text-support">
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-full bg-chart-sales"
          />
          <span>
            <MoneyText text={insight.text} />
          </span>
        </p>
      )}
    </div>
  );
}

function WeekdayMeans({ still, view }: { still: boolean; view: RhythmView }) {
  const { best, means } = view.weekdays;
  return (
    <div className="grid min-w-48 flex-[0_1_15.5rem] content-start gap-1.5">
      <p className="text-muted-foreground text-xs">Média por dia da semana</p>
      <OnDemandWeekdayBars
        best={best}
        height={64}
        still={still}
        values={means.map(chartValue)}
      />
      <div aria-hidden="true" className="grid grid-cols-7 gap-1.5 text-center">
        {WEEKDAY_SHORT.map((label, weekday) => (
          <span
            className={cn(
              "text-[11px] text-muted-foreground",
              weekday === best && "font-semibold text-foreground"
            )}
            key={label}
          >
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

function NumbersTable({ view }: { view: RhythmView }) {
  const rows = view.cells.filter((cell) => cell.netSales !== null).reverse();
  return (
    <Collapsible>
      <CollapsibleTrigger
        className="group/numbers w-fit"
        render={<Button size="sm" variant="ghost" />}
      >
        Ver os números
        <ChevronDownIcon
          aria-hidden="true"
          className="motion-full:transition-transform group-data-[panel-open]/numbers:rotate-180"
          data-icon="inline-end"
        />
      </CollapsibleTrigger>
      <CollapsiblePanel className="grid gap-2 pt-1">
        <p className="text-muted-foreground text-support">
          {PAST_UNTIL_YESTERDAY}
        </p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Dia</TableHead>
              <TableHead className="text-right" scope="col">
                Vendas líquidas
              </TableHead>
              <TableHead className="text-right" scope="col">
                Vendas
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((cell) => (
              <TableRow key={cell.date}>
                <TableCell>{formatCalendarDate(cell.date)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  <MoneyText text={formatBrlAmount(cell.netSales ?? "0.00")} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {cell.salesCount === 0
                    ? "sem venda"
                    : salesCountText(cell.salesCount)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/** The map, its reading, its keyboard, its legend and its numbers, for the days read. */
function RhythmMap({ days }: { days: RhythmDay[] }) {
  const phone = useIsMobile();
  const { ref, width } = useWidth();
  const { cell, gap, weeks } = mapLayout(width, phone);
  const view = useMemo(() => rhythmView(days, weeks), [days, weeks]);
  const [hidden] = useHiddenValues();
  const [hovered, setHovered] = useState<number | null>(null);
  // a finger leaves the map as soon as it lifts: the day it touched stays read until it touches another one, and the
  // pointer of a mouse reads as it moves
  const touched = useRef<number | null>(null);
  const onRead = useCallback((index: number | null, touch = false) => {
    if (touch) {
      touched.current = index;
      setHovered(index);
      return;
    }
    // the block's own hover of the same finger (its enter and its leave) does not undo the day touched
    if (
      touched.current !== null &&
      (index === null || index === touched.current)
    ) {
      return;
    }
    touched.current = null;
    setHovered(index);
  }, []);
  const [keyed, setKeyed] = useState<number | null>(null);
  // the days are indices of the grid: when it changes (the phone turned, the window resized) the day read is forgotten,
  // not left on whatever day now sits at its index
  useEffect(() => {
    touched.current = null;
    setHovered(null);
    setKeyed(null);
  }, [weeks]);
  const rest = view.best ?? view.today;
  const read = hovered ?? keyed ?? rest;
  const reading = rhythmReading(view, read) ?? rhythmReading(view, view.today);
  const readingText = reading ? rhythmReadingText(reading) : "";
  const heatmapDays: HeatmapDay[] = useMemo(
    () =>
      view.cells.map((entry) => ({
        date: entry.date,
        known: entry.netSales !== null,
        level: entry.level,
      })),
    [view]
  );
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      const next = keyMove(event.key, keyed ?? rest, view.today);
      if (next !== null) {
        event.preventDefault();
        setKeyed(next);
      }
    },
    [keyed, rest, view.today]
  );
  const onChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      setKeyed(Number(event.currentTarget.value)),
    []
  );
  const onBlur = useCallback(() => setKeyed(null), []);
  const summary = rhythmSummary(view);
  const height = MAP_TOP + 7 * (cell + gap);
  const focus = hovered ?? keyed;
  return (
    <div className="grid gap-3">
      <p className="text-muted-foreground text-support">
        {`Últimas ${weeks} semanas · um quadrado por dia, mais escuro é mais venda`}
      </p>
      <p className="min-h-10 text-support md:min-h-5" data-rhythm-reading="">
        {reading ? (
          <>
            <span className="font-semibold">{reading.day}</span>
            {" · "}
            <span className="tabular-nums">
              <MoneyText text={reading.value} />
            </span>
            {reading.note ? (
              <span className="text-muted-foreground">{` · ${reading.note}`}</span>
            ) : null}
          </>
        ) : null}
      </p>
      <div className="relative min-w-0" ref={ref}>
        <div
          aria-label={hidden ? maskMoney(summary, MASKED_SPOKEN) : summary}
          role="img"
        >
          <OnDemandHeatmap
            best={view.best}
            cell={cell}
            days={heatmapDays}
            failed={<ChartFailed />}
            focus={focus}
            gap={gap}
            height={height}
            onRead={onRead}
            still={phone}
            today={view.today}
          />
        </div>
        <input
          aria-label="Dia do mapa de vendas"
          aria-valuetext={
            hidden ? maskMoney(readingText, MASKED_SPOKEN) : readingText
          }
          className={RANGE_CLASS}
          max={view.today}
          min={0}
          onBlur={onBlur}
          onChange={onChange}
          onKeyDown={onKeyDown}
          step={1}
          type="range"
          value={keyed ?? read}
        />
      </div>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
        <Legend view={view} />
        <WeekdayMeans still={phone} view={view} />
      </div>
      <NumbersTable view={view} />
    </div>
  );
}

/** Where the series of the map comes from: the server's read, or without a connection the copy (null without one). */
export type RhythmSource =
  | Block<DailySeries>
  | { data: DailySeries | null; status: "copy" };

/**
 * The block of the map, beside the figures it composes with: loading, the error with "Tentar novamente", "O mapa abre
 * com internet." without a connection and without a copy, or the map. A day it does not know is never drawn as a zero:
 * without every day of the 26 weeks the block waits (or says it opens with a connection).
 */
export function RhythmBlock({
  figures,
  onRetry,
  source,
}: {
  figures: HomeFigures;
  onRetry: () => void;
  source: RhythmSource;
}) {
  const series =
    source.status === "ready" || source.status === "copy" ? source.data : null;
  const days = useMemo(
    () =>
      series
        ? rhythmDays(series, figures.month.daily ?? [], figures.today)
        : null,
    [figures, series]
  );
  if (source.status === "hidden") {
    return null;
  }
  if (source.status === "error") {
    return (
      <BlockError
        message="Não foi possível carregar o ritmo de vendas."
        onRetry={source.retryable ? onRetry : null}
      />
    );
  }
  if (days === null) {
    return source.status === "copy" ? (
      <HomeBlock id="home-rhythm" title="Ritmo de vendas">
        <p className="text-muted-foreground">O mapa abre com internet.</p>
      </HomeBlock>
    ) : (
      <BlockSkeleton
        className="h-72"
        label="Carregando o ritmo de vendas…"
        lines={0}
      />
    );
  }
  return (
    <HomeBlock id="home-rhythm" title="Ritmo de vendas">
      <RhythmMap days={days} />
    </HomeBlock>
  );
}
