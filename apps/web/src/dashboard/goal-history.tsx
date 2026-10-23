import type { GoalReadModel } from "@polaris/contracts";
import { Button } from "@/ui/button";
import { LoadError } from "../expenses/expense-fields";
import { formatGoalDate, formatGoalValue } from "./goal-model";
import { useGoalHistory } from "./use-goal-history";

interface GoalHistoryProps {
  goal: GoalReadModel;
  organizationId: string;
  timezone: string | null;
}

/** The id of the body "Histórico do alvo" opens, for the button's `aria-controls`. */
function historyBodyId(goal: GoalReadModel): string {
  return `goal-history-${goal.id}`;
}

interface GoalHistoryToggleProps {
  goal: GoalReadModel;
  onToggle: () => void;
  open: boolean;
}

/** The "Histórico do alvo" button, one of the text actions of the card (its body comes after them). */
export function GoalHistoryToggle({
  goal,
  onToggle,
  open,
}: GoalHistoryToggleProps) {
  return (
    <Button
      aria-controls={historyBodyId(goal)}
      aria-expanded={open}
      onClick={onToggle}
      size="sm"
      type="button"
      variant="ghost"
    >
      {open ? "Ocultar histórico do alvo" : "Histórico do alvo"}
    </Button>
  );
}

function HistoryList({ goal, organizationId, timezone }: GoalHistoryProps) {
  const { load, state } = useGoalHistory(organizationId, goal.id, goal.version);
  return (
    <div aria-busy={state.isLoading} className="grid gap-2">
      {state.error ? (
        <LoadError
          busy={state.isLoading}
          message={state.error}
          onRetry={load}
        />
      ) : null}
      {state.isLoading && state.changes === null ? (
        <p className="text-muted-foreground text-support" role="status">
          Carregando o histórico…
        </p>
      ) : null}
      {state.changes?.length === 0 ? (
        <p className="text-muted-foreground text-support">
          O alvo nunca foi alterado.
        </p>
      ) : null}
      {state.changes && state.changes.length > 0 ? (
        <ul className="grid gap-1 text-support">
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
export function GoalHistoryBody({
  goal,
  open,
  organizationId,
  timezone,
}: GoalHistoryProps & { open: boolean }) {
  return (
    <div id={historyBodyId(goal)}>
      {open ? (
        <HistoryList
          goal={goal}
          organizationId={organizationId}
          timezone={timezone}
        />
      ) : null}
    </div>
  );
}
