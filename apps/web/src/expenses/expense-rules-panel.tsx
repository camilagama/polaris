import type {
  ExpenseCategoryReadModel,
  ExpenseRuleReadModel,
} from "@polaris/contracts";
import PlusIcon from "lucide-react/dist/esm/icons/plus";
import { useCallback, useMemo, useRef, useState } from "react";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Checkbox } from "@/ui/checkbox";
import { Dialog, DialogContent } from "@/ui/dialog";
import { Field, FieldLabel } from "@/ui/field";
import { connectionControlProps } from "../app-shell/connection-required-notice";
import { useConnectionOnline } from "../lib/browser-connection";
import { formatBrlAmount, formatCalendarDate } from "../lib/format";
import { orpcClient } from "../lib/orpc";
import { CollapsibleSection } from "./collapsible-section";
import { ActionNotice, ListNote, LoadError } from "./expense-fields";
import { expenseGroupLabel } from "./expense-model";
import { ExpenseRuleForm } from "./expense-rule-form";
import { type RuleCreateInput, ruleFrequencyLabel } from "./expense-rule-model";
import { type CommandOutcome, useCommandRunner } from "./use-command-runner";
import { type ExpenseRulesState, useExpenseRules } from "./use-expense-rules";

interface ExpenseRulesPanelProps {
  /** Every category, archived ones included. */
  categories: readonly ExpenseCategoryReadModel[];
  /**
   * Called after a rule changed (or turned out stale): the page reloads the
   * expense list, because the server generates the occurrences that fell due
   * when the list is read.
   */
  onChanged: () => Promise<void>;
  organizationId: string;
  /** The organization's today, YYYY-MM-DD. */
  today: string;
}

/** The form is closed (null), creating a rule, or editing one. */
type FormTarget = ExpenseRuleReadModel | "new" | null;

function nextOccurrenceText(rule: ExpenseRuleReadModel): string {
  if (rule.nextOccurrenceOn === null) {
    return "Série encerrada";
  }
  if (rule.status === "archived") {
    return "Geração suspensa até retomar";
  }
  return `Próxima: ${formatCalendarDate(rule.nextOccurrenceOn)}`;
}

function scheduleText(rule: ExpenseRuleReadModel): string {
  const start = `Começa em ${formatCalendarDate(rule.startsOn)}`;
  return rule.endsOn
    ? `${start} · Termina em ${formatCalendarDate(rule.endsOn)}`
    : start;
}

interface RuleCardProps {
  busyKey: string | null;
  onEdit: (rule: ExpenseRuleReadModel) => void;
  onToggle: (rule: ExpenseRuleReadModel) => void;
  rule: ExpenseRuleReadModel;
}

function RuleCard({ busyKey, onEdit, onToggle, rule }: RuleCardProps) {
  const paused = rule.status === "archived";
  const handleEdit = useCallback(() => onEdit(rule), [onEdit, rule]);
  const online = useConnectionOnline();
  const handleToggle = useCallback(() => onToggle(rule), [onToggle, rule]);
  const isBusy = busyKey !== null;
  const thisBusy = busyKey === `rule-toggle:${rule.id}`;
  const toggleLabel = paused ? "Retomar" : "Pausar";
  const toggleBusyLabel = paused ? "Retomando…" : "Pausando…";

  return (
    <article
      className="grid gap-x-4 gap-y-2 py-3 min-[30rem]:grid-cols-[minmax(0,1fr)_auto] min-[30rem]:items-center"
      data-rule-id={rule.id}
    >
      <div className="grid min-w-0 gap-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="font-medium [overflow-wrap:anywhere]">
            {rule.description}
          </h3>
          {paused ? <Badge variant="warning">Pausada</Badge> : null}
        </div>
        <p className="text-muted-foreground text-support [overflow-wrap:anywhere]">
          {ruleFrequencyLabel(rule.frequency)} · {rule.categoryName} ·{" "}
          {expenseGroupLabel(rule.categoryGroup)}
          {rule.payee ? ` · ${rule.payee}` : ""}
        </p>
        <p className="text-muted-foreground text-support">
          {scheduleText(rule)}
        </p>
        <p className="text-muted-foreground text-support">
          {nextOccurrenceText(rule)}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 min-[30rem]:justify-end">
        <p className="whitespace-nowrap font-semibold text-value-md tabular-nums">
          {formatBrlAmount(rule.amount)}
        </p>
        <div className="flex gap-2">
          <Button
            aria-label={`Editar despesa recorrente ${rule.description}`}
            data-rule-edit=""
            disabled={isBusy}
            onClick={handleEdit}
            size="sm"
            type="button"
            variant="outline"
          >
            Editar
          </Button>
          <Button
            {...connectionControlProps(online)}
            aria-label={`${toggleLabel} despesa recorrente ${rule.description}`}
            disabled={isBusy}
            onClick={handleToggle}
            size="sm"
            type="button"
            variant="outline"
          >
            {thisBusy ? toggleBusyLabel : toggleLabel}
          </Button>
        </div>
      </div>
    </article>
  );
}

