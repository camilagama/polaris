import { MoneyText } from "@/ui/hidden-values";
import {
  MASKED_SPOKEN,
  maskMoney,
  useHiddenValues,
} from "../lib/hidden-values";
import type { GoalReadModel } from "@polaris/contracts";
import { useCallback, useState } from "react";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card, CardContent } from "@/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Progress, ProgressValue } from "@/ui/progress";
import { focusLater } from "../lib/focus";
import { formatCalendarDate } from "../lib/format";
import { LimitHelp } from "../subscription/limit-help";
import type { LimitHelpView } from "../subscription/limit-help-model";
import { GoalEditForm } from "./goal-form";
import { GoalHistoryBody, GoalHistoryToggle } from "./goal-history";
import {
  formatGoalPercent,
  formatGoalValue,
  type GoalEditInput,
  goalBadgeVariant,
  goalFinalDate,
  goalKindLabel,
  goalNotStarted,
  goalPeriodText,
  goalProgressWidth,
  goalStatusLabel,
  goalTitle,
} from "./goal-model";
import type { GoalOutcome } from "./use-goal-commands";

interface GoalCardProps {
  /** The command being sent (its key), or null; any of them locks the buttons. */
  busyKey: string | null;
  goal: GoalReadModel;
  onCancel: (goal: GoalReadModel) => Promise<GoalOutcome>;
  onSave: (goal: GoalReadModel, input: GoalEditInput) => Promise<GoalOutcome>;
  organizationId: string;
  /** What goes with a goal paused by the plan: the way to the Pro (corte 1.6). */
  pausedHelp?: LimitHelpView | null;
  timezone: string | null;
  /** The organization's today, YYYY-MM-DD. */
  today: string;
}

const MUTED = "text-muted-foreground text-support";

/**
 * The text actions of a card: 32 px with a 44 px area, bled out to the card's padding so the words align with the
 * title. Between two lines of them the gap is 16 px, so the areas of 44 px do not meet.
 */
const ACTIONS = "-mx-2 -mb-1 flex flex-wrap gap-x-1 gap-y-4";

function GoalHeader({ goal, today }: { goal: GoalReadModel; today: string }) {
  const waiting = goal.status === "active" && goalNotStarted(goal, today);
  return (
    <div className="grid gap-0.5">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-section">{goalTitle(goal)}</h4>
        <Badge variant={goalBadgeVariant(goal.status, goal.paused)}>
          {goal.paused ? "Pausada pelo plano" : goalStatusLabel(goal.status)}
        </Badge>
      </div>
      <p className={MUTED}>
        {goal.name ? `${goalKindLabel(goal.kind)} · ` : ""}
        {goalPeriodText(goal)}
        {waiting ? ` · começa em ${formatCalendarDate(goal.startsOn)}` : ""}
      </p>
    </div>
  );
}

/** The target as the progress reads it: a count says what it counts. */
function progressTargetText(goal: GoalReadModel): string {
  const text = formatGoalValue(goal.kind, goal.target);
  if (goal.kind !== "sale_count") {
    return text;
  }
  return goal.target === "1" ? `${text} venda` : `${text} vendas`;
}

function GoalProgress({
  goal,
  pausedHelp = null,
}: {
  goal: GoalReadModel;
  pausedHelp?: LimitHelpView | null;
}) {
  const { progress } = goal;
  const [hidden] = useHiddenValues();
  const targetText = progressTargetText(goal);
  if (goal.paused) {
    return (
      <p className={MUTED}>
        Alvo: <MoneyText text={targetText} />. Seu plano permite menos metas em
        andamento do que você tem, então esta meta está pausada: ela não é
        medida nem pode ser editada, mas continua aqui. Você pode cancelá-la, ou
        ela volta quando o plano permitir.
        <LimitHelp help={pausedHelp} />
      </p>
    );
  }
  if (progress === null) {
    return (
      <p className={MUTED}>
        Alvo: <MoneyText text={targetText} />. O progresso não está disponível
        agora; atualize as metas.
      </p>
    );
  }
  const width = goalProgressWidth(progress.percent);
  const spoken = (text: string) =>
    hidden ? maskMoney(text, MASKED_SPOKEN) : text;
  const valueText = formatGoalValue(goal.kind, progress.value);
  const percentText = formatGoalPercent(progress.percent);
  return (
    <Progress
      aria-label={`Progresso de ${goalTitle(goal)}`}
      aria-valuetext={spoken(`${valueText} de ${targetText}, ${percentText}`)}
      value={width}
    >
      <span className="font-medium text-sm tabular-nums">
        <span className="font-semibold">
          <MoneyText text={valueText} />
        </span>{" "}
        <span className="font-normal text-muted-foreground">
          de <MoneyText text={targetText} />
        </span>
      </span>
      <ProgressValue className="font-medium text-foreground">
        {() => percentText}
      </ProgressValue>
    </Progress>
  );
}

