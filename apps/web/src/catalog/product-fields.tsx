import {
  type ChangeEvent,
  type ComponentProps,
  type Ref,
  useCallback,
} from "react";
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
  /** An address or a handle is typed in lowercase: the keyboard does not capitalize. */
  autoCapitalize?: "none" | undefined;
  /** What the browser may fill in; the default is nothing ("off"). */
  autoComplete?: string | undefined;
  /**
   * The error is drawn by the caller (`<FieldError id="{id}-error">`), not under the field: a field beside a button
   * keeps both on the same line.
   */
  errorOutside?: boolean | undefined;
  inputMode?: ComponentProps<"input">["inputMode"];
  /** The input itself, for a screen that moves the focus to it (an error said at this field). */
  inputRef?: Ref<HTMLInputElement> | undefined;
  maxLength?: number | undefined;
  onChange: (value: string) => void;
  placeholder?: string | undefined;
  /** False for an address or a handle: no red line under what is not a word. */
  spellCheck?: boolean | undefined;
  /** The keyboard of a phone or an e-mail; the default is text. */
  type?: "email" | "tel" | "text" | undefined;
  value: string;
}

export function ProductTextField({
  addon,
  autoCapitalize,
  autoComplete = "off",
  className,
  disabled,
  error,
  errorOutside,
  hint,
  id,
  inputMode,
  inputRef,
  label,
  maxLength,
  onChange,
  optional,
  placeholder,
  spellCheck,
  type,
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
          autoCapitalize={autoCapitalize}
          autoComplete={autoComplete}
          disabled={disabled}
          id={id}
          inputMode={inputMode}
          maxLength={maxLength}
          onChange={handleChange}
          placeholder={placeholder}
          ref={inputRef}
          spellCheck={spellCheck}
          type={type}
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
  /** `polite` for an error rewritten at each key, such as a count over a limit; the default announces at once. */
  errorLive?: "assertive" | "polite" | undefined;
  maxLength?: number | undefined;
  onChange: (value: string) => void;
  rows?: number | undefined;
  value: string;
}

export function ProductTextAreaField({
  className,
  disabled,
  error,
  errorLive,
  hint,
  id,
  label,
  maxLength,
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
        maxLength={maxLength}
        onChange={handleChange}
        rows={rows}
        value={value}
      />
      <FieldTexts error={error} hint={hint} id={id} live={errorLive} />
    </Field>
  );
}
