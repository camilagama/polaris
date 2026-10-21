import RefreshCwIcon from "lucide-react/dist/esm/icons/refresh-cw";
import { type ChangeEvent, type ReactNode, useCallback } from "react";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import type { CatalogView, ChoiceOption } from "./sale-form-model";

/* The fields of the sale screen on the components of src/ui (ADR 0103): label, control, help and error, with
   the error and help ids in aria-describedby, as the old fields had. */

export function describedBy(
  id: string,
  error: string | undefined,
  hint: string | undefined
): string | undefined {
  const ids = [error ? `${id}-error` : null, hint ? `${id}-hint` : null].filter(
    (value): value is string => value !== null
  );
  return ids.length > 0 ? ids.join(" ") : undefined;
}

interface FieldTextsProps {
  error: string | undefined;
  hint: ReactNode;
  id: string;
}

/** The help and the error under a control. */
export function FieldTexts({ error, hint, id }: FieldTextsProps) {
  return (
    <>
      {hint ? (
        <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription>
      ) : null}
      <FieldError id={`${id}-error`}>{error}</FieldError>
    </>
  );
}

interface TextFieldProps {
  /** Text beside the control, as the "R$" of a price. */
  addon?: string | undefined;
  className?: string | undefined;
  error?: string | undefined;
  hint?: string | undefined;
  id: string;
  inputMode: "decimal" | "numeric";
  label: string;
  maxLength: number;
  onChange: (value: string) => void;
  placeholder?: string | undefined;
  value: string;
}

export function TextField({
  addon,
  className,
  error,
  hint,
  id,
  inputMode,
  label,
  maxLength,
  onChange,
  placeholder,
  value,
}: TextFieldProps) {
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value),
    [onChange]
  );
  return (
    <Field className={cn("min-w-0", className)} data-invalid={Boolean(error)}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <InputGroup>
        {addon ? <InputGroupAddon>{addon}</InputGroupAddon> : null}
        <InputGroupInput
          aria-describedby={describedBy(id, error, hint)}
          aria-invalid={error ? true : undefined}
          autoComplete="off"
          id={id}
          inputMode={inputMode}
          maxLength={maxLength}
          onChange={handleChange}
          placeholder={placeholder}
          value={value}
        />
      </InputGroup>
      <FieldTexts error={error} hint={hint} id={id} />
    </Field>
  );
}

interface SelectFieldProps {
  className?: string | undefined;
  disabled?: boolean | undefined;
  error?: string | undefined;
  hint?: string | undefined;
  id: string;
  label: string;
  onChange: (value: string) => void;
  options: readonly ChoiceOption[];
  placeholder: string;
  /** "" is no choice yet. */
  value: string;
}

/** A choice from a short list (Base UI Select): it opens below the field, never over it. */
export function SelectField({
  className,
  disabled,
  error,
  hint,
  id,
  label,
  onChange,
  options,
  placeholder,
  value,
}: SelectFieldProps) {
  const handleChange = useCallback(
    (next: string | null) => onChange(next ?? ""),
    [onChange]
  );
  const items = options.map((option) => ({
    label: option.label,
    value: option.id,
  }));
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
          aria-describedby={describedBy(id, error, hint)}
          aria-invalid={error ? true : undefined}
          aria-labelledby={labelId}
          className="w-full min-w-0"
          id={id}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
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

interface CatalogNoticeProps {
  onRetry: () => void;
  view: CatalogView | null;
}

/** Loading, error and empty states of a catalog read; renders nothing when ready. */
export function CatalogNotice({ onRetry, view }: CatalogNoticeProps) {
  if (view === null || view.kind === "ready") {
    return null;
  }
  if (view.kind === "loading") {
    return (
      <p className="text-muted-foreground text-support" role="status">
        {view.message}
      </p>
    );
  }
  if (view.kind === "error") {
    return (
      <Alert variant="destructive">
        <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {view.message}
          <Button onClick={onRetry} size="sm" type="button" variant="link">
            <RefreshCwIcon aria-hidden="true" data-icon="inline-start" />
            Tentar novamente
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  return <p className="text-muted-foreground text-support">{view.message}</p>;
}
