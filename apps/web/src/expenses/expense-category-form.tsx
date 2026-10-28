import type { ExpenseCategoryReadModel } from "@polaris/contracts";
import { MAX_EXPENSE_CATEGORY_NAME_LENGTH } from "@polaris/domain/expenses/expense";
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
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
import { isDraftChanged, useHoldSwap } from "../lib/unsent-work";
import { SelectField } from "../sales/sale-fields";
import { ActionNotice, ExpenseTextField } from "./expense-fields";
import { EXPENSE_GROUP_ORDER, type ExpenseGroupKey } from "./expense-model";
import type { Feedback } from "./use-command-runner";

export interface CategoryDraft {
  group: ExpenseGroupKey;
  name: string;
}

interface ExpenseCategoryFormProps {
  disabled: boolean;
  /** The category being renamed; null creates one. */
  editing: ExpenseCategoryReadModel | null;
  /** What the last command said while the form is open: the dialog covers the top of the screen. */
  feedback: Feedback | null;
  /** What was typed and kept when the form was closed by Esc or "Fechar", for the same category or a new one. */
  keptDraft?: CategoryDraft | undefined;
  onCancel: () => void;
  /** Every change of the draft, so the panel can keep it when the form closes; `null` while it is as it started. */
  onDraftChange: (draft: CategoryDraft | null) => void;
  /** Resolves when the command is over; the panel closes the dialog when it went through. */
  onSave: (draft: CategoryDraft) => Promise<void>;
}

const GROUP_OPTIONS = EXPENSE_GROUP_ORDER.map((item) => ({
  id: item.key,
  label: item.label,
}));

const NAME_FIELD_ID = "expense-category-name";

function draftFrom(editing: ExpenseCategoryReadModel | null): CategoryDraft {
  return editing
    ? { group: editing.groupKey, name: editing.name }
    : { group: "operational", name: "" };
}

/**
 * The content of the category dialog (the whole screen on a phone): a new category with its group and name, or a new
 * name for the one given (the group of a category does not change).
 */
export function ExpenseCategoryForm({
  disabled,
  editing,
  feedback,
  keptDraft,
  onCancel,
  onDraftChange,
  onSave,
}: ExpenseCategoryFormProps) {
  const [draft, setDraft] = useState<CategoryDraft>(
    () => keptDraft ?? draftFrom(editing)
  );
  const [initialDraft] = useState<CategoryDraft>(() => draftFrom(editing));
  const [error, setError] = useState<string | null>(null);
  const changed = isDraftChanged(draft, initialDraft);
  useEffect(
    () => onDraftChange(changed ? draft : null),
    [changed, draft, onDraftChange]
  );
  useHoldSwap(changed);
  const online = useConnectionOnline();

  const handleGroup = useCallback((value: string) => {
    const match = EXPENSE_GROUP_ORDER.find((item) => item.key === value);
    if (match) {
      setDraft((current) => ({ ...current, group: match.key }));
    }
  }, []);
  const handleName = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const name = event.currentTarget.value;
    setDraft((current) => ({ ...current, name }));
    setError(null);
  }, []);
  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (draft.name.trim() === "") {
        setError("Informe o nome da categoria.");
        focusLater(() => document.getElementById(NAME_FIELD_ID)?.focus());
        return;
      }
      if (editing && draft.name.trim() === editing.name) {
        onCancel();
        return;
      }
      await onSave(draft);
    },
    [draft, editing, onCancel, onSave]
  );

  return (
    <DialogForm onSubmit={handleSubmit}>
      <DialogHeader>
        <DialogTitle>
          {editing ? "Renomear categoria" : "Nova categoria"}
        </DialogTitle>
      </DialogHeader>
      <DialogBody>
        {feedback ? <ActionNotice feedback={feedback} /> : null}
        {editing ? null : (
          <SelectField
            disabled={disabled}
            id="expense-new-category-group"
            label="Grupo"
            onChange={handleGroup}
            options={GROUP_OPTIONS}
            placeholder="Escolha o grupo"
            value={draft.group}
          />
        )}
        <ExpenseTextField
          disabled={disabled}
          error={error ?? undefined}
          id={NAME_FIELD_ID}
          label="Nome da categoria"
          maxLength={MAX_EXPENSE_CATEGORY_NAME_LENGTH}
          onChange={handleName}
          value={draft.name}
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
          disabled={disabled}
          type="submit"
        >
          {editing ? "Salvar" : "Adicionar categoria"}
        </Button>
      </DialogFooter>
    </DialogForm>
  );
}
