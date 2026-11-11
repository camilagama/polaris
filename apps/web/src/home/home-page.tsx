import PlusIcon from "lucide-react/dist/esm/icons/plus";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "@/ui/button";
import { RefreshButton } from "@/ui/refresh-button";
import { SlowReadNote, StaleCopyNotice } from "../app-shell/read-wait";
import { useCurrentOrganization } from "../lib/current-organization";
import { browserStorage } from "../lib/current-organization-model";
import { calendarDayInTimezone } from "../lib/dates";
import type { Period, PeriodPreset } from "../dashboard/result-period";
import type { StoredPeriodSummary } from "../lib/period-summary-cache";
import { copyShownText } from "../lib/read-wait-text";
import { OFFLINE_RUNTIME_ENABLED } from "../offline/runtime/enabled";
import {
  useOfflineRuntime,
  useRuntimeSnapshot,
} from "../offline/runtime/runtime-context";
import { useSessionOver } from "../offline/runtime/session-ended";
import { useLocalWorkspace } from "../offline/runtime/use-local-workspace";
import { ClosedStoreLine, ReopenedNotice } from "./closed-store-line";
import { AttentionBlock, AttentionNotes } from "./home-attention";
import { ChartBlock } from "./home-chart";
import { type OfflineHome, offlineHome } from "./home-copy";
import { ChecklistBlock, TopProductsBlock } from "./home-figures";
import { GoalBlock, OfflineGoalBlock } from "./home-goal";
import {
  KpiCards,
  KpiCardsSkeleton,
  type MonthPart,
  NO_CONNECTION_NOTE,
  NoFiguresCards,
} from "./home-kpi-cards";
import {
  copyLine,
  type GoalView,
  goalProjection,
  homeUpdatedLine,
  newSaleOfflineText,
  noCopyText,
  noSaleCounted,
  pickGoal,
} from "./home-model";
import {
  type HomeSelection,
  THIS_MONTH,
  topProductsTitle,
} from "./home-period";
import { HomePeriodRow } from "./home-period-row";
import { PeriodControlProvider } from "./period-control";
import { BlockError, BlockSkeleton, HomeBlock, KeptHeight } from "./home-parts";
import { RhythmBlock, type RhythmSource } from "./home-rhythm";
import {
  type FirstStepsMemory,
  useFirstStepsMemory,
} from "./use-first-steps-memory";
import { type HomeFigures, type HomeState, useHome } from "./use-home";
import { useHomePeriod } from "./use-home-period";

/**
 * The Início (`/`): "Nova venda" at once, at the top, depending on no read; then "Precisa de ação" (only when there is
 * something to do), Hoje, Mês, Meta, the chart, the map and Mais vendidos, in this order at 360 px, and in two columns
 * from 1024 px with Nova venda, Hoje and Mês above the fold (AC-4 emendado: with three lines of action the number of Hoje
 * and the title of Mês stay inside a 360 × 740 window). A store that never sold sees the checklist in place of the
 * figures (AC-22). Each block reads, waits and fails on its own (§ 5.2). Opening it writes nothing (AC-23): the only
 * write is the settling of a goal whose period ended, which `goal.list` already does when it reads (ADR 0055).
 */

const REFRESHING_TEXT = "Atualizando…";

/**
 * "Atualizar" of the Início: reads every block again, past the copy of the day. While it reads, and without a
 * connection, the button is `aria-disabled` and ignores the click, so the focus stays on it (a native `disabled` would
 * drop it on the body) and the row of actions keeps its place when the connection comes back.
 */
function HomeRefresh({
  busy,
  className,
  offline,
  offlineReasonId,
  onClick,
}: {
  busy: boolean;
  className?: string;
  offline: boolean;
  /** The line that already says "Sem internet.": read as the reason while the button is off for lack of a connection. */
  offlineReasonId: string | undefined;
  onClick: () => void;
}) {
  const off = busy || offline;
  return (
    <RefreshButton
      aria-describedby={busy ? undefined : offlineReasonId}
      aria-disabled={off || undefined}
      busy={busy}
      className={className}
      onClick={off ? undefined : onClick}
    />
  );
}

