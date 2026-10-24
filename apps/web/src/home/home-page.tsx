import PlusIcon from "lucide-react/dist/esm/icons/plus";
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/ui/button";
import {
  formatLastConfirmed,
  formatUpdatedUntil,
} from "../dashboard/dashboard-model";
import { useCurrentOrganization } from "../lib/current-organization";
import { browserStorage } from "../lib/current-organization-model";
import { calendarDayInTimezone } from "../lib/dates";
import { OFFLINE_RUNTIME_ENABLED } from "../offline/runtime/enabled";
import { useRuntimeSnapshot } from "../offline/runtime/runtime-context";
import { useSessionOver } from "../offline/runtime/session-ended";
import { useLocalWorkspace } from "../offline/runtime/use-local-workspace";
import { AttentionBlock } from "./home-attention";
import { ChartBlock, type ChartDays } from "./home-chart";
import { type OfflineHome, offlineHome } from "./home-copy";
import {
  ChecklistBlock,
  MonthBlock,
  TodayBlock,
  TopProductsBlock,
} from "./home-figures";
import { GoalBlock, OfflineGoalBlock } from "./home-goal";
import { copyLine, newSaleOfflineText, pickGoal } from "./home-model";
import { BlockError, BlockSkeleton, HomeBlock } from "./home-parts";
import { type HomeFigures, type HomeState, useHome } from "./use-home";

/**
 * The Início (`/`, desenho t269 v2, § 4 and § 5): "Nova venda" at once, at the top, depending on no read; then Hoje,
 * Mês, Meta, Precisa de atenção, Mais vendidos and the chart, in this order at 360 px, and in two columns from 1024
 * px with Nova venda, Hoje and Mês above the fold (AC-4). A store that never sold sees the checklist in place of the
 * figures (AC-22). Each block reads, waits and fails on its own (§ 5.2). Opening it writes nothing (AC-23): the only
 * write is the settling of a goal whose period ended, which `goal.list` already does when it reads (ADR 0055).
 */

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
  wide: boolean;
}

/** Hoje, the month, the ranking and the chart of figures that were read (from the server or from the copy). */
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
    main: (
      <>
        <TodayBlock figures={figures} shown={todayShown && series} />
        <MonthBlock figures={figures} />
      </>
    ),
    ranking: top.length > 0 ? <TopProductsBlock products={top} /> : null,
    wide: false,
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
    return { chart: null, main: null, ranking: null, wide: true };
  }
  if (figures.status === "error") {
    return {
      chart: null,
      main: (
        <BlockError
          className="lg:col-span-2"
          message="Não foi possível carregar os números da loja."
          onRetry={figures.retryable ? onRetry : null}
        />
      ),
      ranking: null,
      wide: true,
    };
  }
  if (figures.status === "loading" || checklist.status === "loading") {
    return {
      chart: (
        <BlockSkeleton
          className="h-72 lg:col-start-1 lg:row-start-2"
          label="Carregando o gráfico…"
          lines={0}
        />
      ),
      main: (
        <>
          <BlockSkeleton label="Carregando os números de hoje…" />
          <BlockSkeleton label="Carregando os números do mês…" lines={3} />
        </>
      ),
      ranking: null,
      wide: false,
    };
  }
  if (checklist.status === "ready" && checklist.data) {
    return {
      chart: null,
      main: <ChecklistBlock checklist={checklist.data} />,
      ranking: null,
      wide: true,
    };
  }
  return readBlocks(figures.data, chart);
}

const NO_BLOCKS: Blocks = {
  chart: null,
  main: null,
  ranking: null,
  wide: true,
};

/** The figures' blocks and the line under the title: the server's, or without a connection the copy's (§ 7.4). */
function pageBlocks({
  chart,
  offline,
  readsReport,
  retryFigures,
  state,
  timezone,
}: {
  chart: { days: ChartDays; onDays: (days: ChartDays) => void };
  offline: OfflineHome | null;
  readsReport: boolean;
  retryFigures: () => void;
  state: HomeState;
  timezone: string | null;
}): { blocks: Blocks; updated: string | null } {
  if (offline === null) {
    return {
      blocks: figureBlocks(state, retryFigures, chart),
      updated:
        state.figures.status === "ready"
          ? formatUpdatedUntil(state.figures.data.month.generatedAt, timezone)
          : null,
    };
  }
  if (!readsReport) {
    return { blocks: NO_BLOCKS, updated: null };
  }
  if (offline.figures === null) {
    return { blocks: NO_FIGURES, updated: null };
  }
  return {
    blocks: readBlocks(offline.figures, chart, offline.figures.todayShown),
    updated: copyLine(
      formatLastConfirmed(offline.figures.confirmedAt, timezone),
      offline.figures.stale
    ),
  };
}

