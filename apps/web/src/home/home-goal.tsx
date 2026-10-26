import type { GoalReadModel } from "@polaris/contracts";
import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { buttonVariants } from "@/ui/button";
import { MoneyText } from "@/ui/hidden-values";
import { Progress } from "@/ui/progress";
import {
  formatGoalPercent,
  formatGoalValue,
  goalProgressWidth,
  goalTitle,
} from "../dashboard/goal-model";
import {
  MASKED_SPOKEN,
  maskMoney,
  useHiddenValues,
} from "../lib/hidden-values";
import { type GoalView, goalPeriodShort, type OfflineGoal } from "./home-model";
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
  const [hidden] = useHiddenValues();
  const spokenProgress = progress
    ? `${formatGoalValue(goal.kind, progress.value)} de ${formatGoalValue(goal.kind, goal.target)}, ${formatGoalPercent(progress.percent)}`
    : "";
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
          aria-label={`Progresso de ${goalTitle(goal)}`}
          aria-valuetext={
            hidden ? maskMoney(spokenProgress, MASKED_SPOKEN) : spokenProgress
          }
          className="gap-1.5"
          value={goalProgressWidth(progress.percent)}
        >
          <span className="flex w-full flex-wrap items-baseline justify-between gap-x-3 text-sm">
            <span className="tabular-nums">
              <MoneyText
                text={`${formatGoalValue(goal.kind, progress.value)} de ${formatGoalValue(goal.kind, goal.target)}`}
              />
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

/** A goal kept on the device whose period ended: its result is the server's to say (§ 7.3), so no percent. */
function EndedGoal({ goal }: { goal: GoalReadModel }) {
  return (
    <>
      <div className="grid gap-0.5">
        <p className="font-medium">{goalTitle(goal)}</p>
        <p className="text-muted-foreground text-support">
          {goalPeriodShort(goal)}
        </p>
      </div>
      <p className="text-support">
        Esta meta terminou. O resultado sai com conexão.
      </p>
    </>
  );
}

function SettledGoal({
  goal,
  online = true,
}: {
  goal: GoalReadModel;
  online?: boolean;
}) {
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
          <MoneyText
            text={`Chegou a ${formatGoalValue(goal.kind, goal.achievedValue)} de ${formatGoalValue(goal.kind, goal.target)}.`}
          />
        </p>
      )}
      {online ? (
        <a className={cn(LINK, "w-fit")} href="/dashboard?meta=nova">
          Definir meta
        </a>
      ) : null}
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

/**
 * The goal without a connection (§ 7.3, § 7.4): the one the card showed, kept on the device, by the rule of the
 * period; with no copy, "Metas só com conexão.". Setting or seeing the other goals needs the connection: no link.
 */
export function OfflineGoalBlock({ goal }: { goal: OfflineGoal }) {
  let content: React.ReactNode;
  switch (goal.kind) {
    case "active":
      content = goal.ended ? (
        <EndedGoal goal={goal.goal} />
      ) : (
        <ActiveGoal goal={goal.goal} others={0} />
      );
      break;
    case "settled":
      content = <SettledGoal goal={goal.goal} online={false} />;
      break;
    default:
      content = <p className="text-muted-foreground">Metas só com conexão.</p>;
  }
  return (
    <HomeBlock id="home-goal" title="Meta">
      {content}
    </HomeBlock>
  );
}