/**
 * "Nova venda". What it can do without a connection (AC-30) is said in a line of its own under the row of actions
 * (`HomeHeader`), not inside this box: a long sentence here would widen the box and push "Atualizar" and the eye to
 * the left when the connection goes or comes back.
 */
function NewSale({ describedBy }: { describedBy: string | undefined }) {
  return (
    <a
      aria-describedby={describedBy}
      className={cn(buttonVariants({ size: "xl" }), "w-full sm:w-auto")}
      href="/sales"
    >
      <PlusIcon aria-hidden="true" data-icon="inline-start" />
      Nova venda
    </a>
  );
}

interface Blocks {
  chart: React.ReactNode;
  main: React.ReactNode;
  /**
   * The main block is a skeleton whose final shape is not known yet (the cards, or the checklist of a store that never
   * sold): what comes after it waits, so it appears once in its place instead of being pushed when the shape is known.
   */
  pending?: true;
  ranking: React.ReactNode;
  rhythm: React.ReactNode;
}

/** The map's series and its "Tentar novamente". */
interface Rhythm {
  onRetry: () => void;
  source: RhythmSource;
}

/**
 * The period the person chose on the Início, when it is not "Este mês": what the cards of the month, Vendas por dia and
 * Mais vendidos show in its place (the figures of the month stay for Hoje, the goal and the map).
 */
interface ChosenView {
  month: MonthPart;
  /** The line beside the picker about what is on screen (a copy of the device). */
  note: React.ReactNode;
  rankingTitle: string;
  summary: StoredPeriodSummary | null;
  today: string;
}

/**
 * The line beside the picker about the figures on screen: that a refresh failed (the figures are the last read) or that
 * they are the device's copy, with "Tentar novamente" when there is a connection and the server is what failed.
 */
function periodNote(
  picked: ReturnType<typeof useHomePeriod>,
  timezone: string,
  now: number,
  online: boolean
): React.ReactNode {
  const { state } = picked;
  let failed: string | null = null;
  if (state.error && !state.isLoading) {
    failed = state.error;
  } else if (state.source === "cache" && picked.source) {
    failed = copyShownText(
      picked.source.summary.generatedAt,
      timezone,
      new Date(now)
    );
  }
  if (failed === null) {
    return null;
  }
  const retry = state.error ? !state.isLoading : online && state.serverFailed;
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-muted-foreground text-support">
      {failed}
      {retry ? (
        <Button
          onClick={picked.refresh}
          size="sm"
          type="button"
          variant="ghost"
        >
          Tentar novamente
        </Button>
      ) : null}
    </p>
  );
}

/** The chosen period as the blocks draw it: the cards' part, the ranking's title, the summary and the line about it. */
function chosenView(
  picked: ReturnType<typeof useHomePeriod>,
  selection: HomeSelection,
  timezone: string,
  now: number,
  online: boolean
): ChosenView | null {
  if (!picked.chosen) {
    return null;
  }
  const base = {
    rankingTitle: topProductsTitle(selection, picked.period),
    today: picked.today,
  };
  if (picked.source) {
    const { summary } = picked.source;
    return {
      ...base,
      month: { kind: "period", source: picked.source },
      note: periodNote(picked, timezone, now, online),
      summary,
    };
  }
  if (picked.state.error) {
    return {
      ...base,
      month: {
        error: (
          <BlockError
            message={picked.state.error}
            onRetry={picked.state.isLoading ? null : picked.refresh}
          />
        ),
        kind: "error",
      },
      note: null,
      summary: null,
    };
  }
  return { ...base, month: { kind: "loading" }, note: null, summary: null };
}

/**
 * Whether the period chosen has figures to apply to: "yes" where the cards of the month are drawn (from the server or
 * from the copy), "loading" while they are read, "no" for the error, the checklist of a store that never sold and a
 * device with no copy (the picker stays in its place, off, so the page does not move when that changes), and "hidden"
 * for whoever cannot read the results.
 */
type Applies = "hidden" | "loading" | "no" | "yes";

function periodApplies({
  failed,
  readsReport,
  state,
  view,
}: {
  failed: OfflineHome | null;
  readsReport: boolean;
  state: HomeState;
  view: OfflineHome | null;
}): Applies {
  if (!readsReport || state.sessionRefused) {
    return "hidden";
  }
  if (view) {
    return view.figures ? "yes" : "no";
  }
  if (failed?.figures) {
    return "yes";
  }
  const { checklist, figures } = state;
  if (figures.status === "loading" || figuresPending(state)) {
    return "loading";
  }
  const stores = checklist.status === "ready" && checklist.data;
  return figures.status === "ready" && !stores ? "yes" : "no";
}

