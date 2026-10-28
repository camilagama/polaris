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
import {
  ConnectionRequiredDialogNotice,
  connectionControlProps,
  connectionDialogReasonId,
} from "../app-shell/connection-required-notice";
import { useConnectionOnline } from "../lib/browser-connection";
import { focusLater } from "../lib/focus";
import { useHoldSwap } from "../lib/unsent-work";
import { DateField } from "../sales/sale-fields";
import {
  ActionNotice,
  ExpenseCategorySelect,
  ExpenseTextField,
} from "./expense-fields";
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
import type { Feedback } from "./use-command-runner";

interface ExpenseFormProps {
  /** Every category, archived ones included. */
  categories: readonly ExpenseCategoryReadModel[];
  disabled: boolean;
  editing: ExpenseReadModel | null;
  /** What the last command said while the form is open: the dialog covers the top of the screen. */
  feedback: Feedback | null;
  /** What was typed and kept when the form was closed by Esc or "Fechar", for the same expense or a new one. */
  keptDraft?: ExpenseDraft | undefined;
  onCancel: () => void;
  /** Every change of the draft, so the screen can keep it when the form closes; `null` while it is as it started. */
  onDraftChange: (draft: ExpenseDraft | null) => void;
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

/**
 * The content of the form dialog (the whole screen on a phone): creates an expense, or edits the one given. It lives
 * only while the dialog does, so each opening starts from the expense (or from a blank one); the parent also gives
 * it a new `key` for a different expense.
 */
export function ExpenseForm({
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
}: ExpenseFormProps) {
  const [draft, setDraft] = useState<ExpenseDraft>(
    () => keptDraft ?? draftFrom(editing, today)
  );
  const [errors, setErrors] = useState<ExpenseDraftErrors>({});
  // the form starts over under a new key, so what it started with is fixed for its life
  const [initialDraft] = useState<ExpenseDraft>(() =>
    draftFrom(editing, today)
  );
  const changed = isExpenseDraftChanged(draft, initialDraft);
  // an Esc without typing keeps nothing: only a draft that differs from the start is worth bringing back
  useEffect(
    () => onDraftChange(changed ? draft : null),
    [changed, draft, onDraftChange]
  );
  useHoldSwap(changed);
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

  const handleCompetence = useCallback((competenceOn: string) => {
    setDraft((current) => ({ ...current, competenceOn }));
    setErrors((current) => ({ ...current, competenceOn: undefined }));
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
    <DialogForm onSubmit={handleSubmit}>
      <DialogHeader>
        <DialogTitle>{editing ? "Editar despesa" : "Nova despesa"}</DialogTitle>
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
        <DateField
          disabled={disabled}
          error={errors.competenceOn}
          hint="O mês a que a despesa se refere, não o dia do pagamento."
          id={fieldId("competenceOn")}
          label="Data de competência"
          min={EARLIEST_EXPENSE_COMPETENCE}
          onChange={handleCompetence}
          today={today}
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
