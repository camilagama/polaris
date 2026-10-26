import PlusIcon from "lucide-react/dist/esm/icons/plus";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/ui/button";
import { HideValuesButton } from "@/ui/hidden-values";
import { formatLastConfirmed } from "../dashboard/dashboard-model";
import { useCurrentOrganization } from "../lib/current-organization";
import { browserStorage } from "../lib/current-organization-model";
import { calendarDayInTimezone } from "../lib/dates";
import { OFFLINE_RUNTIME_ENABLED } from "../offline/runtime/enabled";
import {
  useOfflineRuntime,
  useRuntimeSnapshot,
} from "../offline/runtime/runtime-context";
import { useSessionOver } from "../offline/runtime/session-ended";
import { useLocalWorkspace } from "../offline/runtime/use-local-workspace";
import { AttentionBlock } from "./home-attention";
import { ChartBlock, type ChartDays } from "./home-chart";
import { type OfflineHome, offlineHome } from "./home-copy";
import { ChecklistBlock, TopProductsBlock } from "./home-figures";
import { GoalBlock, OfflineGoalBlock } from "./home-goal";
import { KpiCards } from "./home-kpi-cards";
import {
  copyLine,
  type GoalView,
  goalProjection,
  homeUpdatedLine,
  monthTitle,
  newSaleOfflineText,
  pickGoal,
} from "./home-model";
import { BlockError, BlockSkeleton, HomeBlock } from "./home-parts";
import { type HomeFigures, type HomeState, useHome } from "./use-home";

/**
 * The Início (`/`, desenho t269 v2, § 4 and § 5): "Nova venda" at once, at the top, depending on no read; then Hoje,
 * Mês, Meta, Precisa de atenção, Mais vendidos and the chart, in this order at 360 px, and in two columns from 1024
 * px with Nova venda, Hoje and Mês above the fold (AC-4). A store that never sold sees the checklist in place of the
 * figures (AC-22). Each block reads, waits and fails on its own (§ 5.2). Opening it writes nothing (AC-23): the only
 * write is the settling of a goal whose period ended, which `goal.list` already does when it reads (ADR 0055).
 */

/** The places of the blocks beside the chart from 1024 px: the right column, one row each. */
const SIDE = [
  "lg:col-start-2 lg:row-start-1",
  "lg:col-start-2 lg:row-start-2",
  "lg:col-start-2 lg:row-start-3",
] as const;

const NO_COPY_TEXT = "Sem internet e sem números guardados neste aparelho";

/** "Nova venda", and without a connection what it can do then (AC-30), said under it. */
function NewSale({ offlineText }: { offlineText: string | null }) {
  return (
    <div className="grid w-full gap-1.5 sm:w-auto sm:justify-items-end">
      <a
        aria-describedby={offlineText ? "home-new-sale-offline" : undefined}
        className={cn(buttonVariants({ size: "lg" }), "w-full sm:w-auto")}
        href="/sales"
      >
        <PlusIcon aria-hidden="true" data-icon="inline-start" />
        Nova venda
      </a>
      {offlineText ? (
        <p
          className="text-muted-foreground text-support sm:text-right"
          id="home-new-sale-offline"
        >
          {offlineText}
        </p>
      ) : null}
    </div>
  );
}

interface Blocks {
  chart: React.ReactNode;
  main: React.ReactNode;
  ranking: React.ReactNode;
}

/** The KPI cards, the ranking and the chart of figures that were read (from the server or from the copy). */
function readBlocks(
  figures: HomeFigures,
  chart: { days: ChartDays; onDays: (days: ChartDays) => void },
  todayShown = true
): Blocks {
  const top = figures.month.topProducts ?? [];
  // a copy kept before the daily series existed: the totals stand, nothing of the series is drawn (ADR 0056, D2)
  const series =
    figures.month.daily !== undefined && figures.before.daily !== undefined;
  return {
    chart: series ? (
      <ChartBlock days={chart.days} figures={figures} onDays={chart.onDays} />
    ) : null,
    main: <KpiCards figures={figures} todayShown={todayShown && series} />,
    ranking: top.length > 0 ? <TopProductsBlock products={top} /> : null,
  };
}

