import type { GoalReadModel } from "@polaris/contracts";
import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { buttonVariants } from "@/ui/button";
import { Progress } from "@/ui/progress";
import {
  formatGoalPercent,
  formatGoalValue,
  goalProgressWidth,
  goalTitle,
} from "../dashboard/goal-model";
import { type GoalView, goalPeriodShort } from "./home-model";
import { BlockError, BlockSkeleton, HomeBlock } from "./home-parts";
import type { Block } from "./use-home";

/**
 * The goal of the Início (AC-10, AC-11, § 5.3): the active one that ends first, the one that just settled, or the
 * way to set one. Goals are set and changed on the Resultado: the links take the person there.
 */

const LINK =
  "touch-hit focus-ring rounded-sm text-sm underline decoration-input underline-offset-4 hover:decoration-foreground";

function ActiveGoal({ goal, others }: { goal: GoalReadModel; others: number }) {
  const { progress } = goal;
  let state: string | null = null;
  if (goal.paused) {
    state = "Pausada pelo plano: não é medida";
  } else if (progress?.reached) {
    state = "Meta atingida";
  } else if (progress?.periodEnded) {
    state = "O período desta meta acabou.";
  }
  return (
    <>
      <div className="grid gap-0.5">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
          {goalTitle(goal)}
          {goal.paused ? (
            <Badge variant="warning">Pausada pelo plano</Badge>
          ) : null}
        </p>
        <p className="text-muted-foreground text-support">
          {goalPeriodShort(goal)}
        </p>
      </div>
      {progress && !goal.paused ? (
        <Progress
          aria-valuetext={`${formatGoalValue(goal.kind, progress.value)} de ${formatGoalValue(goal.kind, goal.target)}, ${formatGoalPercent(progress.percent)}`}
          className="gap-1.5"
          value={goalProgressWidth(progress.percent)}
        >
          <span className="flex w-full flex-wrap items-baseline justify-between gap-x-3 text-sm">
            <span className="tabular-nums">
              {`${formatGoalValue(goal.kind, progress.value)} de ${formatGoalValue(goal.kind, goal.target)}`}
            </span>
            <span className="font-medium tabular-nums">
              {formatGoalPercent(progress.percent)}
            </span>
          </span>
        </Progress>
      ) : null}
      {state ? <p className="text-support">{state}</p> : null}
      {others > 0 ? (
        <a className={cn(LINK, "w-fit")} href="/dashboard?meta=lista">
          Ver as outras
        </a>
      ) : null}
    </>
  );
}

function SettledGoal({ goal }: { goal: GoalReadModel }) {
  const reached = goal.status === "completed";
  return (
    <>
      <div className="grid gap-0.5">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
          {goalTitle(goal)}
          <Badge variant={reached ? "ink" : "outline"}>
            {reached ? "Meta atingida" : "Não atingida"}
          </Badge>
        </p>
        <p className="text-muted-foreground text-support">
          {goalPeriodShort(goal)}
        </p>
      </div>
      {goal.achievedValue === null ? null : (
        <p className="text-support tabular-nums">
          {`Chegou a ${formatGoalValue(goal.kind, goal.achievedValue)} de ${formatGoalValue(goal.kind, goal.target)}.`}
        </p>
      )}
      <a className={cn(LINK, "w-fit")} href="/dashboard?meta=nova">
        Definir meta
      </a>
    </>
  );
}

export function GoalBlock({
  block,
  onRetry,
  view,
}: {
  block: Block<GoalReadModel[]>;
  onRetry: () => void;
  view: GoalView | null;
}) {
  if (block.status === "hidden") {
    return null;
  }
  if (block.status === "loading") {
    return <BlockSkeleton label="Carregando a meta…" lines={1} />;
  }
  if (block.status === "error" || view === null) {
    return (
      <HomeBlock id="home-goal" title="Meta">
        <BlockError
          message="Não foi possível carregar a meta."
          onRetry={block.status === "error" && block.retryable ? onRetry : null}
        />
      </HomeBlock>
    );
  }
  return (
    <HomeBlock id="home-goal" title="Meta">
      {view.kind === "active" ? (
        <ActiveGoal goal={view.goal} others={view.others} />
      ) : null}
      {view.kind === "settled" ? <SettledGoal goal={view.goal} /> : null}
      {view.kind === "none" ? (
        <div className="grid gap-3">
          <p className="text-muted-foreground">Nenhuma meta em andamento.</p>
          <a
            className={cn(buttonVariants({ variant: "outline" }), "w-fit")}
            href="/dashboard?meta=nova"
          >
            Definir meta
          </a>
        </div>
      ) : null}
    </HomeBlock>
  );
}