/** Without a connection and with no copy: no figure at all, never a zero (§ 7.4). */
const NO_FIGURES: Blocks = {
  chart: null,
  main: (
    <HomeBlock className="lg:col-span-2" id="home-today" title="Hoje">
      <p className="text-muted-foreground">
        Sem internet e sem números guardados neste aparelho
      </p>
    </HomeBlock>
  ),
  ranking: null,
  wide: true,
};

/** The title and "Nova venda": the part of the page that depends on no read (and on no connection). */
function HomeHeader({
  offlineText,
  updated,
}: {
  offlineText: string | null;
  updated: string | null;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="grid gap-1">
        <h1 className="text-title">Início</h1>
        <p
          className="min-h-5 text-muted-foreground text-support"
          id="home-updated"
        >
          {updated}
        </p>
      </div>
      <NewSale offlineText={offlineText} />
    </header>
  );
}

/**
 * Whether the copy may stand in for the server (§ 7.2): the runtime on, a role that reads the results, the user's own
 * lease in force (the runtime is ready only then) and no refusal of the session, here or by the runtime.
 */
function useCopyAllowed(readsReport: boolean, refused: boolean): boolean {
  const snapshot = useRuntimeSnapshot();
  const sessionOver = useSessionOver();
  return (
    OFFLINE_RUNTIME_ENABLED &&
    readsReport &&
    snapshot?.phase === "ready" &&
    !snapshot.sessionRefused &&
    !refused &&
    !sessionOver
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
  const copyAllowed = useCopyAllowed(reads.report, state.sessionRefused);
  const canSellOffline = useLocalWorkspace(organizationId) !== null;
  const [days, setDays] = useState<ChartDays>("7");
  const chart = { days, onDays: setDays };
  const refused = snapshot?.counts.rejected ?? 0;
  const offline = useMemo(
    () =>
      online
        ? null
        : offlineHome(
            browserStorage(),
            organizationId,
            timezone,
            serverNow(),
            copyAllowed
          ),
    [copyAllowed, online, organizationId, serverNow, timezone]
  );
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
        offline,
        readsReport: reads.report,
        retryFigures,
        state,
        timezone,
      });
  let goalBlock: React.ReactNode = null;
  if (offline && reads.goals) {
    goalBlock = <OfflineGoalBlock goal={offline.goal} />;
  } else if (!(offline || state.sessionRefused)) {
    goalBlock = (
      <GoalBlock block={state.goals} onRetry={retryGoals} view={goal} />
    );
  }

  return (
    <div className="grid gap-5 font-sans text-foreground text-sm antialiased">
      <HomeHeader
        offlineText={offline ? newSaleOfflineText(canSellOffline) : null}
        updated={updated}
      />
      <div
        aria-busy={offline === null && state.figures.status === "loading"}
        className="grid gap-4 lg:grid-cols-2 lg:items-start"
      >
        {blocks.main}
        <div
          className={cn(
            "grid min-w-0 gap-4",
            // the chart sits in the left column from 1024 px; in the source it comes last, as at 360 px
            blocks.wide
              ? "lg:col-span-2 lg:grid-cols-2 lg:items-start"
              : "lg:col-start-2 lg:row-start-2"
          )}
        >
          {goalBlock}
          {/* with the session refused nothing about the stock is known: only this device's own line can be said */}
          {state.sessionRefused && refused === 0 ? null : (
            <AttentionBlock
              offline={offline !== null && reads.inventory}
              refused={refused}
              soldWithoutCost={
                figures ? figures.month.quality.itemLinesWithUnknownCost : null
              }
              stock={
                state.sessionRefused || offline
                  ? { status: "hidden" }
                  : state.stock
              }
            />
          )}
          {blocks.ranking}
        </div>
        {blocks.chart}
      </div>
    </div>
  );
}
