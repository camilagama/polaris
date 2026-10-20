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
  type ReactNode,
  useCallback,
  useMemo,
  useState,
} from "react";
import { focusLater } from "../lib/focus";
import { formatCalendarDate } from "../lib/format";
import { isDraftChanged, useReportUnsentWork } from "../lib/unsent-work";
import { ExpenseCategorySelect } from "./expense-category-select";
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

function describedBy(
  errors: RuleDraftErrors,
  field: RuleDraftField,
  helpId?: string
): string | undefined {
  const ids = [
    helpId,
    errors[field] ? `${fieldId(field)}-error` : undefined,
  ].filter(Boolean);
  return ids.length > 0 ? ids.join(" ") : undefined;
}

interface RuleFieldProps {
  children: ReactNode;
  errors: RuleDraftErrors;
  field: RuleDraftField;
  help?: string;
  label: string;
  optional?: boolean;
  wide?: boolean;
}

/** Label, control, optional help text and the inline error of one field. */
function RuleField({
  children,
  errors,
  field,
  help,
  label,
  optional,
  wide,
}: RuleFieldProps) {
  const message = errors[field];
  return (
    <div
      className={wide ? "expense-field expense-field-wide" : "expense-field"}
    >
      <label className="field-label" htmlFor={fieldId(field)}>
        {label}
        {optional ? <span className="field-optional"> Opcional</span> : null}
      </label>
      {children}
      {help ? (
        <p className="field-help" id={`${fieldId(field)}-help`}>
          {help}
        </p>
      ) : null}
      {message ? (
        <p className="field-error" id={`${fieldId(field)}-error`}>
          {message}
        </p>
      ) : null}
    </div>
  );
}

interface FixedScheduleProps {
  rule: ExpenseRuleReadModel;
}

/** Frequency and start date cannot change: shown as text with the way out. */
function FixedSchedule({ rule }: FixedScheduleProps) {
  return (
    <div className="expense-field expense-field-wide">
      <p className="field-label">Repetição e início</p>
      <p className="expense-rule-fixed">
        {ruleFrequencyLabel(rule.frequency)} · começa em{" "}
        {formatCalendarDate(rule.startsOn)}
      </p>
      <p className="field-help">
        A frequência e a data de início não mudam. Para mudá-las, pause esta
        despesa recorrente e crie outra.
      </p>
    </div>
  );
}

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

  const handleChange = useCallback(
    (
      event: ChangeEvent<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >
    ) => {
      const { name, value } = event.currentTarget;
      if (!isDraftField(name)) {
        return;
      }
      if (name === "frequency" && !isRuleFrequency(value)) {
        return;
      }
      setDraft((current) => ({ ...current, [name]: value }));
      setErrors((current) => ({ ...current, [name]: undefined }));
    },
    []
  );

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
      className="expense-form expense-rule-form"
      noValidate
      onSubmit={handleSubmit}
    >
      <RuleField
        errors={errors}
        field="amount"
        label="Valor de cada ocorrência (R$)"
      >
        <input
          aria-describedby={describedBy(errors, "amount")}
          aria-invalid={errors.amount ? true : undefined}
          autoComplete="off"
          disabled={disabled}
          id={fieldId("amount")}
          inputMode="decimal"
          name="amount"
          onChange={handleChange}
          placeholder="0,00"
          value={draft.amount}
        />
      </RuleField>

      <RuleField errors={errors} field="categoryId" label="Categoria">
        <ExpenseCategorySelect
          categories={selectable}
          describedBy={describedBy(errors, "categoryId")}
          disabled={disabled}
          id={fieldId("categoryId")}
          invalid={Boolean(errors.categoryId)}
          onChange={handleCategory}
          placeholder="Escolha uma categoria"
          value={draft.categoryId}
        />
      </RuleField>

      {editing ? (
        <FixedSchedule rule={editing} />
      ) : (
        <>
          <RuleField errors={errors} field="frequency" label="Frequência">
            <select
              className="expense-select"
              disabled={disabled}
              id={fieldId("frequency")}
              name="frequency"
              onChange={handleChange}
              value={draft.frequency}
            >
              {RULE_FREQUENCIES.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          </RuleField>

          <RuleField
            errors={errors}
            field="startsOn"
            help="Se a data já passou, as ocorrências atrasadas são lançadas de uma vez como despesas comuns."
            label="Começa em"
          >
            <input
              aria-describedby={describedBy(
                errors,
                "startsOn",
                "expense-rule-startsOn-help"
              )}
              aria-invalid={errors.startsOn ? true : undefined}
              disabled={disabled}
              id={fieldId("startsOn")}
              min={EARLIEST_EXPENSE_COMPETENCE}
              name="startsOn"
              onChange={handleChange}
              type="date"
              value={draft.startsOn}
            />
          </RuleField>
        </>
      )}

      <RuleField
        errors={errors}
        field="endsOn"
        help="Deixe em branco para repetir sem data de término."
        label="Termina em"
        optional
      >
        <input
          aria-describedby={describedBy(
            errors,
            "endsOn",
            "expense-rule-endsOn-help"
          )}
          aria-invalid={errors.endsOn ? true : undefined}
          disabled={disabled}
          id={fieldId("endsOn")}
          min={draft.startsOn}
          name="endsOn"
          onChange={handleChange}
          type="date"
          value={draft.endsOn}
        />
      </RuleField>

      <RuleField errors={errors} field="payee" label="Favorecido" optional>
        <input
          aria-describedby={describedBy(errors, "payee")}
          aria-invalid={errors.payee ? true : undefined}
          autoComplete="off"
          disabled={disabled}
          id={fieldId("payee")}
          maxLength={MAX_EXPENSE_PAYEE_LENGTH}
          name="payee"
          onChange={handleChange}
          value={draft.payee}
        />
      </RuleField>

      <RuleField errors={errors} field="description" label="Descrição" wide>
        <input
          aria-describedby={describedBy(errors, "description")}
          aria-invalid={errors.description ? true : undefined}
          autoComplete="off"
          disabled={disabled}
          id={fieldId("description")}
          maxLength={MAX_EXPENSE_DESCRIPTION_LENGTH}
          name="description"
          onChange={handleChange}
          value={draft.description}
        />
      </RuleField>

      <div className="expense-form-actions">
        <button
          className="quiet-button"
          disabled={disabled}
          onClick={onCancel}
          type="button"
        >
          Cancelar
        </button>
        <button className="primary-button" disabled={disabled} type="submit">
          {submitLabel(saving, editing !== null)}
        </button>
      </div>
    </form>
  );
}
