import type { GoalReadModel } from "@polaris/contracts";
import { EARLIEST_EXPENSE_COMPETENCE } from "@polaris/domain/expenses/expense";
import { MAX_GOAL_NAME_LENGTH } from "@polaris/domain/goals/goal";
import {
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  useCallback,
  useState,
} from "react";
import { focusLater } from "../lib/focus";
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

interface GoalFieldProps {
  children: ReactNode;
  /** The inline error of the field, when there is one. */
  error: string | undefined;
  help?: string | undefined;
  id: string;
  label: string;
  optional?: boolean | undefined;
  wide?: boolean | undefined;
}

function describedBy(
  id: string,
  error: string | undefined,
  help: string | undefined
): string | undefined {
  const ids = [
    help ? `${id}-help` : undefined,
    error ? `${id}-error` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  return ids === "" ? undefined : ids;
}

/** Label, control, optional help text and the inline error of one field. */
function GoalField({
  children,
  error,
  help,
  id,
  label,
  optional,
  wide,
}: GoalFieldProps) {
  return (
    <div className={wide ? "goal-field goal-field-wide" : "goal-field"}>
      <label className="field-label" htmlFor={id}>
        {label}
        {optional ? <span className="field-optional"> Opcional</span> : null}
      </label>
      {children}
      {help ? (
        <p className="field-help" id={`${id}-help`}>
          {help}
        </p>
      ) : null}
      {error ? (
        <p className="field-error" id={`${id}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

interface TextFieldProps {
  disabled: boolean;
  error: string | undefined;
  help?: string | undefined;
  id: string;
  inputMode?: "decimal" | "numeric" | undefined;
  label: string;
  name: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  optional?: boolean | undefined;
  placeholder?: string | undefined;
  value: string;
  wide?: boolean | undefined;
}

function TextField({
  disabled,
  error,
  help,
  id,
  inputMode,
  label,
  name,
  onChange,
  optional,
  placeholder,
  value,
  wide,
}: TextFieldProps) {
  return (
    <GoalField
      error={error}
      help={help}
      id={id}
      label={label}
      optional={optional}
      wide={wide}
    >
      <input
        aria-describedby={describedBy(id, error, help)}
        aria-invalid={error ? true : undefined}
        autoComplete="off"
        disabled={disabled}
        id={id}
        inputMode={inputMode}
        maxLength={name === "name" ? MAX_GOAL_NAME_LENGTH : undefined}
        name={name}
        onChange={onChange}
        placeholder={placeholder}
        value={value}
      />
    </GoalField>
  );
}

const PERIOD_HELP = "O período pode ter no máximo 366 dias.";

function targetLabel(kind: GoalKind): string {
  return kind === "sale_count" ? "Alvo (número de vendas)" : "Alvo (R$)";
}

function targetPlaceholder(kind: GoalKind): string {
  return kind === "sale_count" ? "50" : "0,00";
}

function targetInputMode(kind: GoalKind): "decimal" | "numeric" {
  return kind === "sale_count" ? "numeric" : "decimal";
}

interface FormActionsProps {
  cancelLabel: string;
  disabled: boolean;
  label: string;
  onCancel: () => void;
}

function FormActions({
  cancelLabel,
  disabled,
  label,
  onCancel,
}: FormActionsProps) {
  return (
    <div className="goal-form-actions">
      <button
        className="quiet-button"
        disabled={disabled}
        onClick={onCancel}
        type="button"
      >
        {cancelLabel}
      </button>
      <button className="primary-button" disabled={disabled} type="submit">
        {label}
      </button>
    </div>
  );
}

// --------------------------------------------------------------------- create

interface GoalCreateFormProps {
  disabled: boolean;
  /** The month on screen (YYYY-MM): the period starts as that whole month. */
  month: string;
  onCancel: () => void;
  /** Resolves true when the goal was created. */
  onSave: (input: GoalCreateInput) => Promise<boolean>;
  saving: boolean;
}

function isDraftField(name: string): name is GoalDraftField {
  return (GOAL_DRAFT_FIELDS as readonly string[]).includes(name);
}

function createId(field: GoalDraftField): string {
  return `goal-create-${field}`;
}

/** Creates a goal. The parent gives it a new `key` to start over. */
export function GoalCreateForm({
  disabled,
  month,
  onCancel,
  onSave,
  saving,
}: GoalCreateFormProps) {
  const [draft, setDraft] = useState<GoalDraft>(() => newGoalDraft(month));
  const [errors, setErrors] = useState<GoalDraftErrors>({});

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const { name, value } = event.currentTarget;
      if (!isDraftField(name)) {
        return;
      }
      setDraft((current) => ({ ...current, [name]: value }));
      setErrors((current) => ({ ...current, [name]: undefined }));
    },
    []
  );

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const result = validateGoalDraft(draft);
      if (result.input === null) {
        setErrors(result.errors);
        const first = GOAL_DRAFT_FIELDS.find((field) => result.errors[field]);
        if (first) {
          focusLater(() => document.getElementById(createId(first))?.focus());
        }
        return;
      }
      await onSave(result.input);
    },
    [draft, onSave]
  );

  return (
    <form className="goal-form" noValidate onSubmit={handleSubmit}>
      <GoalField
        error={errors.kind}
        help={goalKindHint(draft.kind)}
        id={createId("kind")}
        label="O que a meta mede"
        wide
      >
        <select
          aria-describedby={describedBy(
            createId("kind"),
            errors.kind,
            goalKindHint(draft.kind)
          )}
          className="goal-select"
          disabled={disabled}
          id={createId("kind")}
          name="kind"
          onChange={handleChange}
          value={draft.kind}
        >
          {GOAL_KIND_OPTIONS.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </select>
      </GoalField>
      <TextField
        disabled={disabled}
        error={errors.name}
        id={createId("name")}
        label="Nome"
        name="name"
        onChange={handleChange}
        optional
        value={draft.name}
        wide
      />
      <GoalField
        error={errors.startsOn}
        id={createId("startsOn")}
        label="Começa em"
      >
        <input
          aria-describedby={describedBy(
            createId("startsOn"),
            errors.startsOn,
            undefined
          )}
          aria-invalid={errors.startsOn ? true : undefined}
          disabled={disabled}
          id={createId("startsOn")}
          min={EARLIEST_EXPENSE_COMPETENCE}
          name="startsOn"
          onChange={handleChange}
          type="date"
          value={draft.startsOn}
        />
      </GoalField>
      <GoalField
        error={errors.endsOn}
        help={PERIOD_HELP}
        id={createId("endsOn")}
        label="Termina em"
      >
        <input
          aria-describedby={describedBy(
            createId("endsOn"),
            errors.endsOn,
            PERIOD_HELP
          )}
          aria-invalid={errors.endsOn ? true : undefined}
          disabled={disabled}
          id={createId("endsOn")}
          min={draft.startsOn}
          name="endsOn"
          onChange={handleChange}
          type="date"
          value={draft.endsOn}
        />
      </GoalField>
      <TextField
        disabled={disabled}
        error={errors.target}
        id={createId("target")}
        inputMode={targetInputMode(draft.kind)}
        label={targetLabel(draft.kind)}
        name="target"
        onChange={handleChange}
        placeholder={targetPlaceholder(draft.kind)}
        value={draft.target}
        wide
      />
      <FormActions
        cancelLabel="Cancelar"
        disabled={disabled}
        label={saving ? "Criando…" : "Criar meta"}
        onCancel={onCancel}
      />
    </form>
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
      className="goal-form goal-edit-form"
      noValidate
      onSubmit={handleSubmit}
    >
      <TextField
        disabled={disabled}
        error={errors.name}
        id={editId(goal, "name")}
        label="Nome"
        name="name"
        onChange={handleName}
        optional
        value={name}
      />
      <TextField
        disabled={disabled}
        error={errors.target}
        help="Mudar o alvo é permitido e fica no histórico do alvo."
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
