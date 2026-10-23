import type { GoalReadModel } from "@polaris/contracts";
import PlusIcon from "lucide-react/dist/esm/icons/plus";
import RefreshCwIcon from "lucide-react/dist/esm/icons/refresh-cw";
import TargetIcon from "lucide-react/dist/esm/icons/target";
import { useCallback, useMemo, useState } from "react";
import { Button } from "@/ui/button";
import { Card, CardContent } from "@/ui/card";
import { ActionNotice, ListNote, LoadError } from "../expenses/expense-fields";
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

interface GoalsPanelProps {
  /** The month on screen (YYYY-MM): a new goal starts as that whole month. */
  month: string;
  organizationId: string;
  /** The organization's IANA time zone, for the dates of what happened. */
  timezone: string | null;
  /** The organization's today, YYYY-MM-DD. */
  today: string;
}

const HEADING_ID = "goals-heading";

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

/** The small caps label over a group of cards. */
function GroupLabel({ children, id }: { children: string; id: string }) {
  return (
    <h3
      className="mt-1 font-medium text-muted-foreground text-xs uppercase tracking-wide"
      id={id}
    >
      {children}
    </h3>
  );
}

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
    <div aria-busy={state.isLoading} className="grid gap-3">
      {state.error ? (
        <LoadError
          busy={state.isLoading}
          message={state.error}
          onRetry={onRetry}
        />
      ) : null}
      {state.isLoading && goals.length === 0 ? (
        <Card>
          <CardContent>
            <ListNote loading>Carregando as metas…</ListNote>
          </CardContent>
        </Card>
      ) : null}
      {!state.isLoading && goals.length === 0 && state.error === null ? (
        <Card>
          <CardContent className="grid justify-items-center gap-1 text-center">
            <TargetIcon
              aria-hidden="true"
              className="size-5 text-muted-foreground"
            />
            <p className="font-medium">Nenhuma meta ainda</p>
            <p className="text-muted-foreground text-support">
              Crie uma para acompanhar as vendas líquidas, o resultado estimado
              ou o número de vendas de um período.
            </p>
          </CardContent>
        </Card>
      ) : null}
      {groups.active.length > 0 ? (
        <>
          <GroupLabel id="goals-active-heading">Em andamento</GroupLabel>
          <ul className="grid gap-3 md:grid-cols-2">
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
        </>
      ) : null}
      {groups.settled.length > 0 ? (
        <>
          <GroupLabel id="goals-settled-heading">Encerradas</GroupLabel>
          <ul className="grid gap-3 md:grid-cols-2">
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
        </>
      ) : null}
    </div>
  );
}

/** Goals of the organization: what to reach in a period, and how far along it is. Always open: hiding them saves nothing. */
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
  // the card that held the dialog is gone after a cancel that went through: the focus goes to the heading
  const handleCancel = useCallback(
    async (goal: GoalReadModel) => {
      const outcome = await cancel(goal);
      if (outcome !== "failed") {
        focusLater(() => document.getElementById(HEADING_ID)?.focus());
      }
      return outcome;
    },
    [cancel]
  );

  return (
    <section aria-labelledby={HEADING_ID} className="grid gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="grid gap-0.5">
          <h2 className="text-section" id={HEADING_ID} tabIndex={-1}>
            Metas
          </h2>
          <p className="text-muted-foreground text-support">
            Também estimativas. Uma meta concluída continua concluída.
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          <Button
            aria-label="Atualizar metas"
            disabled={state.isLoading || busy !== null}
            onClick={handleRetry}
            size="sm"
            type="button"
            variant="ghost"
          >
            <RefreshCwIcon aria-hidden="true" data-icon="inline-start" />
            <span className="max-sm:hidden">
              {state.isLoading ? "Atualizando…" : "Atualizar"}
            </span>
          </Button>
          {creating ? null : (
            <Button
              disabled={busy !== null}
              onClick={handleNew}
              size="sm"
              type="button"
              variant="outline"
            >
              <PlusIcon aria-hidden="true" data-icon="inline-start" />
              Nova meta
            </Button>
          )}
        </div>
      </div>
      <ActionNotice feedback={feedback} />
      {creating ? (
        <GoalCreateForm
          disabled={busy !== null}
          key={formCount}
          month={month}
          onCancel={closeForm}
          onSave={handleSave}
          saving={busy === "create"}
        />
      ) : null}
      <GoalList
        busyKey={busy}
        goals={state.goals}
        onCancel={handleCancel}
        onRetry={handleRetry}
        onSave={update}
        organizationId={organizationId}
        state={state}
        timezone={timezone}
        today={today}
      />
    </section>
  );
}
