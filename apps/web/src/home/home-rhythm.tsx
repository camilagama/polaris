import {
  type ChangeEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { ChartDataTable } from "@/ui/charts/chart-data-table";
import {
  type HeatmapDay,
  type HeatmapTip,
  OnDemandHeatmap,
  useHeatmapFailed,
} from "@/ui/charts/on-demand";
import { MoneyText } from "@/ui/hidden-values";
import { formatBrlAmount, formatCalendarDate } from "../lib/format";
import {
  MASKED_SPOKEN,
  maskMoney,
  useHiddenValues,
} from "../lib/hidden-values";
import { useIsMobile } from "../lib/use-mobile";
import { ChartFailed } from "./home-chart";
import { salesCountText } from "./home-model";
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
} from "./home-rhythm-model";
import type { Block, HomeFigures } from "./use-home";

/**
 * "Ritmo de vendas" (revisão de UI v7, § 3 item 10; compact): the map of the store's days and
 * nothing else, as many weeks as fit up to 26 (13 at least), Sunday on top, cells of 12 px. The value of a day is in a
 * tooltip over its square, opened by the pointer, by the finger (the square nearest to it, following it as it drags)
 * and by the keyboard; under the map one fixed sentence (the best weekday and its mean, or that the map is still
 * filling up) and the legend in one line ("Menos" to "Mais"; the ranges in reais are in the (i) of the block and in the
 * `title` of the legend; the legend goes when the drawing does not open). The drawing (Bklit UI, its own chunk) is `aria-hidden`: the summary (`role="img"`), the
 * keyboard control (a transparent `input type="range"` over the map, as the charts have) and the table of the days are
 * ours. The table is invisible on the screen and tied to the map by `aria-details` (a description would read its 182
 * rows in one go); if the drawing does not open it is shown in its place. With the values hidden every amount is
 * "R$ ••••", in the tooltip too; the counts and the shape stay.
 */

/** The width of the initials of the weekdays and the contours around the map, in pixels (`MARGIN` of the drawing). */
const MAP_SIDES = 22;
const MAP_TOP = 18;

/** The cell and its gap: 12 + 3 on every width, and as many weeks as fit (a phone shows about 15 to 20). */
const CELL = 12;
const GAP = 3;

function mapLayout(width: number) {
  const fit =
    width > 0 ? Math.floor((width - MAP_SIDES) / (CELL + GAP)) : RHYTHM_WEEKS;
  return {
    cell: CELL,
    gap: GAP,
    weeks: Math.max(RHYTHM_WEEKS_PHONE, Math.min(RHYTHM_WEEKS, fit)),
  };
}

/** The width the map takes: its weeks of cells plus the sides. */
function mapWidth(layout: ReturnType<typeof mapLayout>) {
  return layout.weeks * (layout.cell + layout.gap) + MAP_SIDES;
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
  const [hidden] = useHiddenValues();
  const ranges = rhythmRangesText(view);
  return (
    <p
      className="flex shrink-0 items-center gap-2 text-muted-foreground text-xs"
      data-rhythm-legend=""
      title={hidden ? maskMoney(ranges) : ranges}
    >
      <span>Menos</span>
      <span aria-hidden="true" className="inline-flex gap-0.75">
        {SWATCHES.map((swatch) => (
          <span
            className={cn("size-3 rounded-[0.1875rem]", swatch)}
            key={swatch}
          />
        ))}
      </span>
      <span>Mais</span>
    </p>
  );
}

/** The fixed sentence under the map: the best weekday and its mean, or that the map is still filling up. */
function Insight({ view }: { view: RhythmView }) {
  const insight = rhythmInsight(view);
  return (
    <p className="min-w-0 flex-1 basis-60 text-support" data-rhythm-insight="">
      {insight.kind === "few" ? (
        <>
          {insight.text}{" "}
          <span className="text-muted-foreground">{insight.detail}</span>
        </>
      ) : (
        <MoneyText text={insight.text} />
      )}
    </p>
  );
}

const NUMBERS_COLUMNS = [
  { header: "Dia" },
  { header: "Vendas líquidas", numeric: true },
  { header: "Vendas", numeric: true },
] as const;

/** The caption of the table: what it is, and the note that the months before this one are read once a day. */
const NUMBERS_CAPTION = `Vendas por dia, do mais novo ao mais antigo. ${PAST_UNTIL_YESTERDAY}`;

