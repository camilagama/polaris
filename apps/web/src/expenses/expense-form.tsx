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
import { Button } from "@/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";
import { connectionControlProps } from "../app-shell/connection-required-notice";
import { useConnectionOnline } from "../lib/browser-connection";
import { focusLater } from "../lib/focus";
import { useReportUnsentWork } from "../lib/unsent-work";
import { ExpenseCategorySelect, ExpenseTextField } from "./expense-fields";
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

const FORM_TITLE_ID = "expense-form-title";

function fieldId(field: ExpenseDraftField): string {
  return `expense-${field}`;
}

function submitLabel(saving: boolean, editing: boolean): string {
  if (saving) {
    return "Salvando…";
  }
  return editing ? "Salvar alterações" : "Registrar despesa";
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
  const online = useConnectionOnline();

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

  const handleChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const { name, value } = event.currentTarget;
    if (isDraftField(name)) {
      setDraft((current) => ({ ...current, [name]: value }));
      setErrors((current) => ({ ...current, [name]: undefined }));
    }
  }, []);

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
    <Card aria-labelledby={FORM_TITLE_ID} role="region">
      <CardHeader layout="wide-row">
        <CardTitle aria-level={2} id={FORM_TITLE_ID} role="heading">
          {editing ? "Editar despesa" : "Nova despesa"}
        </CardTitle>
        {editing ? (
          <Button
            disabled={disabled}
            onClick={onCancel}
            size="sm"
            type="button"
            variant="outline"
          >
            Cancelar edição
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
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
            label="Valor (R$)"
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
          <ExpenseTextField
            disabled={disabled}
            error={errors.competenceOn}
            hint="O mês a que a despesa se refere, não o dia do pagamento."
            id={fieldId("competenceOn")}
            label="Data de competência"
            min={EARLIEST_EXPENSE_COMPETENCE}
            name="competenceOn"
            onChange={handleChange}
            type="date"
            value={draft.competenceOn}
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
            hint="Compra de estoque e taxas já registradas na venda não entram aqui."
            id={fieldId("description")}
            label="Descrição"
            maxLength={MAX_EXPENSE_DESCRIPTION_LENGTH}
            name="description"
            onChange={handleChange}
            value={draft.description}
          />
          <div className="flex justify-end md:col-span-2">
            <Button
              {...connectionControlProps(online)}
              disabled={disabled}
              type="submit"
              wrap
            >
              {submitLabel(saving, editing !== null)}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