/** The selection of the period, its read, and what the blocks draw from it. */
function useChosenPeriod({
  applies,
  now,
  online,
  organizationId,
  reload,
  timezone,
  today,
}: {
  applies: Applies;
  now: number;
  online: boolean;
  organizationId: string;
  /** "Atualizar" of the page's own reads. */
  reload: () => void;
  timezone: string;
  today: string;
}) {
  const [selection, setSelection] = useState<HomeSelection>(THIS_MONTH);
  const handlePreset = useCallback((preset: PeriodPreset) => {
    setSelection({ custom: null, preset });
  }, []);
  const handleCustom = useCallback((custom: Period) => {
    setSelection({ custom, preset: "custom" });
  }, []);
  const picked = useHomePeriod({
    enabled: applies === "yes",
    organizationId,
    selection,
    timezone,
    today,
  });
  const chosen = chosenView(picked, selection, timezone, now, online);
  const { chosen: reading, refresh } = picked;
  // "Atualizar" reads the period chosen again too, when there is one
  const reloadAll = useCallback(() => {
    reload();
    if (reading) {
      refresh();
    }
  }, [reading, refresh, reload]);
  const periodRow =
    applies === "hidden" ? null : (
      <HomePeriodRow
        disabled={applies !== "yes"}
        note={chosen?.note ?? null}
        offline={!online}
        onCustom={handleCustom}
        onPreset={handlePreset}
        period={picked.period}
        selection={selection}
        today={today}
      />
    );
  return { chosen, periodRow, reloadAll };
}

/** Mais vendidos of the period shown: a skeleton while the period is read, nothing when no product sold. */
function rankingBlock(
  top: NonNullable<StoredPeriodSummary["topProducts"]>,
  chosen: ChosenView | null
): React.ReactNode {
  if (chosen?.month.kind === "loading") {
    return <BlockSkeleton label="Carregando os mais vendidos…" lines={3} />;
  }
  if (top.length === 0) {
    return null;
  }
  return (
    <TopProductsBlock
      products={top}
      title={chosen?.rankingTitle ?? "Mais vendidos do mês"}
    />
  );
}

/** The KPI cards, the ranking and the chart of figures that were read (from the server or from the copy). */
function readBlocks(
  figures: HomeFigures,
  chosen: ChosenView | null,
  rhythm: Rhythm,
  todayShown = true
): Blocks {
  const shown = chosen ? chosen.summary : figures.month;
  const top = shown?.topProducts ?? [];
  // a copy kept before the daily series existed: the totals stand, nothing of the series is drawn (ADR 0056, D2)
  const series =
    figures.month.daily !== undefined && figures.before.daily !== undefined;
  const chartToday = chosen ? chosen.today : figures.today;
  let chart: React.ReactNode = null;
  if (chosen?.month.kind === "loading") {
    chart = <BlockSkeleton label="Carregando o gráfico…" lines={5} />;
  } else if (shown?.daily !== undefined && (chosen !== null || series)) {
    chart = <ChartBlock summary={shown} today={chartToday} />;
  }
  return {
    chart,
    main: (
      <KpiCards
        figures={figures}
        month={chosen?.month ?? { kind: "figures" }}
        todayShown={todayShown && series}
      />
    ),
    ranking: rankingBlock(top, chosen),
    // the days of the month are the figures': a copy without the series of the month draws no map either
    rhythm:
      figures.month.daily === undefined ? null : (
        <RhythmBlock
          figures={figures}
          onRetry={rhythm.onRetry}
          source={rhythm.source}
        />
      ),
  };
}

/**
 * The cards are still to come: the figures, or what hangs on them. The checklist is read only when the figures counted
 * no sale (with a sale counted the cards come at once), and the stock's read waits for the figures.
 */