/** The days read, newest first, as the table the map is tied to (shown only when the drawing does not open). */
function RhythmNumbers({
  id,
  view,
  visible,
}: {
  id: string;
  view: RhythmView;
  visible: boolean;
}) {
  const rows = useMemo(
    () =>
      view.cells
        .filter((cell) => cell.netSales !== null)
        .reverse()
        .map((cell) => ({
          cells: [
            formatCalendarDate(cell.date),
            formatBrlAmount(cell.netSales ?? "0.00"),
            cell.salesCount === 0
              ? "sem venda"
              : salesCountText(cell.salesCount),
          ],
          key: cell.date,
        })),
    [view]
  );
  return (
    <ChartDataTable
      caption={NUMBERS_CAPTION}
      columns={NUMBERS_COLUMNS}
      id={id}
      rows={rows}
      visible={visible}
    />
  );
}

/** The map, its tooltip, its keyboard, its legend and its numbers, for the days read. */
function RhythmMap({ days }: { days: RhythmDay[] }) {
  const phone = useIsMobile();
  const { ref, width } = useWidth();
  const { cell, gap, weeks } = mapLayout(width);
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
  const mapBox = useRef<HTMLDivElement>(null);
  // a day a finger touched stays read after it lifts; touching anywhere outside the map puts the tooltip away (checked
  // when the touch comes, since a finger can touch the very day the mouse already reads)
  useEffect(() => {
    if (hovered === null) {
      return;
    }
    const away = (event: Event) => {
      if (
        touched.current !== null &&
        !mapBox.current?.contains(event.target as Node)
      ) {
        touched.current = null;
        setHovered(null);
      }
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [hovered]);
  const [keyed, setKeyed] = useState<number | null>(null);
  // the days are indices of the grid: when it changes (the phone turned, the window resized) the day read is forgotten,
  // not left on whatever day now sits at its index
  useEffect(() => {
    touched.current = null;
    setHovered(null);
    setKeyed(null);
  }, [weeks]);
  // the keyboard control starts on today; the tooltip opens only once a day is read
  const rest = view.today;
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
      if (event.key === "Escape") {
        setKeyed(null);
        return;
      }
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
  const onFocus = useCallback(() => setKeyed((day) => day ?? rest), [rest]);
  const summary = rhythmSummary(view);
  const height = MAP_TOP + 7 * (cell + gap);
  const focus = hovered ?? keyed;
  const tip = useMemo<HeatmapTip | null>(() => {
    const focused = focus === null ? null : rhythmReading(view, focus);
    return focused
      ? {
          note: focused.note,
          rows: [
            {
              label: "Vendido",
              value: hidden ? maskMoney(focused.amount) : focused.amount,
            },
            { label: "Vendas", value: focused.count },
          ],
          title: focused.day,
        }
      : null;
  }, [focus, hidden, view]);
  const rangesText = rhythmRangesText(view);
  const help = `${RHYTHM_HELP} ${hidden ? maskMoney(rangesText) : rangesText}`;
  const mapPx = mapWidth({ cell, gap, weeks });
  const numbersId = useId();
  const drawingFailed = useHeatmapFailed();
  return (
    <HomeBlock
      action={
        <p className="text-muted-foreground text-support">
          {`Últimas ${weeks} semanas`}
        </p>
      }
      help={{ about: "Ritmo de vendas", text: help }}
      id="home-rhythm"
      title="Ritmo de vendas"
    >
      <div className="grid gap-2">
        <div className="min-w-0" ref={ref}>
          <div
            className="relative max-w-full"
            ref={mapBox}
            style={{ width: mapPx }}
          >
            <div
              aria-details={numbersId}
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
                tip={tip}
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
              onFocus={onFocus}
              onKeyDown={onKeyDown}
              step={1}
              type="range"
              value={keyed ?? read}
            />
          </div>
        </div>
        {/* the sentence takes two or three lines by width: the row keeps the room of the longest, so the card never changes height */}
        <div className="flex min-h-20 flex-wrap items-start justify-between gap-x-6 gap-y-2 md:min-h-13.5">
          <Insight view={view} />
          {drawingFailed ? null : <Legend view={view} />}
        </div>
        <RhythmNumbers id={numbersId} view={view} visible={drawingFailed} />
      </div>
    </HomeBlock>
  );
}

/** What the (i) of the block says: how to read a square (the line under the title says only the weeks). */
const RHYTHM_HELP = "Cada quadrado é um dia: quanto mais escuro, mais venda.";

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
      // the height of the block read, so the blocks under it stay
      <BlockSkeleton
        className="h-[16.6875rem] max-[21.25rem]:h-[18.0625rem] md:h-[15.8125rem]"
        label="Carregando o ritmo de vendas…"
        lines={0}
      />
    );
  }
  return <RhythmMap days={days} />;
}
