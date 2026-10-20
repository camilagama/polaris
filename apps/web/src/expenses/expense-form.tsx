import type {
  ExpenseCategoryReadModel,
  ExpenseReadModel,
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
import { focusLater } from "../lib/focus";
import { useReportUnsentWork } from "../lib/unsent-work";
import { ExpenseCategorySelect } from "./expense-category-select";
import {
  EXPENSE_DRAFT_FIELDS,
  type ExpenseDraft,
  type ExpenseDraftErrors,
  type ExpenseDraftField,
  type ExpenseInput,
  isExpenseDraftChanged,
  moneyInputText,
  validateExpenseDraft,
} from "./expense-model";

interface ExpenseFormProps {
  /** Every category, archived ones included. */
  categories: readonly ExpenseCategoryReadModel[];
  disabled: boolean;
  editing: ExpenseReadModel | null;
  onCancel: () => void;
  /** Resolves true when the expense was saved. */
  onSave: (input: ExpenseInput) => Promise<boolean>;
  /** This form is the command being sent. */
  saving: boolean;
  /** The organization's today, YYYY-MM-DD. */
  today: string;
}

function draftFrom(
  editing: ExpenseReadModel | null,
  today: string
): ExpenseDraft {
  if (editing) {
    return {
      amount: moneyInputText(editing.amount),
      categoryId: editing.categoryId,
      competenceOn: editing.competenceOn,
      description: editing.description,
      payee: editing.payee ?? "",
    };
  }
  return {
    amount: "",
    categoryId: "",
    competenceOn: today,
    description: "",
    payee: "",
  };
}

function isDraftField(name: string): name is ExpenseDraftField {
  return (EXPENSE_DRAFT_FIELDS as readonly string[]).includes(name);
}

function fieldId(field: ExpenseDraftField): string {
  return `expense-${field}`;
}

function submitLabel(saving: boolean, editing: boolean): string {
  if (saving) {
    return "Salvando…";
  }
  return editing ? "Salvar alterações" : "Registrar despesa";
}

interface FieldErrorProps {
  errors: ExpenseDraftErrors;
  field: ExpenseDraftField;
}

function FieldError({ errors, field }: FieldErrorProps) {
  const message = errors[field];
  return message ? (
    <p className="field-error" id={`${fieldId(field)}-error`}>
      {message}
    </p>
  ) : null;
}

function describedBy(
  errors: ExpenseDraftErrors,
  field: ExpenseDraftField,
  helpId?: string
): string | undefined {
  const ids = [
    helpId,
    errors[field] ? `${fieldId(field)}-error` : undefined,
  ].filter(Boolean);
  return ids.length > 0 ? ids.join(" ") : undefined;
}

/**
 * Creates an expense, or edits the one given. The parent gives it a new `key`
 * to start over (a different expense, or a new one after saving).
 */
export function ExpenseForm({
  categories,
  disabled,
  editing,
  onCancel,
  onSave,
  saving,
  today,
}: ExpenseFormProps) {
  const [draft, setDraft] = useState<ExpenseDraft>(() =>
    draftFrom(editing, today)
  );
  const [errors, setErrors] = useState<ExpenseDraftErrors>({});
  // the form starts over under a new key, so what it started with is fixed for its life
  const [initialDraft] = useState<ExpenseDraft>(() =>
    draftFrom(editing, today)
  );
  useReportUnsentWork(isExpenseDraftChanged(draft, initialDraft));

  // Active categories only; the one the edited expense already has stays
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
      if (isDraftField(name)) {
        setDraft((current) => ({ ...current, [name]: value }));
        setErrors((current) => ({ ...current, [name]: undefined }));
      }
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
      const result = validateExpenseDraft(draft);
      if (result.input === null) {
        setErrors(result.errors);
        const first = EXPENSE_DRAFT_FIELDS.find(
          (field) => result.errors[field]
        );
        if (first) {
          focusLater(() => document.getElementById(fieldId(first))?.focus());
        }
        return;
      }
      await onSave(result.input);
    },
    [draft, onSave]
  );

  return (
    <section aria-labelledby="expense-form-heading" className="expense-panel">
      <div className="expense-panel-heading">
        <div>
          <p className="categories-eyebrow">
            {editing ? "Atualização" : "Lançamento"}
          </p>
          <h2 id="expense-form-heading">
            {editing ? "Editar despesa" : "Nova despesa"}
          </h2>
        </div>
        {editing ? (
          <button
            className="quiet-button"
            disabled={disabled}
            onClick={onCancel}
            type="button"
          >
            Cancelar edição
          </button>
        ) : null}
      </div>

      <form className="expense-form" noValidate onSubmit={handleSubmit}>
        <div className="expense-field">
          <label className="field-label" htmlFor={fieldId("amount")}>
            Valor (R$)
          </label>
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
          <FieldError errors={errors} field="amount" />
        </div>

        <div className="expense-field">
          <label className="field-label" htmlFor={fieldId("categoryId")}>
            Categoria
          </label>
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
          <FieldError errors={errors} field="categoryId" />
        </div>

        <div className="expense-field">
          <label className="field-label" htmlFor={fieldId("competenceOn")}>
            Data de competência
          </label>
          <input
            aria-describedby={describedBy(
              errors,
              "competenceOn",
              "expense-competence-help"
            )}
            aria-invalid={errors.competenceOn ? true : undefined}
            disabled={disabled}
            id={fieldId("competenceOn")}
            min={EARLIEST_EXPENSE_COMPETENCE}
            name="competenceOn"
            onChange={handleChange}
            type="date"
            value={draft.competenceOn}
          />
          <p className="field-help" id="expense-competence-help">
            O período a que a despesa pertence, não o dia do pagamento.
          </p>
          <FieldError errors={errors} field="competenceOn" />
        </div>

        <div className="expense-field">
          <label className="field-label" htmlFor={fieldId("payee")}>
            Favorecido <span className="field-optional">Opcional</span>
          </label>
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
          <FieldError errors={errors} field="payee" />
        </div>

        <div className="expense-field expense-field-wide">
          <label className="field-label" htmlFor={fieldId("description")}>
            Descrição
          </label>
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
          <FieldError errors={errors} field="description" />
        </div>

        <div className="expense-form-actions">
          <button className="primary-button" disabled={disabled} type="submit">
            {submitLabel(saving, editing !== null)}
          </button>
        </div>
      </form>
    </section>
  );
}