function figuresPending({ checklist, figures, stock }: HomeState): boolean {
  if (figures.status === "loading") {
    return true;
  }
  if (figures.status !== "ready") {
    return false;
  }
  const sold = !noSaleCounted(figures.data.month, figures.data.before);
  return (
    (checklist.status === "loading" && !sold) || stock.status === "loading"
  );
}

/** Where the figures are: the skeletons, the error, the checklist, or Hoje and Mês. Returns the chart and the ranking too. */
function figureBlocks(
  state: HomeState,
  onRetry: () => void,
  chosen: ChosenView | null,
  onRetryRhythm: () => void,
  firstSteps: FirstStepsMemory
): Blocks {
  const { checklist, figures } = state;
  if (figures.status === "hidden") {
    return NO_BLOCKS;
  }
  if (figures.status === "error") {
    return {
      chart: null,
      main: (
        <BlockError
          message="Não foi possível carregar os números da loja."
          onRetry={figures.retryable ? onRetry : null}
        />
      ),
      ranking: null,
      rhythm: null,
    };
  }
  // the stock's read waits for the figures, and "Precisa de ação" sits above the cards: they come in together
  if (figures.status === "loading" || figuresPending(state)) {
    // before the figures only this tab's memory knows whether the checklist comes; after them, it does
    const steps =
      figures.status === "ready"
        ? firstSteps !== "sold"
        : firstSteps === "steps";
    return {
      ...NO_BLOCKS,
      main: steps ? (
        <BlockSkeleton
          className="lg:col-span-2"
          label="Carregando os primeiros passos…"
          lines={3}
        />
      ) : (
        <div role="status">
          <span className="sr-only">Carregando os números…</span>
          <KpiCardsSkeleton />
        </div>
      ),
      pending: true,
    };
  }
  if (checklist.status === "ready" && checklist.data) {
    return {
      ...NO_BLOCKS,
      main: <ChecklistBlock checklist={checklist.data} />,
    };
  }
  return readBlocks(figures.data, chosen, {
    onRetry: onRetryRhythm,
    source: state.rhythm,
  });
}

const NO_BLOCKS: Blocks = {
  chart: null,
  main: null,
  ranking: null,
  rhythm: null,
};

/**
 * Every try of the figures failed with a connection, and the device has the copy (paliativo dos 1102): the copy's
 * figures, under the notice that they could not be updated now, with what they show and "Tentar novamente".
 */
function staleCopyBlocks(
  failed: OfflineHome & { figures: NonNullable<OfflineHome["figures"]> },
  chosen: ChosenView | null,
  retry: { figures: () => void; rhythm: () => void },
  timezone: string | null,
  now: Date
): { blocks: Blocks; updated: string } {
  const { figures } = failed;
  const blocks = readBlocks(
    figures,
    chosen,
    { onRetry: retry.rhythm, source: { data: failed.rhythm, status: "copy" } },
    figures.todayShown
  );
  return {
    blocks: {
      ...blocks,
      main: (
        <div className="grid gap-4">
          <StaleCopyNotice
            onRetry={retry.figures}
            shown={copyShownText(figures.confirmedAt, timezone, now)}
          />
          {blocks.main}
        </div>
      ),
    },
    updated: copyLine(figures.confirmedAt, timezone, figures.stale),
  };
}

/** The figures' blocks and the line under the title: the server's, or without a connection the copy's (§ 7.4). */
function pageBlocks({
  canSellOffline,
  chosen,
  failed,
  firstSteps,
  now,
  offline,
  readsReport,
  retryFigures,
  retryRhythm,
  state,
  timezone,
  today,
}: {
  canSellOffline: boolean;
  chosen: ChosenView | null;
  /** The copy, when every try of the figures failed with a connection (null when there is none). */
  failed: OfflineHome | null;
  firstSteps: FirstStepsMemory;
  now: Date;
  offline: OfflineHome | null;
  readsReport: boolean;
  retryFigures: () => void;
  retryRhythm: () => void;
  state: HomeState;
  timezone: string | null;
  today: string;
}): { blocks: Blocks; updated: React.ReactNode } {
  if (offline === null) {
    if (failed?.figures) {
      return staleCopyBlocks(
        { ...failed, figures: failed.figures },
        chosen,
        { figures: retryFigures, rhythm: retryRhythm },
        timezone,
        now
      );
    }
    return {
      blocks: figureBlocks(
        state,
        retryFigures,
        chosen,
        retryRhythm,
        firstSteps
      ),
      updated: figuresLine(state, timezone),
    };
  }
  if (!readsReport) {
    return { blocks: NO_BLOCKS, updated: null };
  }
  if (offline.figures === null) {
    return {
      blocks: {
        ...NO_BLOCKS,
        // the chart's place stays, with its name: the goal beside it does not change columns
        chart: (
          <HomeBlock id="home-chart" title="Vendas por dia">
            <p className="text-muted-foreground">{NO_CONNECTION_NOTE}</p>
          </HomeBlock>
        ),
        main: <NoFiguresCards today={today} />,
      },
      updated: noCopyText(canSellOffline),
    };
  }
  return {
    blocks: readBlocks(
      offline.figures,
      chosen,
      {
        onRetry: retryRhythm,
        source: { data: offline.rhythm, status: "copy" },
      },
      offline.figures.todayShown
    ),
    updated: copyLine(
      offline.figures.confirmedAt,
      timezone,
      offline.figures.stale
    ),
  };
}