function SettledResult({
  goal,
  timezone,
}: {
  goal: GoalReadModel;
  timezone: string | null;
}) {
  const date = goalFinalDate(goal, timezone);
  const targetText = progressTargetText(goal);
  const achieved =
    goal.achievedValue === null
      ? null
      : formatGoalValue(goal.kind, goal.achievedValue);
  if (goal.status === "completed") {
    return (
      <p className="text-muted-foreground text-support">
        Alvo de <MoneyText text={targetText} />
        <MoneyText
          text={achieved ? ` atingido com ${achieved}` : " atingido"}
        />{" "}
        (conferido em {date}).
      </p>
    );
  }
  if (goal.status === "missed") {
    return (
      <p className="text-muted-foreground text-support">
        O período terminou sem atingir o alvo de <MoneyText text={targetText} />
        <MoneyText text={achieved ? `: o resultado foi ${achieved}` : ""} />.
        Encerrada em {date}.
      </p>
    );
  }
  return (
    <p className="text-muted-foreground text-support">
      Alvo de <MoneyText text={targetText} />. Cancelada em {date}.
    </p>
  );
}

/** A goal that is over (completed, missed or cancelled): read only, on a flat tinted card. */
export function SettledGoalCard({
  goal,
  organizationId,
  timezone,
  today,
}: Pick<GoalCardProps, "goal" | "organizationId" | "timezone" | "today">) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const handleHistory = useCallback(() => setHistoryOpen((open) => !open), []);
  return (
    <Card className="bg-muted/30 shadow-none">
      <CardContent className="grid gap-3">
        <GoalHeader goal={goal} today={today} />
        <SettledResult goal={goal} timezone={timezone} />
        <div className={ACTIONS}>
          <GoalHistoryToggle
            goal={goal}
            onToggle={handleHistory}
            open={historyOpen}
          />
        </div>
        <GoalHistoryBody
          goal={goal}
          open={historyOpen}
          organizationId={organizationId}
          timezone={timezone}
        />
      </CardContent>
    </Card>
  );
}

type Mode = "cancel" | "edit" | "idle";

/** A button that is off for a reason keeps its place in the focus order. */
const OFF = "aria-disabled:pointer-events-none aria-disabled:opacity-50";

