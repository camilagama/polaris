import type { GoalReadModel } from "@polaris/contracts";
import { useCallback, useMemo, useState } from "react";
import { FeedbackMessage } from "../expenses/feedback-message";
import { focusLater } from "../lib/focus";
import { ActiveGoalCard, SettledGoalCard } from "./goal-card";
import { GoalCreateForm } from "./goal-form";
import {
  type GoalCreateInput,
  type GoalEditInput,
  groupGoals,
} from "./goal-model";
import { type GoalOutcome, useGoalCommands } from "./use-goal-commands";
import { type GoalsState, useGoals } from "./use-goals";
import "./goals-panel.css";

interface GoalsPanelProps {
  /** The month on screen (YYYY-MM): a new goal starts as that whole month. */
  month: string;
  organizationId: string;
  /** The organization's IANA time zone, for the dates of what happened. */
  timezone: string | null;
  /** The organization's today, YYYY-MM-DD. */
  today: string;
}

function GoalsIntro() {
  return (
    <p className="goal-intro">
      Uma meta mede, no período escolhido, as vendas líquidas, o resultado
      operacional estimado ou o número de vendas, com os mesmos números dos
      cartões acima, e por isso também é uma estimativa. Ao alcançar o alvo, a
      meta fica concluída e continua concluída, mesmo que devoluções posteriores
      reduzam os números. Se o período acabar antes, ela fica como não atingida.
    </p>
  );
}

interface GoalListProps {
  busyKey: string | null;
  goals: readonly GoalReadModel[];
  onCancel: (goal: GoalReadModel) => Promise<GoalOutcome>;
  onRetry: () => void;
  onSave: (goal: GoalReadModel, input: GoalEditInput) => Promise<GoalOutcome>;
  organizationId: string;
  state: GoalsState;
  timezone: string | null;
  today: string;
}

const EMPTY_GOALS_TEXT =
  "Nenhuma meta ainda. Crie uma para acompanhar as vendas líquidas, o resultado estimado ou o número de vendas de um período.";

function GoalList({
  busyKey,
  goals,
  onCancel,
  onRetry,
  onSave,
  organizationId,
  state,
  timezone,
  today,
}: GoalListProps) {
  const groups = useMemo(() => groupGoals(goals), [goals]);
  return (
    <div aria-busy={state.isLoading}>
      {state.error ? (
        <p className="categories-message is-error" role="alert">
          {state.error}{" "}
          <button
            className="quiet-button"
            disabled={state.isLoading}
            onClick={onRetry}
            type="button"
          >
            Tentar de novo
          </button>
        </p>
      ) : null}
      {state.isLoading && goals.length === 0 ? (
        <p className="goal-empty-state" role="status">
          Carregando as metas…
        </p>
      ) : null}
      {!state.isLoading && goals.length === 0 && state.error === null ? (
        <p className="goal-empty-state">{EMPTY_GOALS_TEXT}</p>
      ) : null}
      {groups.active.length > 0 ? (
        <section aria-labelledby="goals-active-heading" className="goal-group">
          <h3 id="goals-active-heading">Em andamento</h3>
          <ul className="goal-list">
            {groups.active.map((goal) => (
              <li key={goal.id}>
                <ActiveGoalCard
                  busyKey={busyKey}
                  goal={goal}
                  onCancel={onCancel}
                  onSave={onSave}
                  organizationId={organizationId}
                  timezone={timezone}
                  today={today}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {groups.settled.length > 0 ? (
        <section aria-labelledby="goals-settled-heading" className="goal-group">
          <h3 id="goals-settled-heading">Encerradas</h3>
          <ul className="goal-list">
            {groups.settled.map((goal) => (
              <li key={goal.id}>
                <SettledGoalCard
                  goal={goal}
                  organizationId={organizationId}
                  timezone={timezone}
                  today={today}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** Goals of the organization: what to reach in a period, and how far along it is. */
export function GoalsPanel({
  month,
  organizationId,
  timezone,
  today,
}: GoalsPanelProps) {
  const { reload, state } = useGoals(organizationId);
  const { busy, cancel, clearFeedback, create, feedback, update } =
    useGoalCommands(organizationId, reload);
  const [creating, setCreating] = useState(false);
  const [formCount, setFormCount] = useState(0);

  const closeForm = useCallback(() => {
    setCreating(false);
    setFormCount((count) => count + 1);
  }, []);
  const handleNew = useCallback(() => {
    clearFeedback();
    setCreating(true);
    focusLater(() => document.getElementById("goal-create-kind")?.focus());
  }, [clearFeedback]);
  const handleRetry = useCallback(() => {
    reload();
  }, [reload]);
  const handleSave = useCallback(
    async (input: GoalCreateInput) => {
      const outcome = await create(input);
      if (outcome !== "failed") {
        closeForm();
      }
      return outcome === "ok";
    },
    [closeForm, create]
  );

  return (
    <details className="goal-panel">
      <summary>
        <span className="categories-eyebrow">Acompanhamento</span>
        <span className="goal-panel-title">Metas</span>
      </summary>
      <div className="goal-panel-body">
        <GoalsIntro />
        <FeedbackMessage feedback={feedback} />
        <div className="goal-toolbar">
          <button
            className="quiet-button"
            disabled={state.isLoading || busy !== null}
            onClick={handleRetry}
            type="button"
          >
            {state.isLoading ? "Atualizando…" : "Atualizar metas"}
          </button>
          {creating ? null : (
            <button
              className="primary-button"
              disabled={busy !== null}
              onClick={handleNew}
              type="button"
            >
              Nova meta
            </button>
          )}
        </div>
        {creating ? (
          <div className="goal-form-wrap">
            <h3>Nova meta</h3>
            <GoalCreateForm
              disabled={busy !== null}
              key={formCount}
              month={month}
              onCancel={closeForm}
              onSave={handleSave}
              saving={busy === "create"}
            />
          </div>
        ) : null}
        <GoalList
          busyKey={busy}
          goals={state.goals}
          onCancel={cancel}
          onRetry={handleRetry}
          onSave={update}
          organizationId={organizationId}
          state={state}
          timezone={timezone}
          today={today}
        />
      </div>
    </details>
  );
}
