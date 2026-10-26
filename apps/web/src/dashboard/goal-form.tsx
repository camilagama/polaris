import type { GoalReadModel } from "@polaris/contracts";
import { MAX_GOAL_NAME_LENGTH } from "@polaris/domain/goals/goal";
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useState,
} from "react";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import type { DateRange } from "@/ui/date-values";
import { Field, FieldLabel } from "@/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { ActionNotice, ExpenseTextField } from "../expenses/expense-fields";
import { formatMonthLabel } from "../expenses/expense-model";
import type { Feedback } from "../expenses/use-command-runner";
import { focusLater } from "../lib/focus";
import { isDraftChanged, useReportUnsentWork } from "../lib/unsent-work";
import { DateRangeField, describedBy, FieldTexts } from "../sales/sale-fields";
import {
  GOAL_DRAFT_FIELDS,
  GOAL_KIND_OPTIONS,
  type GoalCreateInput,
  type GoalDraft,
  type GoalDraftErrors,
  type GoalDraftField,
  type GoalEditErrors,
  type GoalEditInput,
  type GoalKind,
  goalKindHint,
  goalTargetInputText,
  goalTitle,
  newGoalDraft,
  validateGoalDraft,
  validateGoalEdit,
} from "./goal-model";

const PERIOD_HELP = "O período pode ter no máximo 366 dias.";

/** The amount of a money goal carries its "R$"; a count says what it counts in the label. */
function targetLabel(kind: GoalKind): string {
  return kind === "sale_count" ? "Alvo (número de vendas)" : "Alvo";
}

function targetAddon(kind: GoalKind): string | undefined {
  return kind === "sale_count" ? undefined : "R$";
}

function targetPlaceholder(kind: GoalKind): string {
  return kind === "sale_count" ? "50" : "0,00";
}

function targetInputMode(kind: GoalKind): "decimal" | "numeric" {
  return kind === "sale_count" ? "numeric" : "decimal";
}

const KIND_ITEMS = GOAL_KIND_OPTIONS.map((option) => ({
  label: option.label,
  value: option.key,
}));

interface GoalKindSelectProps {
  disabled: boolean;
  error: string | undefined;
  id: string;
  onChange: (kind: GoalKind) => void;
  value: GoalKind;
}

