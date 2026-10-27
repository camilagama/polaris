import type { GoalReadModel } from "@polaris/contracts";
import PlusIcon from "lucide-react/dist/esm/icons/plus";
import RefreshCwIcon from "lucide-react/dist/esm/icons/refresh-cw";
import TargetIcon from "lucide-react/dist/esm/icons/target";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/ui/button";
import { Card, CardContent } from "@/ui/card";
import { ActionNotice, ListNote, LoadError } from "../expenses/expense-fields";
import { focusLater } from "../lib/focus";
import { keepForReturn, takeKept } from "../lib/kept-for-return";
import { LimitHelp, useLimitHelp } from "../subscription/limit-help";
import type { LimitHelpView } from "../subscription/limit-help-model";
import { ActiveGoalCard, SettledGoalCard } from "./goal-card";
import { GOAL_LIMIT_CANCEL_HINT, GOAL_LIMIT_REACHED } from "./goal-errors";
import { GoalCreateForm } from "./goal-form";
import {
  type GoalCreateInput,
  type GoalEditInput,
  groupGoals,
  readGoalsLink,
} from "./goal-model";
import type { GoalDraft } from "./goal-model";
import { type GoalOutcome, useGoalCommands } from "./use-goal-commands";
import type { GoalsState } from "./use-goals";

interface GoalsPanelProps {
  /** The read of the goals, owned by the screen so that the tab can say how many are in progress (AC-13, AC-15). */
  goals: { reload: () => Promise<void>; state: GoalsState };
  /** The store's current month (YYYY-MM): a new goal starts as that whole month. The tab does not follow the period of the Resultado (AC-15). */
  month: string;
  organizationId: string;
  /** The organization's IANA time zone, for the dates of what happened. */
  timezone: string | null;
  /** The organization's today, YYYY-MM-DD. */
  today: string;
}

const HEADING_ID = "goals-heading";

const returnKey = (organizationId: string) => `goals:${organizationId}`;