interface CancelDialogProps {
  busyKey: string | null;
  goal: GoalReadModel;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

/** Cancelling is final, so it takes a second step: a dialog that says what happens before the button that does it. */
function CancelDialog({
  busyKey,
  goal,
  onConfirm,
  onOpenChange,
  open,
}: CancelDialogProps) {
  const busy = busyKey !== null;
  const thisBusy = busyKey === `cancel:${goal.id}`;
  const handleOpenChange = useCallback(
    (next: boolean) => {
      // no way out while the command is on its way: the answer decides what the screen shows
      if (!thisBusy) {
        onOpenChange(next);
      }
    },
    [onOpenChange, thisBusy]
  );
  const handleBack = useCallback(() => {
    if (!busy) {
      onOpenChange(false);
    }
  }, [busy, onOpenChange]);
  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Cancelar a meta {goalTitle(goal)}?</DialogTitle>
          <DialogDescription>
            Cancelar a meta a encerra: ela fica na lista só para leitura e isso
            não poderá ser desfeito.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-3">
          <Button
            aria-disabled={busy || undefined}
            className={OFF}
            onClick={handleBack}
            type="button"
            variant="outline"
          >
            Voltar
          </Button>
          <Button
            aria-disabled={busy || undefined}
            className={OFF}
            onClick={busy ? undefined : onConfirm}
            type="button"
            variant="destructive"
          >
            {thisBusy ? "Cancelando…" : "Confirmar cancelamento"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const CANCEL_TEXT = "text-destructive hover:bg-destructive/10";

interface ActiveActionsProps {
  busyKey: string | null;
  goal: GoalReadModel;
  historyOpen: boolean;
  mode: Mode;
  onAskCancel: () => void;
  onEdit: () => void;
  onHistory: () => void;
}

/** Editar, Histórico do alvo and Cancelar meta: text buttons. While the edit form is open, only the history stays. */
function ActiveActions({
  busyKey,
  goal,
  historyOpen,
  mode,
  onAskCancel,
  onEdit,
  onHistory,
}: ActiveActionsProps) {
  const title = goalTitle(goal);
  const editing = mode === "edit";
  return (
    <div className={ACTIONS}>
      {goal.paused || editing ? null : (
        <Button
          aria-label={`Editar meta ${title}`}
          disabled={busyKey !== null}
          onClick={onEdit}
          size="sm"
          type="button"
          variant="ghost"
        >
          Editar
        </Button>
      )}
      <GoalHistoryToggle goal={goal} onToggle={onHistory} open={historyOpen} />
      {editing ? null : (
        <Button
          aria-label={`Cancelar meta ${title}`}
          className={CANCEL_TEXT}
          disabled={busyKey !== null}
          onClick={onAskCancel}
          size="sm"
          type="button"
          variant="ghost"
        >
          Cancelar meta
        </Button>
      )}
    </div>
  );
}

/** A goal in progress: its figures and bar, and the way to change its name and target or to cancel it. */
export function ActiveGoalCard({
  busyKey,
  goal,
  onCancel,
  onSave,
  organizationId,
  pausedHelp = null,
  timezone,
  today,
}: GoalCardProps) {
  const [mode, setMode] = useState<Mode>("idle");
  const [historyOpen, setHistoryOpen] = useState(false);

  const handleSave = useCallback(
    async (input: GoalEditInput) => {
      const outcome = await onSave(goal, input);
      if (outcome !== "failed") {
        setMode("idle");
      }
      return outcome === "ok";
    },
    [goal, onSave]
  );
  // whatever the answer, the dialog closes: what happened is said above the list, where the dialog would hide it
  const handleCancelConfirm = useCallback(async () => {
    await onCancel(goal);
    setMode("idle");
  }, [goal, onCancel]);
  const handleEdit = useCallback(() => {
    setMode("edit");
    focusLater(() =>
      document.getElementById(`goal-edit-${goal.id}-target`)?.focus()
    );
  }, [goal.id]);
  const handleAskCancel = useCallback(() => setMode("cancel"), []);
  const handleDialog = useCallback(
    (open: boolean) => setMode(open ? "cancel" : "idle"),
    []
  );
  const handleCloseEdit = useCallback(() => setMode("idle"), []);
  const handleHistory = useCallback(() => setHistoryOpen((open) => !open), []);

  return (
    <Card>
      <CardContent className="grid gap-3">
        <GoalHeader goal={goal} today={today} />
        <GoalProgress goal={goal} pausedHelp={pausedHelp} />
        {mode === "edit" ? (
          <GoalEditForm
            disabled={busyKey !== null}
            goal={goal}
            key={goal.version}
            onCancel={handleCloseEdit}
            onSave={handleSave}
            saving={busyKey === `update:${goal.id}`}
          />
        ) : null}
        <ActiveActions
          busyKey={busyKey}
          goal={goal}
          historyOpen={historyOpen}
          mode={mode}
          onAskCancel={handleAskCancel}
          onEdit={handleEdit}
          onHistory={handleHistory}
        />
        <GoalHistoryBody
          goal={goal}
          open={historyOpen}
          organizationId={organizationId}
          timezone={timezone}
        />
        <CancelDialog
          busyKey={busyKey}
          goal={goal}
          onConfirm={handleCancelConfirm}
          onOpenChange={handleDialog}
          open={mode === "cancel"}
        />
      </CardContent>
    </Card>
  );
}