/** Where the figures are: the skeletons, the error, the checklist, or Hoje and Mês. Returns the chart and the ranking too. */
function figureBlocks(
  state: HomeState,
  onRetry: () => void,
  chart: { days: ChartDays; onDays: (days: ChartDays) => void }
): Blocks {
  const { checklist, figures } = state;
  if (figures.status === "hidden") {
    return { chart: null, main: null, ranking: null };
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
    };
  }
  if (figures.status === "loading" || checklist.status === "loading") {
    return {
      chart: (
        <BlockSkeleton
          className="h-72"
          label="Carregando o gráfico…"
          lines={0}
        />
      ),
      main: (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
          <BlockSkeleton
            className="col-span-2 lg:col-span-1"
            label="Carregando os números de hoje…"
          />
          <BlockSkeleton
            className="col-span-2 lg:col-span-1"
            label="Carregando os números do mês…"
          />
          <BlockSkeleton label="Carregando o resultado estimado…" />
          <BlockSkeleton label="Carregando o ticket médio…" />
        </div>
      ),
      ranking: null,
    };
  }
  if (checklist.status === "ready" && checklist.data) {
    return {
      chart: null,
      main: <ChecklistBlock checklist={checklist.data} />,
      ranking: null,
    };
  }
  return readBlocks(figures.data, chart);
}

const NO_BLOCKS: Blocks = {
  chart: null,
  main: null,
  ranking: null,
};

/** The figures' blocks and the line under the title: the server's, or without a connection the copy's (§ 7.4). */
function pageBlocks({
  chart,
  offline,
  readsReport,
  retryFigures,
  state,
  timezone,
  today,
}: {
  chart: { days: ChartDays; onDays: (days: ChartDays) => void };
  offline: OfflineHome | null;
  readsReport: boolean;
  retryFigures: () => void;
  state: HomeState;
  timezone: string | null;
  today: string;
}): { blocks: Blocks; updated: string | null } {
  if (offline === null) {
    return {
      blocks: figureBlocks(state, retryFigures, chart),
      updated:
        state.figures.status === "ready"
          ? homeUpdatedLine(state.figures.data.month.generatedAt, timezone)
          : null,
    };
  }
  if (!readsReport) {
    return { blocks: NO_BLOCKS, updated: null };
  }
  if (offline.figures === null) {
    return { blocks: noFigures(today), updated: null };
  }
  return {
    blocks: readBlocks(offline.figures, chart, offline.figures.todayShown),
    updated: copyLine(
      formatLastConfirmed(offline.figures.confirmedAt, timezone),
      offline.figures.stale
    ),
  };
}

/**
 * Without a connection and with no copy: no figure at all, never a zero (§ 7.4). The cards keep the places they have
 * with the copy (Hoje on the left, the month on the right), so nothing changes places when the connection is back.
 */
function noFigures(today: string): Blocks {
  return {
    chart: null,
    main: (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        <HomeBlock
          className="col-span-2 lg:col-span-1"
          id="home-today"
          title="Vendas hoje"
        >
          <p className="text-muted-foreground">{NO_COPY_TEXT}</p>
        </HomeBlock>
        <HomeBlock
          className="col-span-2 lg:col-span-1"
          id="home-month"
          title={`Vendas em ${monthTitle(today).toLowerCase()}`}
        >
          <p className="text-muted-foreground">{NO_COPY_TEXT}</p>
        </HomeBlock>
      </div>
    ),
    ranking: null,
  };
}

/**
 * The title, "Esconder valores" and "Nova venda": the part of the page that depends on no read (and on no connection).
 * On a phone the eye is an icon button in the corner of the title and "Nova venda" takes the whole width (v7 § 3).
 */
function HomeHeader({
  offlineText,
  updated,
}: {
  offlineText: string | null;
  updated: string | null;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="flex min-w-0 flex-1 items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <h1 className="text-title">Início</h1>
          <p
            className="min-h-5 text-muted-foreground text-support"
            id="home-updated"
          >
            {updated}
          </p>
        </div>
        <HideValuesButton className="md:hidden" />
      </div>
      <div className="flex w-full items-start gap-2 sm:w-auto">
        <HideValuesButton className="max-md:hidden" />
        <NewSale offlineText={offlineText} />
      </div>
    </header>
  );
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
function useOfflineClock(online: boolean, serverNow: () => number): number {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    if (online) {
      return;
    }
    setNow(serverNow());
    const timer = window.setInterval(() => setNow(serverNow()), 60_000);
    return () => window.clearInterval(timer);
  }, [online, serverNow]);
  return now;
}

/**
 * What the page shows without a connection (the copy, § 7.4), and, once the connection is back, the copy still on the
 * screen until the first read answers: no skeletons and no jump of the page.
 */
