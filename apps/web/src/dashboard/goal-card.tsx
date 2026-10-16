import type { GoalReadModel } from "@polaris/contracts";
import { useCallback, useState } from "react";
import { focusLater } from "../lib/focus";
import { formatCalendarDate } from "../lib/format";
import { GoalEditForm } from "./goal-form";
import { GoalHistory } from "./goal-history";
import {
  formatGoalPercent,
  formatGoalValue,
  type GoalEditInput,
  goalFinalDate,
  goalKindLabel,
  goalNotStarted,
  goalPeriodText,
  goalProgressWidth,
  goalStatusClass,
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
  timezone: string | null;
  /** The organization's today, YYYY-MM-DD. */
  today: string;
}

function GoalHeader({ goal, today }: { goal: GoalReadModel; today: string }) {
  const waiting = goal.status === "active" && goalNotStarted(goal, today);
  return (
    <div className="goal-card-header">
      <div className="goal-card-title-row">
        <h4>{goalTitle(goal)}</h4>
        <span
          className={`category-status ${goal.paused ? "status-archived" : goalStatusClass(goal.status)}`}
        >
          {goal.paused ? "Pausada pelo plano" : goalStatusLabel(goal.status)}
        </span>
      </div>
      <p className="goal-card-meta">
        {goal.name ? `${goalKindLabel(goal.kind)} · ` : ""}
        {goalPeriodText(goal)}
      </p>
      {waiting ? (
        <p className="goal-card-meta goal-card-note">
          Começa em {formatCalendarDate(goal.startsOn)}
        </p>
      ) : null}
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

function GoalProgress({ goal }: { goal: GoalReadModel }) {
  const { progress } = goal;
  const targetText = progressTargetText(goal);
  if (goal.paused) {
    return (
      <p className="goal-card-meta">
        Alvo: {targetText}. Seu plano permite menos metas em andamento do que
        você tem, então esta meta está pausada: ela não é medida nem pode ser
        editada, mas continua aqui. Você pode cancelá-la, ou ela volta quando o
        plano permitir.
      </p>
    );
  }
  if (progress === null) {
    return (
      <p className="goal-card-meta">
        Alvo: {targetText}. O progresso não está disponível agora; atualize as
        metas.
      </p>
    );
  }
  const width = goalProgressWidth(progress.percent);
  const valueText = formatGoalValue(goal.kind, progress.value);
  const percentText = formatGoalPercent(progress.percent);
  return (
    <div className="goal-progress">
      <p className="goal-progress-text">
        <span className="goal-progress-value">{valueText}</span> de {targetText}
        <span className="goal-progress-percent">{percentText}</span>
      </p>
      <div
        aria-label={`Progresso de ${goalTitle(goal)}`}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={width}
        aria-valuetext={`${valueText} de ${targetText}, ${percentText}`}
        className="goal-bar"
        role="progressbar"
      >
        <div className="goal-bar-fill" style={{ width: `${width}%` }} />
      </div>
    </div>
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
      <>
        <p className="goal-card-meta">
          Alvo de {targetText}
          {achieved ? ` atingido com ${achieved}` : " atingido"} (conferido em{" "}
          {date}).
        </p>
        <p className="goal-card-hint">
          Uma meta concluída continua concluída, mesmo que devoluções
          posteriores reduzam os números.
        </p>
      </>
    );
  }
  if (goal.status === "missed") {
    return (
      <p className="goal-card-meta">
        O período terminou sem atingir o alvo de {targetText}
        {achieved ? `: o resultado foi ${achieved}` : ""}. Encerrada em {date}.
      </p>
    );
  }
  return (
    <p className="goal-card-meta">
      Alvo de {targetText}. Cancelada em {date}.
    </p>
  );
}

/** A goal that is over (completed, missed or cancelled): read only. */
export function SettledGoalCard({
  goal,
  organizationId,
  timezone,
  today,
}: Pick<GoalCardProps, "goal" | "organizationId" | "timezone" | "today">) {
  return (
    <article className="goal-card is-settled">
      <GoalHeader goal={goal} today={today} />
      <SettledResult goal={goal} timezone={timezone} />
      <GoalHistory
        goal={goal}
        organizationId={organizationId}
        timezone={timezone}
      />
    </article>
  );
}

type Mode = "cancel" | "edit" | "idle";

interface ActiveActionsProps {
  busyKey: string | null;
  goal: GoalReadModel;
  mode: Mode;
  onCancelConfirm: () => void;
  onMode: (mode: Mode) => void;
}

function CancelConfirmation({
  busyKey,
  goal,
  onCancelConfirm,
  onMode,
}: Omit<ActiveActionsProps, "mode">) {
  const handleBack = useCallback(() => onMode("idle"), [onMode]);
  const thisBusy = busyKey === `cancel:${goal.id}`;
  return (
    <fieldset className="goal-confirmation">
      <legend className="visually-hidden">
        Confirmar o cancelamento de {goalTitle(goal)}
      </legend>
      <p>
        Cancelar a meta a encerra: ela fica na lista só para leitura e isso não
        poderá ser desfeito.
      </p>
      <div className="goal-actions">
        <button
          className="danger-button"
          disabled={busyKey !== null}
          onClick={onCancelConfirm}
          type="button"
        >
          {thisBusy ? "Cancelando…" : "Confirmar cancelamento"}
        </button>
        <button
          className="quiet-button"
          disabled={busyKey !== null}
          onClick={handleBack}
          type="button"
        >
          Voltar
        </button>
      </div>
    </fieldset>
  );
}

function ActiveActions(props: ActiveActionsProps) {
  const { busyKey, goal, mode, onMode } = props;
  const handleEdit = useCallback(() => {
    onMode("edit");
    focusLater(() =>
      document.getElementById(`goal-edit-${goal.id}-target`)?.focus()
    );
  }, [goal.id, onMode]);
  const handleAskCancel = useCallback(() => onMode("cancel"), [onMode]);
  if (mode === "cancel") {
    return <CancelConfirmation {...props} />;
  }
  if (mode === "edit") {
    return null;
  }
  const title = goalTitle(goal);
  return (
    <div className="goal-actions">
      {goal.paused ? null : (
        <button
          aria-label={`Editar meta ${title}`}
          className="quiet-button"
          disabled={busyKey !== null}
          onClick={handleEdit}
          type="button"
        >
          Editar meta
        </button>
      )}
      <button
        aria-label={`Cancelar meta ${title}`}
        className="quiet-button"
        disabled={busyKey !== null}
        onClick={handleAskCancel}
        type="button"
      >
        Cancelar meta
      </button>
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
  timezone,
  today,
}: GoalCardProps) {
  const [mode, setMode] = useState<Mode>("idle");

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
  const handleCancelConfirm = useCallback(async () => {
    const outcome = await onCancel(goal);
    if (outcome !== "failed") {
      setMode("idle");
    }
  }, [goal, onCancel]);
  const handleCloseEdit = useCallback(() => setMode("idle"), []);

  return (
    <article className="goal-card">
      <GoalHeader goal={goal} today={today} />
      <GoalProgress goal={goal} />
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
        mode={mode}
        onCancelConfirm={handleCancelConfirm}
        onMode={setMode}
      />
      <GoalHistory
        goal={goal}
        organizationId={organizationId}
        timezone={timezone}
      />
    </article>
  );
}
