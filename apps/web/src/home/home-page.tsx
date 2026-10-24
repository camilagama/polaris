import PlusIcon from "lucide-react/dist/esm/icons/plus";
import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/ui/button";
import { formatUpdatedUntil } from "../dashboard/dashboard-model";
import { useCurrentOrganization } from "../lib/current-organization";
import { calendarDayInTimezone } from "../lib/dates";
import { useRuntimeSnapshot } from "../offline/runtime/runtime-context";
import { AttentionBlock } from "./home-attention";
import { ChartBlock } from "./home-chart";
import {
  ChecklistBlock,
  MonthBlock,
  TodayBlock,
  TopProductsBlock,
} from "./home-figures";
import { GoalBlock } from "./home-goal";
import { pickGoal } from "./home-model";
import { BlockError, BlockSkeleton } from "./home-parts";
import { type HomeState, useHome } from "./use-home";

/**
 * The Início (`/`, desenho t269 v2, § 4 and § 5): "Nova venda" at once, at the top, depending on no read; then Hoje,
 * Mês, Meta, Precisa de atenção, Mais vendidos and the chart, in this order at 360 px, and in two columns from 1024
 * px with Nova venda, Hoje and Mês above the fold (AC-4). A store that never sold sees the checklist in place of the
 * figures (AC-22). Each block reads, waits and fails on its own (§ 5.2). Opening it writes nothing (AC-23): the only
 * write is the settling of a goal whose period ended, which `goal.list` already does when it reads (ADR 0055).
 */

function NewSale() {
  return (
    <a
      className={cn(buttonVariants({ size: "lg" }), "w-full sm:w-auto")}
      href="/sales"
    >
      <PlusIcon aria-hidden="true" data-icon="inline-start" />
      Nova venda
    </a>
  );
}

/** Where the figures are: the skeletons, the error, the checklist, or Hoje and Mês. Returns the chart and the ranking too. */
function figureBlocks(
  state: HomeState,
  onRetry: () => void
): {
  chart: React.ReactNode;
  main: React.ReactNode;
  ranking: React.ReactNode;
  wide: boolean;
} {
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
  const top = figures.data.month.topProducts ?? [];
  return {
    chart: <ChartBlock figures={figures.data} />,
    main: (
      <>
        <TodayBlock figures={figures.data} />
        <MonthBlock figures={figures.data} />
      </>
    ),
    ranking: top.length > 0 ? <TopProductsBlock products={top} /> : null,
    wide: false,
  };
}

export function HomePage() {
  const { organization, organizationId } = useCurrentOrganization();
  const { timezone } = organization;
  const { retryFigures, retryGoals, state } = useHome(
    organizationId,
    organization.role,
    timezone
  );
  const refused = useRuntimeSnapshot()?.counts.rejected ?? 0;
  const figures = state.figures.status === "ready" ? state.figures.data : null;
  const goals = state.goals.status === "ready" ? state.goals.data : null;
  const today = figures?.today ?? calendarDayInTimezone(new Date(), timezone);
  const goal = useMemo(
    () => (goals ? pickGoal(goals, today, timezone) : null),
    [goals, today, timezone]
  );
  const blocks = state.sessionRefused
    ? { chart: null, main: null, ranking: null, wide: true }
    : figureBlocks(state, retryFigures);

  return (
    <div className="grid gap-5 font-sans text-foreground text-sm antialiased">
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="grid gap-1">
          <h1 className="text-title">Início</h1>
          <p
            className="min-h-5 text-muted-foreground text-support"
            id="home-updated"
          >
            {figures
              ? formatUpdatedUntil(figures.month.generatedAt, timezone)
              : null}
          </p>
        </div>
        <NewSale />
      </header>
      <div
        aria-busy={state.figures.status === "loading"}
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
          {state.sessionRefused ? null : (
            <GoalBlock block={state.goals} onRetry={retryGoals} view={goal} />
          )}
          <AttentionBlock
            refused={refused}
            soldWithoutCost={
              figures ? figures.month.quality.itemLinesWithUnknownCost : null
            }
            stock={state.sessionRefused ? { status: "hidden" } : state.stock}
          />
          {blocks.ranking}
        </div>
        {blocks.chart}
      </div>
    </div>
  );
}
