import MinusIcon from "lucide-react/dist/esm/icons/minus";
import PlusIcon from "lucide-react/dist/esm/icons/plus";
import RefreshCwIcon from "lucide-react/dist/esm/icons/refresh-cw";
import { type ChangeEvent, type ReactNode, useCallback } from "react";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button, buttonVariants } from "@/ui/button";
import { ButtonGroup } from "@/ui/button-group";
import { DatePicker } from "@/ui/date-picker";
import { DateRangePicker } from "@/ui/date-range-picker";
import type { DateRange, IsoDate } from "@/ui/date-values";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import {
  type CatalogView,
  type ChoiceOption,
  NEW_PRODUCT_LABEL,
} from "./sale-form-model";

/** The words of the "who splits the installments" field, shared by the payment profiles and the sale. */
export const INSTALLMENT_PLAN_LABEL = "Quem parcela";
export const INSTALLMENT_PLAN_PLACEHOLDER = "Escolha quem parcela";
export const INSTALLMENT_PLAN_OPTIONS: ChoiceOption[] = [
  { id: "merchant", label: "Lojista (eu)" },
  { id: "issuer", label: "Emissor (banco)" },
];

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
  live?: "assertive" | "polite" | undefined;
}

/** The help and the error under a control. */
export function FieldTexts({ error, hint, id, live }: FieldTextsProps) {
  return (
    <>
      {hint ? (
        <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription>
      ) : null}
      <FieldError id={`${id}-error`} live={live}>
        {error}
      </FieldError>
    </>
  );
}

interface TextFieldProps {
  /** Text beside the control, as the "R$" of a price. */
  addon?: string | undefined;
  className?: string | undefined;
  disabled?: boolean | undefined;
  error?: string | undefined;
  hint?: string | undefined;
  id: string;
  inputMode?: "decimal" | "numeric" | undefined;
  label: string;
  maxLength?: number | undefined;
  onChange: (value: string) => void;
  placeholder?: string | undefined;
  value: string;
}

