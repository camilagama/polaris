import type { ExpenseCategoryReadModel } from "@polaris/contracts";
import CircleAlertIcon from "lucide-react/dist/esm/icons/circle-alert";
import CircleCheckIcon from "lucide-react/dist/esm/icons/circle-check";
import RefreshCwIcon from "lucide-react/dist/esm/icons/refresh-cw";
import {
  type ChangeEvent,
  type ComponentProps,
  type ReactNode,
  type Ref,
  useCallback,
} from "react";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Field, FieldLabel } from "@/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/ui/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { describedBy, FieldTexts } from "../sales/sale-fields";
import { groupCategories } from "./expense-model";
import type { Feedback } from "./use-command-runner";

/* The fields and notices of the expenses screen on the components of src/ui (ADR 0103): label, control, help and
   error, with the ids of the error ("{id}-error") and of the help ("{id}-hint") in aria-describedby. */

interface ExpenseTextFieldProps {
  /** Text before the control, as the "R$" of an amount. */
  addon?: string | undefined;
  className?: string | undefined;
  disabled?: boolean | undefined;
  error?: string | undefined;
  hint?: string | undefined;
  id: string;
  inputMode?: ComponentProps<"input">["inputMode"];
  label: string;
  maxLength?: number | undefined;
  /** The draft field the change writes (the form reads it from the event). */
  name?: string | undefined;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  /** "Opcional" beside the label, in the same words on every form. */
  optional?: boolean | undefined;
  placeholder?: string | undefined;
  value: string;
}

export function ExpenseTextField({
  addon,
  className,
  disabled,
  error,
  hint,
  id,
  inputMode,
  label,
  maxLength,
  name,
  onChange,
  optional,
  placeholder,
  value,
}: ExpenseTextFieldProps) {
  return (
    <Field className={cn("min-w-0", className)} data-invalid={Boolean(error)}>
      <FieldLabel htmlFor={id}>
        {label}
        {optional ? (
          <span className="font-normal text-muted-foreground">Opcional</span>
        ) : null}
      </FieldLabel>
      <InputGroup>
        {addon ? <InputGroupAddon>{addon}</InputGroupAddon> : null}
        <InputGroupInput
          aria-describedby={describedBy(id, error, hint)}
          aria-invalid={error ? true : undefined}
          autoComplete="off"
          disabled={disabled}
          id={id}
          inputMode={inputMode}
          maxLength={maxLength}
          name={name}
          onChange={onChange}
          placeholder={placeholder}
          value={value}
        />
      </InputGroup>
      <FieldTexts error={error} hint={hint} id={id} />
    </Field>
  );
}

function categoryLabel(category: ExpenseCategoryReadModel): string {
  return category.status === "archived"
    ? `${category.name} (arquivada)`
    : category.name;
}

interface ExpenseCategorySelectProps {
  /** An item for "no category" with this text (the filter's "Todas as categorias"); without it, a placeholder. */
  allLabel?: string | undefined;
  categories: readonly ExpenseCategoryReadModel[];
  className?: string | undefined;
  disabled?: boolean | undefined;
  error?: string | undefined;
  id: string;
  label: string;
  onChange: (categoryId: string) => void;
  placeholder?: string | undefined;
  /** "" is no category. */
  value: string;
}

