import type {
  ExpenseCategoryReadModel,
  ExpenseRuleReadModel,
} from "@polaris/contracts";
import {
  EARLIEST_EXPENSE_COMPETENCE,
  MAX_EXPENSE_DESCRIPTION_LENGTH,
  MAX_EXPENSE_PAYEE_LENGTH,
} from "@polaris/domain/expenses/expense";
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Button } from "@/ui/button";
import {
  DialogBody,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Field, FieldDescription, FieldTitle } from "@/ui/field";
import {
  ConnectionRequiredDialogNotice,
  connectionControlProps,
  connectionDialogReasonId,
} from "../app-shell/connection-required-notice";
import { useConnectionOnline } from "../lib/browser-connection";
import { focusLater } from "../lib/focus";
import { formatCalendarDate } from "../lib/format";
import { isDraftChanged, useReportUnsentWork } from "../lib/unsent-work";
import { SelectField } from "../sales/sale-fields";
import {
  ActionNotice,
  ExpenseCategorySelect,
  ExpenseTextField,
} from "./expense-fields";
import { moneyInputText } from "./expense-model";
import type { Feedback } from "./use-command-runner";
import {
  isRuleFrequency,
  newRuleDraft,
  RULE_DRAFT_FIELDS,
  RULE_FREQUENCIES,
  type RuleCreateInput,
  type RuleDraft,
  type RuleDraftErrors,
  type RuleDraftField,
  ruleFrequencyLabel,
  validateRuleDraft,
} from "./expense-rule-model";

interface ExpenseRuleFormProps {
  /** Every category, archived ones included. */
  categories: readonly ExpenseCategoryReadModel[];
  disabled: boolean;
  editing: ExpenseRuleReadModel | null;
  /** What the last command said while the form is open: the dialog covers the top of the screen. */
  feedback: Feedback | null;
  /** What was typed and kept when the form was closed by Esc or "Fechar", for the same rule or a new one. */
  keptDraft?: RuleDraft | undefined;
  /** Every change of the draft, so the panel can keep it when the form closes. */
  onDraftChange: (draft: RuleDraft) => void;
  onCancel: () => void;
  /** Resolves true when the rule was saved. */
  onSave: (input: RuleCreateInput) => Promise<boolean>;
  /** This form is the command being sent. */
  saving: boolean;
  /** The organization's today, YYYY-MM-DD. */
  today: string;
}

function draftFrom(
  editing: ExpenseRuleReadModel | null,
  today: string
): RuleDraft {
  if (!editing) {
    return newRuleDraft(today);
  }
  return {
    amount: moneyInputText(editing.amount),
    categoryId: editing.categoryId,
    description: editing.description,
    endsOn: editing.endsOn ?? "",
    frequency: editing.frequency,
    payee: editing.payee ?? "",
    startsOn: editing.startsOn,
  };
}

function isDraftField(name: string): name is RuleDraftField {
  return (RULE_DRAFT_FIELDS as readonly string[]).includes(name);
}

function fieldId(field: RuleDraftField): string {
  return `expense-rule-${field}`;
}

function submitLabel(saving: boolean, editing: boolean): string {
  if (saving) {
    return "Salvando…";
  }
  return editing ? "Salvar alterações" : "Criar despesa recorrente";
}

interface FixedScheduleProps {
  rule: ExpenseRuleReadModel;
}

/** Frequency and start date cannot change: shown as text with the way out. */
function FixedSchedule({ rule }: FixedScheduleProps) {
  return (
    <Field className="min-w-0 md:col-span-2">
      <FieldTitle>Repetição e início</FieldTitle>
      <p className="font-medium">
        {ruleFrequencyLabel(rule.frequency)} · começa em{" "}
        {formatCalendarDate(rule.startsOn)}
      </p>
      <FieldDescription>
        A frequência e a data de início não mudam. Para mudá-las, pause esta
        despesa recorrente e crie outra.
      </FieldDescription>
    </Field>
  );
}

const FREQUENCY_OPTIONS = RULE_FREQUENCIES.map((item) => ({
  id: item.key,
  label: item.label,
}));

/**
 * The content of the form dialog (the whole screen on a phone): creates a recurring rule, or edits the one given. It
 * lives only while the dialog does, so each opening starts from the rule (or from a blank one); the parent also
 * gives it a new `key` for a different rule.
 */