/** The line under the title with a connection: when the figures were read, or, after ~3 s of reading, that it takes long. */
function figuresLine(
  state: HomeState,
  timezone: string | null
): React.ReactNode {
  if (state.figures.status === "ready") {
    return homeUpdatedLine(state.figures.data.month.generatedAt, timezone);
  }
  return state.figures.status === "loading" ? (
    <SlowReadNote announce={false} />
  ) : null;
}

/**
 * The title, "Atualizar" and "Nova venda" with the line that says what the sale can do without a connection: the part
 * of the page that depends on no read (and on no connection). On a phone "Atualizar" is an icon in the corner of the
 * title and "Nova venda" takes the whole width (v7 § 3).
 */
function HomeHeader({
  explained,
  offlineText,
  refresh,
  updated,
}: {
  /** The line under the title says why there are no figures (and no sales, when the device cannot keep one): "Nova venda" points to it. */
  explained: boolean;
  offlineText: string | null;
  /** The gesture "Atualizar", or null when the session is refused; `offline` keeps it in place, switched off. */
  refresh: { busy: boolean; offline: boolean; onClick: () => void } | null;
  updated: React.ReactNode;
}) {
  let offlineReasonId: string | undefined;
  if (explained) {
    offlineReasonId = "home-updated";
  } else if (offlineText) {
    offlineReasonId = "home-new-sale-offline";
  }
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="flex min-w-0 flex-1 items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <h1 className="text-title">Início</h1>
          {/* two lines kept on a phone: the long day and hour, or "Carregando…", take the same box */}
          <p
            className="min-h-10 text-muted-foreground text-support md:min-h-5"
            id="home-updated"
            role="status"
          >
            {updated}
          </p>
        </div>
        <div className="flex items-start gap-2 md:hidden">
          {refresh ? (
            <HomeRefresh
              busy={refresh.busy}
              offline={refresh.offline}
              offlineReasonId={offlineReasonId}
              onClick={refresh.onClick}
            />
          ) : null}
        </div>
      </div>
      <div className="flex w-full items-start gap-2 sm:w-auto">
        {refresh ? (
          <HomeRefresh
            busy={refresh.busy}
            className="max-md:hidden"
            offline={refresh.offline}
            offlineReasonId={offlineReasonId}
            onClick={refresh.onClick}
          />
        ) : null}
        <NewSale
          describedBy={
            [
              explained ? "home-updated" : null,
              offlineText ? "home-new-sale-offline" : null,
            ]
              .filter(Boolean)
              .join(" ") || undefined
          }
        />
      </div>
      {offlineText ? (
        <p
          // sibling of the row of actions in a flex-wrap header with `gap-y-4`: the negative margin leaves 6 px between them
          className="-mt-2.5 w-full text-muted-foreground text-support sm:text-right"
          id="home-new-sale-offline"
        >
          {offlineText}
        </p>
      ) : null}
    </header>
  );
}

/**
 * What is said without a connection: under "Nova venda" what it can do then (AC-30); without a copy either, the line
 * under the title says it once for the figures and the sale (`explained`), and nothing more goes under "Nova venda"
 * unless this device can keep a sale.
 */