export function TextField({
  addon,
  className,
  disabled,
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
          disabled={disabled}
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

interface DateFieldProps {
  className?: string | undefined;
  disabled?: boolean | undefined;
  /** Why the days after `max` or before `min` cannot be chosen ("Só até hoje"). */
  disabledReason?: string | undefined;
  /** The error under the button; `true` is "Escolha uma data". */
  error?: boolean | string | undefined;
  hint?: string | undefined;
  id: string;
  label: string;
  max?: IsoDate | undefined;
  min?: IsoDate | undefined;
  /** The name of the "Limpar" button of an optional field ("Limpar data de término"). */
  clearLabel?: string | undefined;
  /** "Opcional" beside the label, with a "Limpar" beside the button once a day is chosen. */
  optional?: boolean | undefined;
  /** The text form of the draft (`AAAA-MM-DD`, "" for none). */
  onChange: (value: string) => void;
  /** The organization's day (the screen has it from the server); the device's day when absent. */
  today?: string | undefined;
  value: string;
}

/** One date on the DatePicker of src/ui: label, button, help and error, in the shape of the other fields. */
export function DateField({
  className,
  clearLabel,
  disabled,
  disabledReason,
  error,
  hint,
  id,
  label,
  max,
  min,
  onChange,
  optional,
  today,
  value,
}: DateFieldProps) {
  const handleChange = useCallback(
    (next: IsoDate | null) => onChange(next ?? ""),
    [onChange]
  );
  const handleClear = useCallback(() => {
    onChange("");
    // the button is gone with the date: the focus goes back to the field it cleared
    document.getElementById(id)?.focus();
  }, [id, onChange]);
  return (
    <Field className={cn("min-w-0", className)} data-invalid={Boolean(error)}>
      <FieldLabel htmlFor={id}>
        {label}
        {optional ? (
          <span className="font-normal text-muted-foreground">Opcional</span>
        ) : null}
      </FieldLabel>
      <div className="flex flex-wrap items-center gap-2">
        <DatePicker
          className="min-w-0 flex-1 sm:flex-none"
          describedBy={hint ? `${id}-hint` : undefined}
          disabled={disabled}
          disabledReason={disabledReason}
          error={error}
          id={id}
          label={label}
          max={max}
          min={min}
          onValueChange={handleChange}
          today={today}
          value={value === "" ? null : value}
        />
        {optional && value !== "" ? (
          <Button
            aria-label={clearLabel ?? `Limpar ${label.toLowerCase()}`}
            disabled={disabled}
            onClick={handleClear}
            size="sm"
            type="button"
            variant="ghost"
          >
            Limpar
          </Button>
        ) : null}
      </div>
      {hint ? (
        <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription>
      ) : null}
    </Field>
  );
}

interface DateRangeFieldProps {
  className?: string | undefined;
  disabled?: boolean | undefined;
  error?: string | undefined;
  hint?: string | undefined;
  id: string;
  label: string;
  /** Both ends are written together: `from` and `to` of the draft are "" for none. */
  onChange: (range: DateRange | null) => void;
  today?: string | undefined;
  from: string;
  to: string;
}

/** A period on the DateRangePicker of src/ui, with the draft's two texts as value. */
export function DateRangeField({
  className,
  disabled,
  error,
  from,
  hint,
  id,
  label,
  onChange,
  to,
  today,
}: DateRangeFieldProps) {
  return (
    <Field className={cn("min-w-0", className)} data-invalid={Boolean(error)}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <DateRangePicker
        describedBy={hint ? `${id}-hint` : undefined}
        disabled={disabled}
        error={error}
        id={id}
        label={label}
        onValueChange={onChange}
        today={today}
        value={from !== "" && to !== "" ? { from, to } : null}
      />
      {hint ? (
        <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription>
      ) : null}
    </Field>
  );
}

interface QuantityStepperProps {
  error: string | undefined;
  hint?: string | undefined;
  id: string;
  label: string;
  /** The text after a tap on −, or null when that tap is not possible (the button is off). */
  less: string | null;
  /** The same for +. */
  more: string | null;
  onChange: (value: string) => void;
  value: string;
}

/**
 * − field +. The field is 64 px wide: with touch each button has a 48 px area, 6 px past each
 * side, and 52 px of the field stay free between the two areas, so a thumb on the number never hits − or +.
 * The buttons are named without the word "quantidade", so the label of the field names the field only.
 */
export function QuantityStepper({
  error,
  hint,
  id,
  label,
  less,
  more,
  onChange,
  value,
}: QuantityStepperProps) {
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value),
    [onChange]
  );
  const handleLess = useCallback(() => {
    if (less !== null) {
      onChange(less);
    }
  }, [less, onChange]);
  const handleMore = useCallback(() => {
    if (more !== null) {
      onChange(more);
    }
  }, [more, onChange]);
  return (
    <Field className="w-auto" data-invalid={Boolean(error)}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {/* the field has its own label: the group is only layout (role="none"), no nameless "group" to announce */}
      <ButtonGroup role="none">
        <Button
          aria-label="Menos uma unidade"
          disabled={less === null}
          onClick={handleLess}
          size="icon"
          type="button"
          variant="outline"
        >
          <MinusIcon aria-hidden="true" />
        </Button>
        <InputGroup className="w-16">
          <InputGroupInput
            aria-describedby={describedBy(id, error, hint)}
            aria-invalid={error ? true : undefined}
            autoComplete="off"
            className="px-1 text-center tabular-nums"
            id={id}
            inputMode="numeric"
            maxLength={10}
            onChange={handleChange}
            value={value}
          />
        </InputGroup>
        <Button
          aria-label="Mais uma unidade"
          disabled={more === null}
          onClick={handleMore}
          size="icon"
          type="button"
          variant="outline"
        >
          <PlusIcon aria-hidden="true" />
        </Button>
      </ButtonGroup>
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
  return (
    <div className="grid justify-items-start gap-3">
      <p className="text-muted-foreground text-support">{view.message}</p>
      {view.href ? <NewProductLink href={view.href} /> : null}
    </div>
  );
}

/** The way out of a sale with nothing to sell: the form of a new product, as a button. */
export function NewProductLink({ href }: { href: string }) {
  return (
    <a
      className={buttonVariants({ variant: "outline" })}
      data-slot="button"
      href={href}
    >
      {NEW_PRODUCT_LABEL}
    </a>
  );
}
