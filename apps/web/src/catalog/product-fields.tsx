import { type ChangeEvent, type ComponentProps, useCallback } from "react";
import { cn } from "@/lib/utils";
import { Field, FieldLabel } from "@/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/ui/input-group";
import { Textarea } from "@/ui/textarea";
import { describedBy, FieldTexts } from "../sales/sale-fields";

/* The fields of the catalog screens on the components of src/ui (ADR 0103): label, control, help and error, with
   the ids of the error and of the help in aria-describedby. The select is the one of the sale (`SelectField`). */

interface FieldBaseProps {
  className?: string | undefined;
  disabled?: boolean | undefined;
  error?: string | undefined;
  hint?: string | undefined;
  id: string;
  label: string;
  /** "Opcional" beside the label, in the same words on every form. */
  optional?: boolean | undefined;
}

function LabelText({
  label,
  optional,
}: Pick<FieldBaseProps, "label" | "optional">) {
  if (!optional) {
    return label;
  }
  return (
    <>
      {label}{" "}
      <span className="font-normal text-muted-foreground">Opcional</span>
    </>
  );
}

interface ProductTextFieldProps extends FieldBaseProps {
  /** Text beside the control, as the "R$" of a price. */
  addon?: string | undefined;
  /**
   * The error is drawn by the caller (`<FieldError id="{id}-error">`), not under the field: a field beside a button
   * keeps both on the same line.
   */
  errorOutside?: boolean | undefined;
  inputMode?: ComponentProps<"input">["inputMode"];
  onChange: (value: string) => void;
  placeholder?: string | undefined;
  value: string;
}

export function ProductTextField({
  addon,
  className,
  disabled,
  error,
  errorOutside,
  hint,
  id,
  inputMode,
  label,
  onChange,
  optional,
  placeholder,
  value,
}: ProductTextFieldProps) {
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value),
    [onChange]
  );
  return (
    <Field className={cn("min-w-0", className)} data-invalid={Boolean(error)}>
      <FieldLabel htmlFor={id}>
        <LabelText label={label} optional={optional} />
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
          onChange={handleChange}
          placeholder={placeholder}
          value={value}
        />
      </InputGroup>
      <FieldTexts
        error={errorOutside ? undefined : error}
        hint={hint}
        id={id}
      />
    </Field>
  );
}

interface ProductTextAreaFieldProps extends FieldBaseProps {
  onChange: (value: string) => void;
  rows?: number | undefined;
  value: string;
}

export function ProductTextAreaField({
  className,
  disabled,
  error,
  hint,
  id,
  label,
  onChange,
  optional,
  rows = 3,
  value,
}: ProductTextAreaFieldProps) {
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value),
    [onChange]
  );
  return (
    <Field className={cn("min-w-0", className)} data-invalid={Boolean(error)}>
      <FieldLabel htmlFor={id}>
        <LabelText label={label} optional={optional} />
      </FieldLabel>
      <Textarea
        aria-describedby={describedBy(id, error, hint)}
        aria-invalid={error ? true : undefined}
        disabled={disabled}
        id={id}
        onChange={handleChange}
        rows={rows}
        value={value}
      />
      <FieldTexts error={error} hint={hint} id={id} />
    </Field>
  );
}