/** The categories under the name of their group (Base UI Select): it opens below the field, never over it. */
export function ExpenseCategorySelect({
  allLabel,
  categories,
  className,
  disabled,
  error,
  id,
  label,
  onChange,
  placeholder,
  value,
}: ExpenseCategorySelectProps) {
  const handleChange = useCallback(
    (next: string | null) => onChange(next ?? ""),
    [onChange]
  );
  const items: { label: string; value: string | null }[] = categories.map(
    (category) => ({ label: categoryLabel(category), value: category.id })
  );
  if (allLabel) {
    items.unshift({ label: allLabel, value: null });
  }
  const labelId = `${id}-label`;
  return (
    <Field className={cn("min-w-0", className)} data-invalid={Boolean(error)}>
      <FieldLabel id={labelId}>{label}</FieldLabel>
      <Select
        disabled={disabled}
        items={items}
        onValueChange={handleChange}
        value={value === "" ? null : value}
      >
        <SelectTrigger
          aria-describedby={describedBy(id, error, undefined)}
          aria-invalid={error ? true : undefined}
          aria-labelledby={labelId}
          className="w-full min-w-0"
          id={id}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {allLabel ? <SelectItem value={null}>{allLabel}</SelectItem> : null}
          {groupCategories(categories).map((section) => (
            <SelectGroup key={section.key}>
              <SelectLabel>{section.label}</SelectLabel>
              {section.items.map((category) => (
                <SelectItem key={category.id} value={category.id}>
                  {categoryLabel(category)}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
      <FieldTexts error={error} hint={undefined} id={id} />
    </Field>
  );
}

/** "Desfazer" stays reachable while it cannot run (`aria-disabled`) and reads why, as in Produtos. */
function UndoButton({
  disabled,
  onUndo,
  reasonId,
}: {
  disabled: boolean | undefined;
  onUndo: () => void;
  reasonId: string | undefined;
}) {
  return (
    <Button
      aria-describedby={disabled ? reasonId : undefined}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onUndo}
      size="sm"
      type="button"
      variant="link"
    >
      Desfazer
    </Button>
  );
}

/**
 * A success note (`status`) or an error (`alert`), or nothing: no gap is drawn without a message. An error may carry
 * more under its text (the way to the Pro of a plan's limit) and take the focus (`errorRef`).
 */
export function ActionNotice({
  errorExtra,
  errorRef,
  feedback,
  noticeRef,
  onUndo,
  undoDisabled,
  undoReasonId,
}: {
  errorExtra?: ReactNode;
  errorRef?: Ref<HTMLDivElement> | undefined;
  feedback: Feedback | null;
  /** The success notice takes the focus (a button that left the list had it). */
  noticeRef?: Ref<HTMLDivElement> | undefined;
  /** The button "Desfazer" of the success notice; none without it. */
  onUndo?: (() => void) | undefined;
  /** No connection or a command running: "Desfazer" stays reachable and reads why it is off. */
  undoDisabled?: boolean | undefined;
  undoReasonId?: string | undefined;
}) {
  if (!feedback) {
    return null;
  }
  return feedback.kind === "error" ? (
    <Alert
      ref={errorRef}
      tabIndex={errorRef ? -1 : undefined}
      variant="destructive"
    >
      <CircleAlertIcon aria-hidden="true" />
      <AlertDescription
        className={
          onUndo ? "flex flex-wrap items-center gap-x-3 gap-y-1" : undefined
        }
      >
        {feedback.text}
        {errorExtra}
        {onUndo ? (
          <UndoButton
            disabled={undoDisabled}
            onUndo={onUndo}
            reasonId={undoReasonId}
          />
        ) : null}
      </AlertDescription>
    </Alert>
  ) : (
    <Alert
      className="focus-ring"
      ref={noticeRef}
      tabIndex={noticeRef ? -1 : undefined}
    >
      <CircleCheckIcon aria-hidden="true" />
      <AlertDescription
        className={
          onUndo ? "flex flex-wrap items-center gap-x-3 gap-y-1" : undefined
        }
      >
        {feedback.text}
        {onUndo ? (
          <UndoButton
            disabled={undoDisabled}
            onUndo={onUndo}
            reasonId={undoReasonId}
          />
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

interface LoadErrorProps {
  busy?: boolean | undefined;
  message: string;
  onRetry: () => void;
}

/** A read that failed: the reason and "Tentar novamente"; never an empty list. */
export function LoadError({ busy, message, onRetry }: LoadErrorProps) {
  return (
    <Alert variant="destructive">
      <CircleAlertIcon aria-hidden="true" />
      <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {message}
        <Button
          disabled={busy}
          onClick={onRetry}
          size="sm"
          type="button"
          variant="link"
        >
          <RefreshCwIcon aria-hidden="true" data-icon="inline-start" />
          Tentar novamente
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/**
 * A loading line or an empty list inside the card. Loading is said only to the screen reader; the box keeps the
 * height the visible line had, so the list that arrives does not push the screen.
 */
export function ListNote({
  children,
  loading,
}: {
  children: string;
  loading?: boolean | undefined;
}) {
  if (loading) {
    return (
      <div className="min-h-[5.25rem] md:min-h-[4.125rem]" role="status">
        <span className="sr-only">{children}</span>
      </div>
    );
  }
  return (
    // two lines kept on a phone: the empty list ("Nenhuma despesa neste período. Toque em…") takes this box
    <p className="min-h-[5.25rem] py-6 text-center text-muted-foreground text-support md:min-h-0">
      {children}
    </p>
  );
}