/** "Indicador": what the goal measures, with the hint of the one chosen under the field. */
function GoalKindSelect({
  disabled,
  error,
  id,
  onChange,
  value,
}: GoalKindSelectProps) {
  const handleChange = useCallback(
    (next: GoalKind | null) => {
      if (next) {
        onChange(next);
      }
    },
    [onChange]
  );
  const hint = goalKindHint(value);
  const labelId = `${id}-label`;
  return (
    <Field className="min-w-0 md:col-span-2" data-invalid={Boolean(error)}>
      <FieldLabel id={labelId}>Indicador</FieldLabel>
      <Select
        disabled={disabled}
        items={KIND_ITEMS}
        onValueChange={handleChange}
        value={value}
      >
        <SelectTrigger
          aria-describedby={describedBy(id, error, hint)}
          aria-invalid={error ? true : undefined}
          aria-labelledby={labelId}
          className="w-full min-w-0"
          id={id}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {KIND_ITEMS.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldTexts error={error} hint={hint} id={id} />
    </Field>
  );
}

interface FormActionsProps {
  cancelLabel: string;
  disabled: boolean;
  label: string;
  onCancel: () => void;
}

/** "Criar meta" first (ink), the way out in outline beside it. */
function FormActions({
  cancelLabel,
  disabled,
  label,
  onCancel,
}: FormActionsProps) {
  return (
    <div className="flex flex-wrap gap-2 sm:col-span-2">
      <Button disabled={disabled} type="submit">
        {label}
      </Button>
      <Button
        disabled={disabled}
        onClick={onCancel}
        type="button"
        variant="outline"
      >
        {cancelLabel}
      </Button>
    </div>
  );
}

// --------------------------------------------------------------------- create

interface GoalCreateFormProps {
  disabled: boolean;
  /** What the last command said while the form is open: the dialog covers the top of the screen. */
  feedback: Feedback | null;
  /** Where the focus goes when the form closes: what opened it. */
  finalFocus: () => HTMLElement | boolean;
  /** What was typed and kept when the form was closed by Esc or "Fechar". */
  keptDraft?: GoalDraft | undefined;
  /** The month on screen (YYYY-MM): the period starts as that whole month. */
  month: string;
  onCancel: () => void;
  /** Every change of the draft, so the panel can keep it when the form closes; `null` while it is as it started. */
  onDraftChange: (draft: GoalDraft | null) => void;
  /** Esc and "Fechar": the form closes and what was typed is kept, in memory, for the next opening. */
  onDismiss: () => void;
  /** Resolves true when the goal was created. */
  onSave: (input: GoalCreateInput) => Promise<boolean>;
  open: boolean;
  saving: boolean;
  /** The organization's today, YYYY-MM-DD. */
  today: string;
}

function isDraftField(name: string): name is GoalDraftField {
  return (GOAL_DRAFT_FIELDS as readonly string[]).includes(name);
}

function createId(field: GoalDraftField): string {
  return `goal-create-${field}`;
}

type GoalCreateContentProps = Omit<
  GoalCreateFormProps,
  "finalFocus" | "onDismiss" | "open"
>;

const PERIOD_ID = "goal-create-period";

/** The two ends of the period are one control: the error of either one focuses it. */
function controlId(field: GoalDraftField): string {
  return field === "startsOn" || field === "endsOn"
    ? PERIOD_ID
    : createId(field);
}

/**
 * Creates a goal, in a dialog (the whole screen on a phone). Esc and "Fechar" are "Cancelar" (nothing closes while a
 * save is on its way), and a tap on the veil does nothing, so what was typed is not lost by a slip. The content lives
 * only while the dialog does, so each opening starts from the month on screen.
 */
export function GoalCreateForm({
  finalFocus,
  onCancel,
  onDismiss,
  open,
  ...content
}: GoalCreateFormProps) {
  const { saving } = content;
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!(next || saving)) {
        onDismiss();
      }
    },
    [onDismiss, saving]
  );
  return (
    <Dialog disablePointerDismissal onOpenChange={handleOpenChange} open={open}>
      <DialogContent finalFocus={finalFocus} layout="form">
        <GoalCreateContent onCancel={onCancel} {...content} />
      </DialogContent>
    </Dialog>
  );
}