interface RuleListProps {
  busyKey: string | null;
  onEdit: (rule: ExpenseRuleReadModel) => void;
  onRetry: () => void;
  onToggle: (rule: ExpenseRuleReadModel) => void;
  rules: readonly ExpenseRuleReadModel[];
  showPaused: boolean;
  state: ExpenseRulesState;
}

function emptyRulesText(total: number): string {
  return total === 0
    ? "Nenhuma despesa recorrente. Crie uma para lançar aluguel, assinaturas e outros custos fixos sozinha."
    : "Todas as despesas recorrentes estão pausadas. Marque “Mostrar pausadas” para vê-las.";
}

function RuleList({
  busyKey,
  onEdit,
  onRetry,
  onToggle,
  rules,
  showPaused,
  state,
}: RuleListProps) {
  const visible = rules.filter(
    (rule) => showPaused || rule.status === "active"
  );
  return (
    <div aria-busy={state.isLoading} className="grid gap-2">
      {state.error ? (
        <LoadError
          busy={state.isLoading}
          message={state.error}
          onRetry={onRetry}
        />
      ) : null}
      {state.isLoading && rules.length === 0 ? (
        <ListNote loading>Carregando despesas recorrentes…</ListNote>
      ) : null}
      {!state.isLoading && visible.length === 0 && state.error === null ? (
        <ListNote>{emptyRulesText(rules.length)}</ListNote>
      ) : null}
      {visible.length > 0 ? (
        <ul className="divide-y">
          {visible.map((rule) => (
            <li key={rule.id}>
              <RuleCard
                busyKey={busyKey}
                onEdit={onEdit}
                onToggle={onToggle}
                rule={rule}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

interface RuleCommandsInput {
  onChanged: () => Promise<void>;
  organizationId: string;
  reload: () => Promise<void>;
  upsert: (rule: ExpenseRuleReadModel) => void;
}

function useRuleCommands({
  onChanged,
  organizationId,
  reload,
  upsert,
}: RuleCommandsInput) {
  const { busy, clearFeedback, feedback, run } = useCommandRunner();

  /** Anything but a plain failure may have changed what the list shows. */
  const settle = useCallback(
    async (outcome: CommandOutcome) => {
      if (outcome !== "failed") {
        await onChanged();
        await reload();
      }
      return outcome;
    },
    [onChanged, reload]
  );

  const save = useCallback(
    async (target: ExpenseRuleReadModel | null, input: RuleCreateInput) =>
      settle(
        await run(
          target ? `rule-save:${target.id}` : "rule-create",
          "rule-save",
          async () => {
            if (target) {
              const result = await orpcClient.expense.updateRule({
                amount: input.amount,
                categoryId: input.categoryId,
                description: input.description,
                endsOn: input.endsOn,
                expectedVersion: target.version,
                id: target.id,
                organizationId,
                payee: input.payee,
              });
              upsert(result.rule);
              return "Despesa recorrente atualizada. A mudança vale para as próximas ocorrências; as já lançadas não são alteradas.";
            }
            upsert(
              await orpcClient.expense.createRule({ ...input, organizationId })
            );
            return "Despesa recorrente criada. As ocorrências que já venceram foram lançadas como despesas comuns.";
          }
        )
      ),
    [organizationId, run, settle, upsert]
  );

  const toggle = useCallback(
    async (rule: ExpenseRuleReadModel) => {
      const pausing = rule.status === "active";
      const input = {
        expectedVersion: rule.version,
        id: rule.id,
        organizationId,
      };
      return settle(
        await run(
          `rule-toggle:${rule.id}`,
          pausing ? "rule-archive" : "rule-restore",
          async () => {
            const result = pausing
              ? await orpcClient.expense.archiveRule(input)
              : await orpcClient.expense.restoreRule(input);
            upsert(result.rule);
            return pausing
              ? "Despesa recorrente pausada. Nenhuma ocorrência nova será lançada até retomar; marque “Mostrar pausadas” para vê-la."
              : "Despesa recorrente retomada. Os períodos que passaram durante a pausa não são lançados.";
          }
        )
      );
    },
    [organizationId, run, settle, upsert]
  );

  return { busy, clearFeedback, feedback, save, toggle };
}

function RulesIntro() {
  return (
    <p className="text-muted-foreground text-support">
      Cada ocorrência vira uma despesa comum na data. Editar muda só as
      próximas; retomar depois de pausar não lança os períodos da pausa.
    </p>
  );
}

/** Secondary section: rules that launch an expense every week, month or year. */
export function ExpenseRulesPanel({
  categories,
  onChanged,
  organizationId,
  today,
}: ExpenseRulesPanelProps) {
  const { reload, state, upsert } = useExpenseRules(organizationId);
  const { busy, clearFeedback, feedback, save, toggle } = useRuleCommands({
    onChanged,
    organizationId,
    reload,
    upsert,
  });
  const [showPaused, setShowPaused] = useState(false);
  // the form is a dialog: `target` says what it holds and stays until it has closed, so it does not turn into
  // another form while it fades
  const [target, setTarget] = useState<FormTarget>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formCount, setFormCount] = useState(0);
  // where the focus goes back to when the form closes: what opened it
  const originRef = useRef<() => HTMLElement | null>(() => null);

  const closeForm = useCallback(() => setFormOpen(false), []);
  /** The form is gone: the next one starts from nothing. */
  const handleFormClosed = useCallback(() => {
    setTarget(null);
    setFormCount((count) => count + 1);
  }, []);
  const openForm = useCallback(
    (next: ExpenseRuleReadModel | "new") => {
      clearFeedback();
      originRef.current =
        next === "new"
          ? () => document.querySelector<HTMLElement>("[data-rule-new]")
          : () =>
              document.querySelector<HTMLElement>(
                `[data-rule-id="${next.id}"] [data-rule-edit]`
              );
      setTarget(next);
      setFormOpen(true);
    },
    [clearFeedback]
  );
  const finalFocus = useCallback(() => originRef.current() ?? true, []);
  const handleNew = useCallback(() => openForm("new"), [openForm]);
  const handleRetry = useCallback(() => {
    reload();
  }, [reload]);

  const editing = target === "new" ? null : target;
  const handleSave = useCallback(
    async (input: RuleCreateInput) => {
      const outcome = await save(editing, input);
      if (outcome !== "failed") {
        closeForm();
      }
      return outcome === "ok";
    },
    [closeForm, editing, save]
  );
  const handleToggle = useCallback(
    async (rule: ExpenseRuleReadModel) => {
      const outcome = await toggle(rule);
      if (outcome !== "failed" && editing?.id === rule.id) {
        closeForm();
      }
    },
    [closeForm, editing?.id, toggle]
  );

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next && busy === null) {
        closeForm();
      }
    },
    [busy, closeForm]
  );
  const handleOpenChangeComplete = useCallback(
    (next: boolean) => {
      if (!next) {
        handleFormClosed();
      }
    },
    [handleFormClosed]
  );
  const isSaving =
    busy === "rule-create" || (busy?.startsWith("rule-save:") ?? false);
  const formKey = useMemo(() => {
    if (target === null) {
      return "closed";
    }
    return target === "new"
      ? `new:${formCount}`
      : `${target.id}:${target.version}`;
  }, [formCount, target]);

  return (
    <CollapsibleSection id="expense-rules" title="Despesas recorrentes">
      <RulesIntro />
      {/* while the form is open it covers this part of the screen: what the commands say is said inside it */}
      <ActionNotice feedback={formOpen ? null : feedback} />
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <Field className="min-h-ctl-md w-auto" orientation="horizontal">
          <Checkbox
            checked={showPaused}
            id="expense-rules-paused"
            onCheckedChange={setShowPaused}
          />
          <FieldLabel htmlFor="expense-rules-paused">
            Mostrar pausadas
          </FieldLabel>
        </Field>
        <Button
          data-rule-new=""
          disabled={busy !== null}
          onClick={handleNew}
          type="button"
          variant="outline"
        >
          <PlusIcon aria-hidden="true" data-icon="inline-start" />
          Nova despesa recorrente
        </Button>
      </div>
      <Dialog
        disablePointerDismissal
        onOpenChange={handleOpenChange}
        onOpenChangeComplete={handleOpenChangeComplete}
        open={formOpen}
      >
        <DialogContent finalFocus={finalFocus} layout="form">
          <ExpenseRuleForm
            categories={categories}
            disabled={busy !== null}
            editing={editing}
            feedback={feedback?.kind === "error" ? feedback : null}
            key={formKey}
            onCancel={closeForm}
            onSave={handleSave}
            saving={isSaving}
            today={today}
          />
        </DialogContent>
      </Dialog>
      <RuleList
        busyKey={busy}
        onEdit={openForm}
        onRetry={handleRetry}
        onToggle={handleToggle}
        rules={state.rules}
        showPaused={showPaused}
        state={state}
      />
    </CollapsibleSection>
  );
}