function useOfflineView({
  figuresLoading,
  online,
  organizationId,
  readsReport,
  refused,
  serverNow,
  timezone,
}: {
  figuresLoading: boolean;
  online: boolean;
  organizationId: string;
  readsReport: boolean;
  refused: boolean;
  serverNow: () => number;
  timezone: string | null;
}): { offline: OfflineHome | null; view: OfflineHome | null } {
  const copyAllowed = useCopyAllowed(organizationId, readsReport, refused);
  const clock = useOfflineClock(online, serverNow);
  const offline = useMemo(
    () =>
      online
        ? null
        : offlineHome(
            browserStorage(),
            organizationId,
            timezone,
            // the state of the clock may be of before the connection went: never earlier than now
            Math.max(clock, serverNow()),
            copyAllowed
          ),
    [clock, copyAllowed, online, organizationId, serverNow, timezone]
  );
  // the connection is back: the copy stays on the screen until the first read answers (no skeletons, no jump)
  const keptCopy = useRef<OfflineHome | null>(null);
  if (offline) {
    // only figures are worth keeping: "sem internet" never stays once the connection is back
    keptCopy.current = offline.figures ? offline : null;
  } else if (!figuresLoading) {
    keptCopy.current = null;
  }
  const view = offline ?? keptCopy.current;
  return { offline, view };
}

/** The goal's card: the copy's without a connection (and until the first read after it), the server's otherwise. */
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
 * The blocks under the KPI cards. The source has the order of a phone (Atenção, Meta, the chart, Mais vendidos, v7
 * § 3); from 1024 px the chart takes the left 2/3 and the other blocks stack on the right, the last row taking what is
 * left over, so no gap opens between them.
 */
function LowerBlocks({
  attention,
  chart,
  goal,
  ranking,
}: {
  attention: React.ReactNode;
  chart: React.ReactNode;
  goal: React.ReactNode;
  ranking: React.ReactNode;
}) {
  const placed = chart !== null;
  return (
    <div
      className={cn(
        "grid min-w-0 gap-4 lg:items-start",
        placed
          ? "lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:grid-rows-[auto_auto_1fr]"
          : "lg:grid-cols-2"
      )}
    >
      {attention ? (
        <div className={cn("grid min-w-0", placed && SIDE[0])}>{attention}</div>
      ) : null}
      {goal ? (
        <div className={cn("grid min-w-0", placed && SIDE[1])}>{goal}</div>
      ) : null}
      {placed ? (
        <div className="grid min-w-0 lg:col-start-1 lg:row-span-3 lg:row-start-1">
          {chart}
        </div>
      ) : null}
      {ranking ? (
        <div className={cn("grid min-w-0", placed && SIDE[2])}>{ranking}</div>
      ) : null}
    </div>
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
  const { organization, organizationId } = useCurrentOrganization();
  const { timezone } = organization;
  const { online, reads, retryFigures, retryGoals, serverNow, state } = useHome(
    organizationId,
    organization.role,
    timezone
  );
  const snapshot = useRuntimeSnapshot();
  const { offline, view } = useOfflineView({
    figuresLoading: state.figures.status === "loading",
    online,
    organizationId,
    readsReport: reads.report,
    refused: state.sessionRefused || state.copyRefused,
    serverNow,
    timezone,
  });
  const canSellOffline = useLocalWorkspace(organizationId) !== null;
  const [days, setDays] = useState<ChartDays>("7");
  const chart = { days, onDays: setDays };
  const refused = snapshot?.counts.rejected ?? 0;
  const figures = state.figures.status === "ready" ? state.figures.data : null;
  const goals = state.goals.status === "ready" ? state.goals.data : null;
  const today = figures?.today ?? calendarDayInTimezone(new Date(), timezone);
  const goal = useMemo(
    () => (goals ? pickGoal(goals, today, timezone) : null),
    [goals, today, timezone]
  );
  const { blocks, updated } = state.sessionRefused
    ? { blocks: NO_BLOCKS, updated: null }
    : pageBlocks({
        chart,
        offline: view,
        readsReport: reads.report,
        retryFigures,
        state,
        timezone,
        today,
      });
  const goalBlock = pickGoalBlock({
    goal,
    offline,
    readsGoals: reads.goals,
    retryGoals,
    state,
    view,
  });

  // with the session refused nothing about the stock is known: only this device's own line can be said
  const attention =
    state.sessionRefused && refused === 0 ? null : (
      <AttentionBlock
        offline={offline !== null && reads.inventory}
        refused={refused}
        soldWithoutCost={
          figures ? figures.month.quality.itemLinesWithUnknownCost : null
        }
        stock={
          state.sessionRefused || offline ? { status: "hidden" } : state.stock
        }
      />
    );

  return (
    <div className="grid gap-5 font-sans text-foreground text-sm antialiased">
      <HomeHeader
        offlineText={offline ? newSaleOfflineText(canSellOffline) : null}
        updated={updated}
      />
      <div
        aria-busy={view === null && state.figures.status === "loading"}
        className="grid gap-4"
      >
        {blocks.main}
        <LowerBlocks
          attention={attention}
          chart={blocks.chart}
          goal={goalBlock}
          ranking={blocks.ranking}
        />
      </div>
    </div>
  );
}
