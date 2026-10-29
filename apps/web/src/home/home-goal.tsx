import type { GoalReadModel } from "@polaris/contracts";
import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { buttonVariants } from "@/ui/button";
import { MoneyText } from "@/ui/hidden-values";
import { OnDemandRingChart } from "@/ui/charts/on-demand";
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
import {
  type GoalProjection,
  type GoalView,
  goalDaysLeftText,
  goalPeriodShort,
  type OfflineGoal,
} from "./home-model";
import { BlockError, BlockSkeleton, HomeBlock } from "./home-parts";
import type { Block } from "./use-home";

/**
 * The goal of the Início (AC-10, AC-11, § 5.3): the active one that ends first, the one that just settled, or the
 * way to set one. Goals are set and changed on the Resultado: the links take the person there.
 */

const LINK =
  "touch-hit focus-ring rounded-sm text-sm underline decoration-input underline-offset-4 hover:decoration-foreground";

/** The side of the ring of the goal, and the width of its arc (v7 § 3 item 9). */
const RING_SIZE = 112;
const RING_WIDTH = 10;

/**
 * The color of the ring: the color of the entity the goal measures (v7 § 5), green for the sales (net sales and number
 * of sales) on the first tone of the green ramp, indigo for the estimated result on a faint tone of its own.
 */
function ringColors(kind: GoalReadModel["kind"]): {
  color: "var(--chart-result)" | "var(--chart-sales)";
  track: string;
} {
  return kind === "operating_result"
    ? {
        color: "var(--chart-result)",
        track: "color-mix(in oklch, var(--chart-result) 18%, var(--card))",
      }
    : { color: "var(--chart-sales)", track: "var(--chart-heat-1)" };
}

/**
 * The ring with the percent in its hole. The drawing (Bklit UI's `RingChart`, from the charts chunk) is `aria-hidden`;
 * the box is one image whose name says it in words ("53,4% da meta: R$ 2.670,60 de R$ 5.000,00"), with the amounts
 * hidden when the values are. Until the chunk arrives (or when it cannot) the hole with the percent stands alone.
 */
function GoalRing({
  goal,
  percent,
  spoken,
  width,
}: {
  goal: GoalReadModel;
  percent: string;
  spoken: string;
  width: number;
}) {
  const [hidden] = useHiddenValues();
  return (
    <div
      aria-label={hidden ? maskMoney(spoken, MASKED_SPOKEN) : spoken}
      className="relative grid shrink-0 place-items-center"
      data-goal-ring=""
      role="img"
      style={{ height: RING_SIZE, width: RING_SIZE }}
    >
      <OnDemandRingChart
        className="col-start-1 row-start-1"
        progress={width / 100}
        size={RING_SIZE}
        strokeWidth={RING_WIDTH}
        {...ringColors(goal.kind)}
      />
      <span
        aria-hidden="true"
        className="col-start-1 row-start-1 grid justify-items-center gap-0.5 text-center"
      >
        <span
          className={cn(
            "font-semibold tabular-nums leading-6 tracking-tight",
            // "100,0%" fits the hole of 76 px at 20 px; a goal far past its target is written smaller
            percent.length > 6 ? "text-base" : "text-xl"
          )}
        >
          {percent}
        </span>
        <span className="text-muted-foreground text-xs">da meta</span>
      </span>
    </div>
  );
}

function goalState(goal: GoalReadModel): string | null {
  const { progress } = goal;
  if (goal.paused) {
    return "Pausada pelo plano: não é medida";
  }
  if (progress?.reached) {
    return "Meta atingida";
  }
  if (progress?.periodEnded) {
    return "O período desta meta acabou.";
  }
  return null;
}

/** What the (i) of the goal says of its estimate: the rhythm it is made of. */
const PROJECTION_HELP =
  "Estimativa: a média dos últimos 7 dias repetida até o fim da meta.";

/** The estimate under the amounts (v7 § 3 item 9): where the current rhythm takes the goal. */
function ProjectionLine({ projection }: { projection: GoalProjection }) {
  if (projection.kind === "no_sales") {
    return (
      <p
        className="mt-1.5 text-muted-foreground text-support"
        data-goal-projection="sem-venda"
      >
        Sem vendas nos últimos 7 dias para estimar.
      </p>
    );
  }
  if (projection.kind === "reaches") {
    return (
      <p className="mt-1.5 text-support" data-goal-projection="batida">
        No ritmo atual, a meta deve ser batida{" "}
        {projection.onLastDay ? "até" : "em"} {projection.on}.
      </p>
    );
  }
  return (
    <p className="mt-1.5 text-support" data-goal-projection="">
      No ritmo atual, deve chegar a{" "}
      <span className="font-medium tabular-nums">
        <MoneyText text={projection.value} />
      </span>{" "}
      em {projection.on}.
    </p>
  );
}

function ActiveGoal({
  daysLeft = null,
  goal,
  others,
  projection = null,
}: {
  /** "faltam 6 dias", with a connection only. */
  daysLeft?: string | null;
  goal: GoalReadModel;
  others: number;
  /** The estimate by the rhythm of the last 7 days, with a connection and the daily series only. */
  projection?: GoalProjection | null;
}) {
  const { progress } = goal;
  const state = goalState(goal);
  const period = goalPeriodShort(goal);
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
          {daysLeft ? `${period} · ${daysLeft}` : period}
        </p>
      </div>
      {progress && !goal.paused ? (
        <div className="flex min-w-0 items-center gap-4">
          <GoalRing
            goal={goal}
            percent={formatGoalPercent(progress.percent)}
            spoken={`${formatGoalPercent(progress.percent)} da meta: ${formatGoalValue(goal.kind, progress.value)} de ${formatGoalValue(goal.kind, goal.target)}`}
            width={goalProgressWidth(progress.percent)}
          />
          <div className="grid min-w-0 gap-0.5">
            <p className="font-semibold text-lg tabular-nums leading-7 tracking-tight">
              <MoneyText text={formatGoalValue(goal.kind, progress.value)} />
            </p>
            <p className="text-muted-foreground text-support tabular-nums">
              <MoneyText
                text={`de ${formatGoalValue(goal.kind, goal.target)}`}
              />
            </p>
            {projection ? <ProjectionLine projection={projection} /> : null}
          </div>
        </div>
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

/** No goal: the title of the block and the way to set one, nothing else (the button says what the sentence did). */
function NoGoal() {
  return (
    <a
      className={cn(buttonVariants({ variant: "outline" }), "w-fit")}
      href="/dashboard?meta=nova"
    >
      Definir meta
    </a>
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
  projection,
  today,
  view,
}: {
  block: Block<GoalReadModel[]>;
  onRetry: () => void;
  /** The estimate of the active goal, when what it needs is known (`goalProjection`). */
  projection: GoalProjection | null;
  /** The store's today by the server's clock, for the days left; null when it is not known (no figures read). */
  today: string | null;
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
    <HomeBlock
      id="home-goal"
      title="Meta"
      {...(view.kind === "active" && projection
        ? { help: { about: "Meta", text: PROJECTION_HELP } }
        : {})}
    >
      {view.kind === "active" ? (
        <ActiveGoal
          daysLeft={today ? goalDaysLeftText(view.goal, today) : null}
          goal={view.goal}
          others={view.others}
          projection={projection}
        />
      ) : null}
      {view.kind === "settled" ? <SettledGoal goal={view.goal} /> : null}
      {view.kind === "none" ? <NoGoal /> : null}
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