function GoalCreateContent({
  disabled,
  feedback,
  keptDraft,
  month,
  onCancel,
  onDraftChange,
  onSave,
  saving,
  today,
}: GoalCreateContentProps) {
  const [draft, setDraft] = useState<GoalDraft>(
    () => keptDraft ?? newGoalDraft(month)
  );
  const [errors, setErrors] = useState<GoalDraftErrors>({});
  // the form starts over under a new key, so what it started with is fixed for its life
  const [initialDraft] = useState<GoalDraft>(() => newGoalDraft(month));
  const changed = isDraftChanged(draft, initialDraft);
  // an Esc without typing keeps nothing: only a draft that differs from the start is worth bringing back
  useEffect(
    () => onDraftChange(changed ? draft : null),
    [changed, draft, onDraftChange]
  );
  useReportUnsentWork(changed);

  const handleChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const { name, value } = event.currentTarget;
    if (!isDraftField(name)) {
      return;
    }
    setDraft((current) => ({ ...current, [name]: value }));
    setErrors((current) => ({ ...current, [name]: undefined }));
  }, []);
  const handlePeriod = useCallback((range: DateRange | null) => {
    setDraft((current) => ({
      ...current,
      endsOn: range?.to ?? "",
      startsOn: range?.from ?? "",
    }));
    setErrors((current) => ({
      ...current,
      endsOn: undefined,
      startsOn: undefined,
    }));
  }, []);
  const handleKind = useCallback((kind: GoalKind) => {
    setDraft((current) => ({ ...current, kind }));
    setErrors((current) => ({ ...current, kind: undefined }));
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const result = validateGoalDraft(draft);
      if (result.input === null) {
        setErrors(result.errors);
        const first = GOAL_DRAFT_FIELDS.find((field) => result.errors[field]);
        if (first) {
          focusLater(() => document.getElementById(controlId(first))?.focus());
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
        <DialogTitle>Nova meta</DialogTitle>
        <DialogDescription>
          Começa em {formatMonthLabel(month)} e mede os mesmos números do
          Resultado.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="md:grid-cols-2">
        {feedback ? (
          <div className="md:col-span-2">
            <ActionNotice feedback={feedback} />
          </div>
        ) : null}
        <GoalKindSelect
          disabled={disabled}
          error={errors.kind}
          id={createId("kind")}
          onChange={handleKind}
          value={draft.kind}
        />
        <ExpenseTextField
          className="md:col-span-2"
          disabled={disabled}
          error={errors.name}
          id={createId("name")}
          label="Nome"
          maxLength={MAX_GOAL_NAME_LENGTH}
          name="name"
          onChange={handleChange}
          optional
          value={draft.name}
        />
        <DateRangeField
          className="md:col-span-2"
          disabled={disabled}
          error={errors.startsOn ?? errors.endsOn}
          from={draft.startsOn}
          hint={PERIOD_HELP}
          id={PERIOD_ID}
          label="Período da meta"
          onChange={handlePeriod}
          to={draft.endsOn}
          today={today}
        />
        <ExpenseTextField
          addon={targetAddon(draft.kind)}
          className="md:col-span-2 md:max-w-56"
          disabled={disabled}
          error={errors.target}
          id={createId("target")}
          inputMode={targetInputMode(draft.kind)}
          label={targetLabel(draft.kind)}
          name="target"
          onChange={handleChange}
          placeholder={targetPlaceholder(draft.kind)}
          value={draft.target}
        />
      </DialogBody>
      <DialogFooter>
        <Button
          disabled={disabled}
          onClick={onCancel}
          type="button"
          variant="outline"
        >
          Cancelar
        </Button>
        <Button disabled={disabled} type="submit">
          {saving ? "Criando…" : "Criar meta"}
        </Button>
      </DialogFooter>
    </DialogForm>
  );
}

// ----------------------------------------------------------------------- edit

interface GoalEditFormProps {
  disabled: boolean;
  goal: GoalReadModel;
  onCancel: () => void;
  /** Resolves true when the goal was saved. */
  onSave: (input: GoalEditInput) => Promise<boolean>;
  saving: boolean;
}

function editId(goal: GoalReadModel, field: "name" | "target"): string {
  return `goal-edit-${goal.id}-${field}`;
}

/** Changes the name and the target of an active goal; what it measures and its period stay. */
export function GoalEditForm({
  disabled,
  goal,
  onCancel,
  onSave,
  saving,
}: GoalEditFormProps) {
  const [name, setName] = useState(goal.name ?? "");
  const [target, setTarget] = useState(goalTargetInputText(goal));
  const [errors, setErrors] = useState<GoalEditErrors>({});
  useReportUnsentWork(
    name !== (goal.name ?? "") || target !== goalTargetInputText(goal)
  );

  const handleName = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setName(event.currentTarget.value);
    setErrors((current) => ({ ...current, name: undefined }));
  }, []);
  const handleTarget = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setTarget(event.currentTarget.value);
    setErrors((current) => ({ ...current, target: undefined }));
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const result = validateGoalEdit(goal.kind, { name, target });
      if (result.input === null) {
        setErrors(result.errors);
        const first = result.errors.name ? "name" : "target";
        focusLater(() => document.getElementById(editId(goal, first))?.focus());
        return;
      }
      await onSave(result.input);
    },
    [goal, name, onSave, target]
  );

  return (
    <form
      aria-label={`Editar ${goalTitle(goal)}`}
      className="grid gap-4 sm:grid-cols-2"
      noValidate
      onSubmit={handleSubmit}
    >
      <ExpenseTextField
        className="sm:col-span-2"
        disabled={disabled}
        error={errors.name}
        id={editId(goal, "name")}
        label="Nome"
        maxLength={MAX_GOAL_NAME_LENGTH}
        name="name"
        onChange={handleName}
        optional
        value={name}
      />
      <ExpenseTextField
        addon={targetAddon(goal.kind)}
        className="sm:col-span-2 sm:max-w-56"
        disabled={disabled}
        error={errors.target}
        hint="Mudar o alvo é permitido e fica no histórico do alvo."
        id={editId(goal, "target")}
        inputMode={targetInputMode(goal.kind)}
        label={targetLabel(goal.kind)}
        name="target"
        onChange={handleTarget}
        placeholder={targetPlaceholder(goal.kind)}
        value={target}
      />
      <FormActions
        cancelLabel="Cancelar edição"
        disabled={disabled}
        label={saving ? "Salvando…" : "Salvar alterações"}
        onCancel={onCancel}
      />
    </form>
  );
}
