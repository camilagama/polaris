import type { GoalReadModel } from "@polaris/contracts";
import { useCallback, useState } from "react";
import { formatGoalDate, formatGoalValue } from "./goal-model";
import { useGoalHistory } from "./use-goal-history";

interface GoalHistoryProps {
  goal: GoalReadModel;
  organizationId: string;
  timezone: string | null;
}

function HistoryList({ goal, organizationId, timezone }: GoalHistoryProps) {
  const { load, state } = useGoalHistory(organizationId, goal.id, goal.version);
  return (
    <div aria-busy={state.isLoading} className="goal-history-body">
      {state.error ? (
        <p className="categories-message is-error" role="alert">
          {state.error}{" "}
          <button
            className="quiet-button"
            disabled={state.isLoading}
            onClick={load}
            type="button"
          >
            Tentar de novo
          </button>
        </p>
      ) : null}
      {state.isLoading && state.changes === null ? (
        <p className="goal-history-note" role="status">
          Carregando o histórico…
        </p>
      ) : null}
      {state.changes?.length === 0 ? (
        <p className="goal-history-note">O alvo nunca foi alterado.</p>
      ) : null}
      {state.changes && state.changes.length > 0 ? (
        <ul className="goal-history-list">
          {state.changes.map((change) => (
            <li key={`${change.changedAt}:${change.newTarget}`}>
              de {formatGoalValue(goal.kind, change.previousTarget)} para{" "}
              {formatGoalValue(goal.kind, change.newTarget)} em{" "}
              {formatGoalDate(change.changedAt, timezone)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** "Histórico do alvo": the changes of the target, read only when asked for. */
export function GoalHistory({
  goal,
  organizationId,
  timezone,
}: GoalHistoryProps) {
  const [open, setOpen] = useState(false);
  const handleToggle = useCallback(() => setOpen((current) => !current), []);
  const bodyId = `goal-history-${goal.id}`;
  return (
    <div className="goal-history">
      <button
        aria-controls={bodyId}
        aria-expanded={open}
        className="quiet-button"
        onClick={handleToggle}
        type="button"
      >
        {open ? "Ocultar histórico do alvo" : "Histórico do alvo"}
      </button>
      <div id={bodyId}>
        {open ? (
          <HistoryList
            goal={goal}
            organizationId={organizationId}
            timezone={timezone}
          />
        ) : null}
      </div>
    </div>
  );
}