function offlineLines(
  offline: OfflineHome | null,
  readsReport: boolean,
  canSellOffline: boolean
): { explained: boolean; offlineText: string | null } {
  if (offline === null) {
    return { explained: false, offlineText: null };
  }
  const explained = readsReport && offline.figures === null;
  return {
    explained,
    offlineText: newSaleOfflineText(canSellOffline, explained),
  };
}

/**
 * "Atualizar" stays in its place without a connection, switched off; only a refused session takes it away.
 * `refreshing` is true while the button's own read runs.
 */
function refreshGesture(
  online: boolean,
  sessionRefused: boolean,
  reloading: boolean,
  reload: () => void
): {
  refresh: { busy: boolean; offline: boolean; onClick: () => void } | null;
  refreshing: boolean;
} {
  return {
    refresh: sessionRefused
      ? null
      : { busy: online && reloading, offline: !online, onClick: reload },
    refreshing: online && !sessionRefused && reloading,
  };
}

/**
 * Whether the copy may stand in for the server (§ 7.2): the runtime on, a role that reads the results, the user's own
 * lease in force (the runtime is ready only then) and no refusal of the session, here or by the runtime.
 */
function useCopyAllowed(
  organizationId: string,
  readsReport: boolean,
  refused: boolean
): boolean {
  const runtime = useOfflineRuntime();
  const snapshot = useRuntimeSnapshot();
  const sessionOver = useSessionOver();
  return (
    OFFLINE_RUNTIME_ENABLED &&
    readsReport &&
    snapshot?.phase === "ready" &&
    !snapshot.sessionRefused &&
    !refused &&
    !sessionOver &&
    // the lease of this user, for this store, in force right now (`context()` checks its end even with a late timer)
    runtime?.context()?.organizationId === organizationId
  );
}

/** The clock of the page without a connection: once a minute, so the day of the store and the copy's age move on. */
function useOfflineClock(online: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (online) {
      return;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [online]);
  return now;
}

/**
 * What the page shows without a connection (the copy, § 7.4), and, once the connection is back, the copy still on the
 * screen until the new read is whole: no skeletons and no jump of the page.
 */
function useOfflineView({
  figuresFailed,
  cardsPending,
  online,
  organizationId,
  readsReport,
  refused,
  timezone,
}: {
  /** Every try of the figures failed, and trying again may help (not a refusal). */
  figuresFailed: boolean;
  cardsPending: boolean;
  online: boolean;
  organizationId: string;
  readsReport: boolean;
  refused: boolean;
  timezone: string | null;
}): {
  failed: OfflineHome | null;
  offline: OfflineHome | null;
  view: OfflineHome | null;
} {
  const copyAllowed = useCopyAllowed(organizationId, readsReport, refused);
  const clock = useOfflineClock(online);
  const offline = useMemo(
    () =>
      online
        ? null
        : offlineHome(
            browserStorage(),
            organizationId,
            timezone,
            // the device's clock (the copy's skew makes it the store's); the state of the clock may be of before the
            // connection went: never earlier than now
            Math.max(clock, Date.now()),
            copyAllowed
          ),
    [clock, copyAllowed, online, organizationId, timezone]
  );
  // the connection is back: the copy stays on the screen until the new read is whole, figures and what hangs on them
  // (the stock is not read when the page opens without a connection), so no skeleton takes the cards and no block leaves
  const keptCopy = useRef<OfflineHome | null>(null);
  if (offline) {
    // only figures are worth keeping: "sem internet" never stays once the connection is back
    keptCopy.current = offline.figures ? offline : null;
  } else if (!cardsPending) {
    keptCopy.current = null;
  }
  const view = offline ?? keptCopy.current;
  // with a connection, after every try failed: the same copy, if the device has it (paliativo dos 1102)
  const failed = useMemo(
    () =>
      online && figuresFailed
        ? offlineHome(
            browserStorage(),
            organizationId,
            timezone,
            Date.now(),
            copyAllowed
          )
        : null,
    [copyAllowed, figuresFailed, online, organizationId, timezone]
  );
  return { failed: failed?.figures ? failed : null, offline, view };
}