export function ExpenseRuleForm({
  categories,
  disabled,
  editing,
  feedback,
  keptDraft,
  onCancel,
  onDraftChange,
  onSave,
  saving,
  today,
}: ExpenseRuleFormProps) {
  const [draft, setDraft] = useState<RuleDraft>(
    () => keptDraft ?? draftFrom(editing, today)
  );
  useEffect(() => onDraftChange(draft), [draft, onDraftChange]);
  const [errors, setErrors] = useState<RuleDraftErrors>({});
  // the form starts over under a new key, so what it started with is fixed for its life
  const [initialDraft] = useState<RuleDraft>(() => draftFrom(editing, today));
  useReportUnsentWork(isDraftChanged(draft, initialDraft));
  const online = useConnectionOnline();

  // Active categories only; the one the edited rule already has stays
  // selectable even when it was archived since.
  const keptCategoryId = editing?.categoryId;
  const selectable = useMemo(
    () =>
      categories.filter(
        (category) =>
          category.status === "active" || category.id === keptCategoryId
      ),
    [categories, keptCategoryId]
  );

  const handleChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const { name, value } = event.currentTarget;
    if (!isDraftField(name)) {
      return;
    }
    setDraft((current) => ({ ...current, [name]: value }));
    setErrors((current) => ({ ...current, [name]: undefined }));
  }, []);

  const handleFrequency = useCallback((value: string) => {
    if (isRuleFrequency(value)) {
      setDraft((current) => ({ ...current, frequency: value }));
      setErrors((current) => ({ ...current, frequency: undefined }));
    }
  }, []);

  const handleCategory = useCallback((categoryId: string) => {
    setDraft((current) => ({ ...current, categoryId }));
    setErrors((current) => ({ ...current, categoryId: undefined }));
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const result = validateRuleDraft(draft, {
        fixedStart: editing !== null,
        today,
      });
      if (result.input === null) {
        setErrors(result.errors);
        const first = RULE_DRAFT_FIELDS.find((field) => result.errors[field]);
        if (first) {
          focusLater(() => document.getElementById(fieldId(first))?.focus());
        }
        return;
      }
      await onSave(result.input);
    },
    [draft, editing, onSave, today]
  );

  return (
    <DialogForm onSubmit={handleSubmit}>
      <DialogHeader>
        <DialogTitle>
          {editing ? "Editar despesa recorrente" : "Nova despesa recorrente"}
        </DialogTitle>
      </DialogHeader>
      <DialogBody className="md:grid-cols-2">
        {feedback ? (
          <div className="md:col-span-2">
            <ActionNotice feedback={feedback} />
          </div>
        ) : null}
        <ExpenseTextField
          disabled={disabled}
          error={errors.amount}
          id={fieldId("amount")}
          inputMode="decimal"
          label="Valor de cada ocorrência (R$)"
          name="amount"
          onChange={handleChange}
          placeholder="0,00"
          value={draft.amount}
        />
        <ExpenseCategorySelect
          categories={selectable}
          disabled={disabled}
          error={errors.categoryId}
          id={fieldId("categoryId")}
          label="Categoria"
          onChange={handleCategory}
          placeholder="Escolha uma categoria"
          value={draft.categoryId}
        />

        {editing ? (
          <FixedSchedule rule={editing} />
        ) : (
          <>
            <SelectField
              disabled={disabled}
              error={errors.frequency}
              id={fieldId("frequency")}
              label="Frequência"
              onChange={handleFrequency}
              options={FREQUENCY_OPTIONS}
              placeholder="Escolha a frequência"
              value={draft.frequency}
            />
            <ExpenseTextField
              disabled={disabled}
              error={errors.startsOn}
              hint="Se a data já passou, as ocorrências atrasadas são lançadas de uma vez."
              id={fieldId("startsOn")}
              label="Começa em"
              min={EARLIEST_EXPENSE_COMPETENCE}
              name="startsOn"
              onChange={handleChange}
              type="date"
              value={draft.startsOn}
            />
          </>
        )}

        <ExpenseTextField
          disabled={disabled}
          error={errors.endsOn}
          hint="Em branco, repete sem data de término."
          id={fieldId("endsOn")}
          label="Termina em"
          min={draft.startsOn}
          name="endsOn"
          onChange={handleChange}
          optional
          type="date"
          value={draft.endsOn}
        />
        <ExpenseTextField
          disabled={disabled}
          error={errors.payee}
          id={fieldId("payee")}
          label="Favorecido"
          maxLength={MAX_EXPENSE_PAYEE_LENGTH}
          name="payee"
          onChange={handleChange}
          optional
          value={draft.payee}
        />
        <ExpenseTextField
          className="md:col-span-2"
          disabled={disabled}
          error={errors.description}
          id={fieldId("description")}
          label="Descrição"
          maxLength={MAX_EXPENSE_DESCRIPTION_LENGTH}
          name="description"
          onChange={handleChange}
          value={draft.description}
        />
      </DialogBody>
      <ConnectionRequiredDialogNotice online={online} />
      <DialogFooter>
        <Button
          disabled={disabled}
          onClick={onCancel}
          type="button"
          variant="outline"
        >
          Cancelar
        </Button>
        <Button
          {...connectionControlProps(online, connectionDialogReasonId)}
          className="h-auto min-h-ctl-md whitespace-normal"
          disabled={disabled}
          type="submit"
        >
          {submitLabel(saving, editing !== null)}
        </Button>
      </DialogFooter>
    </DialogForm>
  );
}
