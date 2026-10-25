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
  useMemo,
  useState,
} from "react";
import { Button } from "@/ui/button";
import { Field, FieldDescription, FieldTitle } from "@/ui/field";
import { connectionControlProps } from "../app-shell/connection-required-notice";
import { useConnectionOnline } from "../lib/browser-connection";
import { focusLater } from "../lib/focus";
import { formatCalendarDate } from "../lib/format";
import { isDraftChanged, useReportUnsentWork } from "../lib/unsent-work";
import { DateField, SelectField } from "../sales/sale-fields";
import { ExpenseCategorySelect, ExpenseTextField } from "./expense-fields";
import { moneyInputText } from "./expense-model";
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
 * Creates a recurring rule, or edits the one given. The parent gives it a new
 * `key` to start over (a different rule, or a fresh one after saving).
 */
export function ExpenseRuleForm({
  categories,
  disabled,
  editing,
  onCancel,
  onSave,
  saving,
  today,
}: ExpenseRuleFormProps) {
  const [draft, setDraft] = useState<RuleDraft>(() =>
    draftFrom(editing, today)
  );
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

  const handleStartsOn = useCallback((startsOn: string) => {
    setDraft((current) => ({ ...current, startsOn }));
    setErrors((current) => ({ ...current, startsOn: undefined }));
  }, []);

  const handleEndsOn = useCallback((endsOn: string) => {
    setDraft((current) => ({ ...current, endsOn }));
    setErrors((current) => ({ ...current, endsOn: undefined }));
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
    <form
      className="grid gap-4 md:grid-cols-2"
      noValidate
      onSubmit={handleSubmit}
    >
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
          <DateField
            disabled={disabled}
            error={errors.startsOn}
            hint="Se a data já passou, as ocorrências atrasadas são lançadas de uma vez."
            id={fieldId("startsOn")}
            label="Começa em"
            min={EARLIEST_EXPENSE_COMPETENCE}
            onChange={handleStartsOn}
            today={today}
            value={draft.startsOn}
          />
        </>
      )}

      <DateField
        disabled={disabled}
        error={errors.endsOn}
        hint="Em branco, repete sem data de término."
        id={fieldId("endsOn")}
        label="Termina em"
        min={draft.startsOn || undefined}
        onChange={handleEndsOn}
        optional
        today={today}
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

      <div className="flex flex-wrap justify-end gap-3 md:col-span-2">
        <Button
          disabled={disabled}
          onClick={onCancel}
          type="button"
          variant="outline"
        >
          Cancelar
        </Button>
        <Button
          {...connectionControlProps(online)}
          className="h-auto min-h-ctl-md whitespace-normal"
          disabled={disabled}
          type="submit"
        >
          {submitLabel(saving, editing !== null)}
        </Button>
      </div>
    </form>
  );
}
