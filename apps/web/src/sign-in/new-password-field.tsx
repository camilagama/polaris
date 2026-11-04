import {
  hasSpecialCharacter,
  meetsPasswordRequirement,
  PASSWORD_REQUIREMENTS,
  type PasswordRequirement,
  type PasswordStrength,
  passwordStrength,
  unmetPasswordRequirements,
} from "@polaris/domain/auth/password-rules";
import CheckIcon from "lucide-react/dist/esm/icons/check";
import XIcon from "lucide-react/dist/esm/icons/x";
import { type ChangeEvent, type Ref, useCallback } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Field, FieldError, FieldLabel } from "@/ui/field";
import { InputGroup, InputGroupInput } from "@/ui/input-group";
import {
  HIDE_PASSWORD,
  HIDE_PASSWORD_LABEL,
  PASSWORD_REQUIREMENT_TEXTS,
  PASSWORD_REQUIREMENTS_LABEL,
  PASSWORD_SPECIAL_HINT,
  PASSWORD_STRENGTH_TEXTS,
  REQUIREMENT_MET,
  REQUIREMENT_UNMET,
  SHOW_PASSWORD,
  SHOW_PASSWORD_LABEL,
} from "./password-texts";

/** The ids the form needs: the submit button names the list as the reason it is off. */
const requirementsId = (id: string) => `${id}-requirements`;

/** The id the submit button names as what is missing while a required rule is; undefined when none is. */
export function heldByRequirements(
  id: string,
  value: string
): string | undefined {
  return unmetPasswordRequirements(value).length > 0
    ? requirementsId(id)
    : undefined;
}

const BAR_COLOR: Record<PasswordStrength, string> = {
  0: "bg-muted",
  1: "bg-destructive",
  2: "bg-destructive",
  3: "bg-warning",
  4: "bg-primary",
};
const BARS = [1, 2, 3, 4] as const;

function StrengthMeter({
  id,
  strength,
}: {
  id: string;
  strength: PasswordStrength;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div aria-hidden="true" className="flex gap-1" data-slot="password-meter">
        {BARS.map((bar) => (
          <span
            className={cn(
              "h-1 flex-1 rounded-full",
              bar <= strength ? BAR_COLOR[strength] : "bg-muted"
            )}
            data-filled={bar <= strength || undefined}
            key={bar}
          />
        ))}
      </div>
      {/* changes only when the level changes, so a reader hears the level and not every key */}
      <p
        aria-live="polite"
        className="font-medium text-muted-foreground text-support"
        id={`${id}-strength`}
      >
        {PASSWORD_STRENGTH_TEXTS[strength]}
      </p>
    </div>
  );
}

function RequirementItem({
  flagged,
  met,
  text,
}: {
  flagged: boolean;
  met: boolean;
  text: string;
}) {
  const Icon = met ? CheckIcon : XIcon;
  return (
    <li
      className={cn(
        "flex items-center gap-1.5 text-support",
        met ? "text-foreground" : "text-muted-foreground",
        flagged && !met && "text-destructive"
      )}
      data-met={met}
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span>
        {text}
        <span className="sr-only">
          {`, ${met ? REQUIREMENT_MET : REQUIREMENT_UNMET}`}
        </span>
      </span>
    </li>
  );
}

/**
 * The field of a new password (sign-up, reset and change): show/hide, a meter of 0 to 4 and the list of the
 * rules with ✓/✗, always drawn in the same space, so nothing below moves while the person types. The rules are
 * `@polaris/domain/auth/password-rules`, the ones the server checks. `flagged` is set by a submit with a rule
 * missing: the field is `aria-invalid` and the missing rules turn red, in place, without a new line.
 */
export function NewPasswordField({
  error,
  fieldRef,
  flagged,
  id,
  label,
  name,
  onChange,
  onToggle,
  value,
  visible,
}: {
  error: string | null;
  fieldRef?: Ref<HTMLInputElement>;
  flagged: boolean;
  id: string;
  label: string;
  name: string;
  onChange: (value: string) => void;
  onToggle: () => void;
  value: string;
  visible: boolean;
}) {
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value),
    [onChange]
  );
  // the flag of a submit lasts while a rule is missing: once every rule is met the field is valid again
  const invalid =
    (flagged && unmetPasswordRequirements(value).length > 0) || error !== null;
  return (
    <Field data-invalid={invalid || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <InputGroup>
        <InputGroupInput
          aria-describedby={[
            requirementsId(id),
            `${id}-strength`,
            error === null ? "" : `${id}-error`,
          ]
            .filter(Boolean)
            .join(" ")}
          aria-invalid={invalid || undefined}
          autoCapitalize="none"
          autoComplete="new-password"
          autoCorrect="off"
          id={id}
          name={name}
          onChange={handleChange}
          ref={fieldRef}
          spellCheck={false}
          type={visible ? "text" : "password"}
          value={value}
        />
        <Button
          aria-controls={id}
          aria-label={visible ? HIDE_PASSWORD_LABEL : SHOW_PASSWORD_LABEL}
          className="mr-1 text-muted-foreground hover:text-foreground"
          onClick={onToggle}
          size="xs"
          type="button"
          variant="ghost"
        >
          {visible ? HIDE_PASSWORD : SHOW_PASSWORD}
        </Button>
      </InputGroup>
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
      <StrengthMeter id={id} strength={passwordStrength(value)} />
      <ul
        aria-label={PASSWORD_REQUIREMENTS_LABEL}
        className="flex flex-col gap-1"
        id={requirementsId(id)}
      >
        {PASSWORD_REQUIREMENTS.map((requirement: PasswordRequirement) => (
          <RequirementItem
            flagged={flagged}
            key={requirement}
            met={meetsPasswordRequirement(value, requirement)}
            text={PASSWORD_REQUIREMENT_TEXTS[requirement]}
          />
        ))}
        <RequirementItem
          flagged={false}
          met={hasSpecialCharacter(value)}
          text={PASSWORD_SPECIAL_HINT}
        />
      </ul>
    </Field>
  );
}