/** The goal's card: the copy's without a connection (and until the new read is whole), the server's otherwise. */
function pickGoalBlock({
  goal,
  offline,
  readsGoals,
  retryGoals,
  state,
  view,
}: {
  goal: GoalView | null;
  offline: OfflineHome | null;
  readsGoals: boolean;
  retryGoals: () => void;
  state: HomeState;
  view: OfflineHome | null;
}): React.ReactNode {
  if (view && readsGoals && (offline || state.goals.status === "loading")) {
    return <OfflineGoalBlock goal={view.goal} />;
  }
  if (offline || state.sessionRefused) {
    return null;
  }
  // the estimate only from the server's series of this read, measured on its today (never from the copy)
  const figures = state.figures.status === "ready" ? state.figures.data : null;
  const projection =
    goal?.kind === "active" && figures
      ? goalProjection(
          goal.goal,
          { before: figures.before.daily, month: figures.month.daily },
          figures.today
        )
      : null;
  return (
    <GoalBlock
      block={state.goals}
      onRetry={retryGoals}
      projection={projection}
      today={figures?.today ?? null}
      view={goal}
    />
  );
}

/**
 * The blocks under the KPI cards. The source has the order of a phone (Meta, Vendas por dia, Ritmo de vendas, Mais
 * vendidos, v7 § 3); from 1024 px the chart takes the left 2/3 with Meta at the top of the right column, and the map
 * takes the row under it, beside Mais vendidos. Without the map the chart takes both rows and the ranking goes under the
 * goal; without the chart the blocks go two to a row.
 */
function LowerBlocks({
  chart,
  goal,
  ranking,
  rhythm,
}: {
  chart: React.ReactNode;
  goal: React.ReactNode;
  ranking: React.ReactNode;
  rhythm: React.ReactNode;
}) {
  const placed = chart !== null;
  const mapped = placed && rhythm !== null;
  return (
    <div
      className={cn(
        "grid min-w-0 gap-4 lg:items-start",
        placed
          ? "lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]"
          : "lg:grid-cols-2",
        placed &&
          (mapped ? "lg:grid-rows-[auto_1fr_auto]" : "lg:grid-rows-[auto_1fr]")
      )}
    >
      {goal ? (
        <div
          className={cn(
            "grid min-w-0",
            placed && "lg:col-start-2 lg:row-start-1"
          )}
        >
          {goal}
        </div>
      ) : null}
      {placed ? (
        <div
          className={cn(
            "grid min-w-0 lg:col-start-1 lg:row-start-1",
            "lg:row-span-2"
          )}
        >
          {chart}
        </div>
      ) : null}
      {rhythm ? (
        <div
          className={cn(
            "grid min-w-0",
            mapped && "lg:col-start-1 lg:row-start-3"
          )}
        >
          {rhythm}
        </div>
      ) : null}
      {ranking ? (
        <div
          className={cn(
            "grid min-w-0",
            placed &&
              (mapped
                ? "lg:col-start-2 lg:row-start-3"
                : "lg:col-start-2 lg:row-start-2")
          )}
        >
          {ranking}
        </div>
      ) : null}
    </div>
  );
}

/** While the cards are a skeleton of a shape not known yet, nothing comes after them (`Blocks.pending`). */
function FigureArea({
  attention,
  attentionNotes,
  blocks,
  goal,
  keep,
  measure,
}: {
  attention: React.ReactNode;
  attentionNotes: React.ReactNode;
  blocks: Blocks;
  goal: React.ReactNode;
  /** The cards keep the height they had with figures (no connection and no copy). */
  keep: boolean;
  /** The cards with figures are on the screen: their height is the one to keep. */
  measure: boolean;
}) {
  return (
    <>
      {attention}
      {blocks.main ? (
        // a new box for the figures: the skeleton is replaced, not moved, when "Precisa de ação" comes above them
        <KeptHeight
          keep={keep}
          key={blocks.pending ? "skeleton" : "figures"}
          measure={measure}
        >
          {blocks.main}
        </KeptHeight>
      ) : null}
      {blocks.pending ? null : (
        <>
          {attentionNotes}
          <LowerBlocks
            chart={blocks.chart}
            goal={goal}
            ranking={blocks.ranking}
            rhythm={blocks.rhythm}
          />
        </>
      )}
    </>
  );
}