interface GoalListProps {
  busyKey: string | null;
  goals: readonly GoalReadModel[];
  onCancel: (goal: GoalReadModel) => Promise<GoalOutcome>;
  onRetry: () => void;
  /** What goes with a goal paused by the plan: the way to the Pro (corte 1.6). */
  pausedHelp: LimitHelpView | null;
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
  pausedHelp,
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
          <ul
            aria-labelledby="goals-active-heading"
            className="grid gap-3 md:grid-cols-2"
          >
            {groups.active.map((goal) => (
              <li key={goal.id}>
                <ActiveGoalCard
                  busyKey={busyKey}
                  goal={goal}
                  onCancel={onCancel}
                  onSave={onSave}
                  organizationId={organizationId}
                  pausedHelp={pausedHelp}
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
          <ul
            aria-labelledby="goals-settled-heading"
            className="grid gap-3 md:grid-cols-2"
          >
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

/** Under the refusal of a new goal by the plan's limit: the way to free a place, when there is one, and to the Pro. */
function GoalLimitHelp({
  canCancel,
  help,
}: {
  canCancel: boolean;
  help: LimitHelpView | null;
}) {
  return (
    <>
      {canCancel ? (
        <span className="block">{GOAL_LIMIT_CANCEL_HINT}</span>
      ) : null}
      <LimitHelp help={help} />
    </>
  );
}

/** Goals of the organization: what to reach in a period, and how far along it is. Always open: hiding them saves nothing. */
export function GoalsPanel({
  goals: { reload, state },
  month,
  organizationId,
  timezone,
  today,
}: GoalsPanelProps) {
  const { busy, cancel, clearFeedback, create, feedback, update } =
    useGoalCommands(organizationId, reload);
  // the address the Início links to, read once: `?meta=nova` opens the form, `?meta=lista` goes to the goals
  const [link] = useState(() => readGoalsLink(window.location.search));
  // the form is a dialog: opened by the button, or by the address the Início links to
  const [creating, setCreating] = useState(link === "new");
  const newButtonRef = useRef<HTMLButtonElement>(null);

  // what was typed when the form was closed by Esc or "Fechar", for the next opening; in memory only (and kept while
  // "Conhecer o Pro" opens the Assinatura with no load of the page, for "voltar")
  const [returned] = useState(
    () => takeKept<GoalDraft>(returnKey(organizationId)) ?? null
  );
  const draftStore = useRef<GoalDraft | null>(returned);
  useEffect(
    () => () => keepForReturn(returnKey(organizationId), draftStore.current),
    [organizationId]
  );
  // the plan's limit refused the new goal (L5 of the corte 1.6), or a goal is paused by the plan: the way to the Pro
  const { help: limitHelp, show: showLimitHelp } = useLimitHelp();
  const { help: pausedHelp, show: showPausedHelp } = useLimitHelp();
  const feedbackRef = useRef<HTMLDivElement>(null);
  const hasPaused = state.goals.some((goal) => goal.paused);
  useEffect(() => {
    if (hasPaused) {
      showPausedHelp("goals");
    }
  }, [hasPaused, showPausedHelp]);
  // a goal in progress or paused takes a place, and cancelling it frees the place (T-3)
  const canCancel = state.goals.some((goal) => goal.status === "active");
  // in the form, and above the list once the form was closed (Esc, or "Conhecer o Pro" on its way)
  const limitExtra =
    feedback?.text === GOAL_LIMIT_REACHED ? (
      <GoalLimitHelp canCancel={canCancel} help={limitHelp} />
    ) : null;
  const handleDraftChange = useCallback((draft: GoalDraft | null) => {
    draftStore.current = draft;
  }, []);
  /** "Cancelar", a saved goal: the form closes and what was typed is thrown away. */
  const closeForm = useCallback(() => {
    draftStore.current = null;
    setCreating(false);
  }, []);
  /** Esc and "Fechar": the form closes and the draft stays. */
  const dismissForm = useCallback(() => setCreating(false), []);
  const handleNew = useCallback(() => {
    clearFeedback();
    setCreating(true);
  }, [clearFeedback]);
  // the focus goes back to what opened the form (the button, or the heading when the address did)
  const finalFocus = useCallback(
    () => newButtonRef.current ?? document.getElementById(HEADING_ID) ?? true,
    []
  );
  // before the dialog's own effects: on a phone the form opened by `?meta=nova` pushes its entry over this address, and
  // that entry and the one under it are the screen without the link, so the step back closes the form and stays
  useLayoutEffect(() => {
    if (link !== null) {
      // the link did its work: a reload or a step back is the screen as it is, not the form opening again
      const url = new URL(window.location.href);
      url.searchParams.delete("meta");
      window.history.replaceState(
        window.history.state,
        "",
        `${url.pathname}${url.search}${url.hash}`
      );
    }
    if (link === "list") {
      focusLater(() => {
        const heading = document.getElementById(HEADING_ID);
        heading?.scrollIntoView({ block: "start" });
        heading?.focus({ preventScroll: true });
      });
    }
  }, [link]);
  const handleRetry = useCallback(() => {
    reload();
  }, [reload]);
  const handleSave = useCallback(
    async (input: GoalCreateInput) => {
      const outcome = await create(input);
      if (outcome === "limit") {
        // nothing was created: the form stays as typed, and the refusal takes the focus with the way to the Pro
        showLimitHelp("goals");
        focusLater(() => feedbackRef.current?.focus());
      } else if (outcome !== "failed") {
        closeForm();
      }
      return outcome === "ok";
    },
    [closeForm, create, showLimitHelp]
  );
  // the dialog closes, and after a cancel that went through the card is gone: the focus goes to the heading
  const handleCancel = useCallback(
    async (goal: GoalReadModel) => {
      const outcome = await cancel(goal);
      // the dialog closes with any answer, and what happened is said right under the heading
      focusLater(() => document.getElementById(HEADING_ID)?.focus());
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
            <span className="max-sm:hidden">Atualizar</span>
          </Button>
          <Button
            disabled={busy !== null}
            onClick={handleNew}
            ref={newButtonRef}
            size="sm"
            type="button"
            variant="outline"
          >
            <PlusIcon aria-hidden="true" data-icon="inline-start" />
            Nova meta
          </Button>
        </div>
      </div>
      {/* while the form is open it covers this part of the screen: what the commands say is said inside it */}
      <ActionNotice
        errorExtra={limitExtra}
        feedback={creating ? null : feedback}
      />
      <GoalCreateForm
        disabled={busy !== null}
        feedback={feedback?.kind === "error" ? feedback : null}
        feedbackExtra={limitExtra}
        feedbackRef={feedbackRef}
        finalFocus={finalFocus}
        keptDraft={draftStore.current ?? undefined}
        month={month}
        onCancel={closeForm}
        onDismiss={dismissForm}
        onDraftChange={handleDraftChange}
        onSave={handleSave}
        open={creating}
        saving={busy === "create"}
        today={today}
      />
      <GoalList
        busyKey={busy}
        goals={state.goals}
        onCancel={handleCancel}
        onRetry={handleRetry}
        onSave={update}
        organizationId={organizationId}
        pausedHelp={pausedHelp}
        state={state}
        timezone={timezone}
        today={today}
      />
    </section>
  );
}