/**
 * The Início. With a connection, the reads of `useHome`; without one, the matrix of § 7.4: the device's copy (only
 * with the runtime on, for a role that reads the results, with the user's lease in force and no refusal of the
 * session), or "sem números" without it; the goal by the rule of § 7.3; the device's own line in "Precisa de
 * atenção" always, and the stock's lines only with a connection. The chosen tab of the chart lives here, so it
 * outlasts the connection going and coming back.
 */
export function HomePage() {
  const { organization, organizationId, organizations } =
    useCurrentOrganization();
  const { timezone } = organization;
  const activeIds = useMemo(
    () => organizations.map((item) => item.id),
    [organizations]
  );
  const {
    online,
    reads,
    reload,
    reloading,
    retryFigures,
    retryGoals,
    retryRhythm,
    serverNow,
    state,
  } = useHome(organizationId, organization.role, timezone);
  const snapshot = useRuntimeSnapshot();
  const { failed, offline, view } = useOfflineView({
    cardsPending: figuresPending(state),
    figuresFailed: state.figures.status === "error" && state.figures.retryable,
    online,
    organizationId,
    readsReport: reads.report,
    refused: state.sessionRefused || state.copyRefused,
    timezone,
  });
  const canSellOffline = useLocalWorkspace(organizationId) !== null;
  const refused = snapshot?.counts.rejected ?? 0;
  const figures = state.figures.status === "ready" ? state.figures.data : null;
  const goals = state.goals.status === "ready" ? state.goals.data : null;
  const today = figures?.today ?? calendarDayInTimezone(new Date(), timezone);
  const goal = useMemo(
    () => (goals ? pickGoal(goals, today, timezone) : null),
    [goals, today, timezone]
  );
  const firstSteps = useFirstStepsMemory(organizationId);
  const { chosen, periodRow, reloadAll } = useChosenPeriod({
    applies: periodApplies({
      failed,
      readsReport: reads.report,
      state,
      view,
    }),
    now: serverNow(),
    online,
    organizationId,
    reload,
    timezone,
    today,
  });
  const { blocks, updated } = state.sessionRefused
    ? { blocks: NO_BLOCKS, updated: null }
    : pageBlocks({
        canSellOffline,
        chosen,
        failed,
        firstSteps,
        now: new Date(serverNow()),
        offline: view,
        readsReport: reads.report,
        retryFigures,
        retryRhythm,
        state,
        timezone,
        today,
      });
  const { refresh, refreshing } = refreshGesture(
    online,
    state.sessionRefused,
    reloading,
    reloadAll
  );
  const goalBlock = pickGoalBlock({
    goal,
    offline,
    readsGoals: reads.goals,
    retryGoals,
    state,
    view,
  });

  // with the session refused nothing about the stock is known: only this device's own line can be said
  const stock: HomeState["stock"] =
    state.sessionRefused || offline ? { status: "hidden" } : state.stock;
  const attention =
    state.sessionRefused && refused === 0 ? null : (
      <AttentionBlock
        refused={refused}
        soldWithoutCost={
          figures ? figures.month.quality.itemLinesWithUnknownCost : null
        }
        stock={stock}
      />
    );
  // what the check of the stock says when it has no lines: a discreet line under the cards, only with the stock's read
  const attentionNotes =
    state.sessionRefused || !reads.inventory ? null : (
      <AttentionNotes stock={stock} />
    );
  const { explained, offlineText } = offlineLines(
    offline,
    reads.report,
    canSellOffline
  );

  return (
    <div className="grid gap-5 font-sans text-foreground text-sm antialiased">
      <HomeHeader
        explained={explained}
        offlineText={offlineText}
        refresh={refresh}
        updated={refreshing ? REFRESHING_TEXT : updated}
      />
      <ReopenedNotice />
      <ClosedStoreLine activeIds={activeIds} />
      <div
        aria-busy={
          refreshing || (view === null && state.figures.status === "loading")
        }
        className="grid gap-4"
      >
        <PeriodControlProvider value={periodRow}>
          <FigureArea
            attention={attention}
            attentionNotes={attentionNotes}
            blocks={blocks}
            goal={goalBlock}
            keep={explained}
            measure={offline === null && figures !== null && !blocks.pending}
          />
        </PeriodControlProvider>
      </div>
    </div>
  );
}
