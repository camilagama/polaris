import ChevronDownIcon from "lucide-react/dist/esm/icons/chevron-down";
import {
  type ChangeEvent,
  type KeyboardEvent,
  type Ref,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Button } from "@/ui/button";
import {
  type DateRange,
  type DraftRange,
  maskTypedDate,
  parseTypedDate,
  type TypedField,
  type TypedTexts,
  typedProblems,
  typedRange,
  typedTextsOf,
} from "@/ui/date-values";
import { FieldError } from "@/ui/field";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";

const FIELDS: readonly { field: TypedField; label: string }[] = [
  { field: "from", label: "Início" },
  { field: "to", label: "Fim" },
];

export interface DateRangeTypingProps {
  /** The button that applies the typed range, for an editor that closes on its own commit; none where the caller applies. */
  apply?: { blocked: boolean; onApply: () => void } | undefined;
  /** What is wrong with each field, shown under it, only for a field the person already left or tried to apply. */
  errors: Record<TypedField, string | undefined>;
  inputRefs: Record<TypedField, Ref<HTMLInputElement>>;
  onBlurField: (field: TypedField) => void;
  onToggle: () => void;
  onType: (field: TypedField, text: string) => void;
  open: boolean;
  /** The line of the footer that gives the reason the range cannot be applied: the apply button is described by it. */
  statusId: string | undefined;
  texts: TypedTexts;
}

function TypedDateField({
  error,
  field,
  id,
  inputRef,
  label,
  onBlurField,
  onEnter,
  onType,
  text,
}: {
  error: string | undefined;
  field: TypedField;
  id: string;
  inputRef: Ref<HTMLInputElement>;
  label: string;
  onBlurField: (field: TypedField) => void;
  onEnter: (() => void) | undefined;
  onType: (field: TypedField, text: string) => void;
  text: string;
}) {
  const errorId = `${id}-error`;
  const blur = useCallback(() => onBlurField(field), [field, onBlurField]);
  const change = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onType(field, event.target.value),
    [field, onType]
  );
  const keyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter" && onEnter) {
        event.preventDefault();
        onEnter();
      }
    },
    [onEnter]
  );
  return (
    <div className="grid min-w-0 content-start gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        aria-describedby={error ? errorId : undefined}
        aria-invalid={error ? true : undefined}
        autoComplete="off"
        enterKeyHint="done"
        id={id}
        inputMode="numeric"
        maxLength={10}
        onBlur={blur}
        onChange={change}
        onKeyDown={keyDown}
        placeholder="dd/mm/aaaa"
        ref={inputRef}
        value={text}
      />
      <FieldError id={errorId}>{error}</FieldError>
    </div>
  );
}

/**
 * "Digitar as datas" inside the panel of a period: a button that opens two text fields (Início, Fim) in `dd/mm/aaaa`,
 * never `type="date"` (the browser's own field differs from one to the other and has no mask on a phone). The fields
 * show and edit the draft the calendar shows. Where the panel closes on its own commit "Aplicar" sits under the fields,
 * `aria-disabled` (still focusable, so it reads why) until both days are good; the toggle is a disclosure button.
 */
export function DateRangeTyping({
  apply,
  errors,
  inputRefs,
  onBlurField,
  onToggle,
  onType,
  open,
  statusId,
  texts,
}: DateRangeTypingProps) {
  const base = useId();
  const regionId = `${base}-region`;

  return (
    <div className="grid shrink-0 gap-2">
      <Button
        aria-controls={regionId}
        aria-expanded={open}
        className="w-fit justify-self-start"
        onClick={onToggle}
        size="sm"
        type="button"
        variant="ghost"
      >
        Digitar as datas
        <ChevronDownIcon
          aria-hidden="true"
          className={open ? "rotate-180" : undefined}
          data-icon="inline-end"
        />
      </Button>
      {open ? (
        <div className="grid gap-3" id={regionId}>
          <div className="grid gap-3 min-[22rem]:grid-cols-2">
            {FIELDS.map(({ field, label }) => (
              <TypedDateField
                error={errors[field]}
                field={field}
                id={`${base}-${field}`}
                inputRef={inputRefs[field]}
                key={field}
                label={label}
                onBlurField={onBlurField}
                onEnter={apply?.onApply}
                onType={onType}
                text={texts[field]}
              />
            ))}
          </div>
          {apply ? (
            <Button
              aria-describedby={apply.blocked ? statusId : undefined}
              aria-disabled={apply.blocked || undefined}
              className="justify-self-end"
              onClick={apply.onApply}
              type="button"
            >
              Aplicar
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const NOT_SEEN: Record<TypedField, boolean> = { from: false, to: false };

interface TypedDatesOptions {
  /** The panel sits where the caller applies by a button of its own (the Dialog of a phone): no "Aplicar" here. */
  callerApplies: boolean;
  draft: DraftRange | undefined;
  onCommit: (range: DateRange | null) => void;
  setDraft: (draft: DraftRange | undefined) => void;
  /** Brings the calendar to the month of a draft the person typed. */
  setMonth: (draft: DraftRange) => void;
  statusId: string | undefined;
  /** The range the caller holds, both ends `AAAA-MM-DD`, or null: where the caller applies, closing the fields goes back to it. */
  value: DateRange | null;
}

/**
 * The state of the typed fields of a period panel. The texts follow the draft whenever the calendar or a shortcut
 * changes it (`adopt`), and a day that is typed whole goes the other way, to the draft and the month shown; so the
 * two show the same period. Where the panel closes on its own commit (the Popover) nothing leaves the panel until
 * "Aplicar"; where the caller applies (the Dialog) a good pair, or both fields emptied, is handed over at once and
 * any other state is told to the caller as "half" (`blocksCaller`), so its button never applies the older range.
 */
export function useTypedDates({
  callerApplies,
  draft,
  onCommit,
  setDraft,
  setMonth,
  statusId: statusIdProp,
  value,
}: TypedDatesOptions) {
  const ownStatusId = useId();
  const statusId = statusIdProp ?? ownStatusId;
  const [open, setOpen] = useState(false);
  const [texts, setTexts] = useState<TypedTexts>(() => typedTextsOf(draft));
  const [seen, setSeen] = useState(NOT_SEEN);
  const anchor = useRef<HTMLDivElement>(null);
  const fromRef = useRef<HTMLInputElement>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const problems = typedProblems(texts);
  const blank = texts.from === "" && texts.to === "";
  const hasProblem = problems.from !== undefined || problems.to !== undefined;
  const blocksCaller = open && hasProblem && !blank;
  const errors = {
    from: seen.from ? problems.from : undefined,
    to: seen.to ? problems.to : undefined,
  };
  const reason = !(callerApplies && blank) && (problems.from ?? problems.to);

  const adopt = useCallback(
    (next: DraftRange | undefined) => {
      setDraft(next);
      setTexts(typedTextsOf(next));
      setSeen(NOT_SEEN);
    },
    [setDraft]
  );

  const commit = useCallback(
    (range: DateRange | null) => {
      adopt(range ?? undefined);
      onCommit(range);
    },
    [adopt, onCommit]
  );

  const onType = useCallback(
    (field: TypedField, text: string) => {
      const next = { ...texts, [field]: maskTypedDate(text) };
      setTexts(next);
      const range = typedRange(next);
      const from = parseTypedDate(next.from);
      const nextDraft: DraftRange | undefined =
        range ?? (from.ok ? { from: from.iso, to: undefined } : undefined);
      setDraft(nextDraft);
      if (nextDraft) {
        setMonth(nextDraft);
      }
      if (callerApplies && (range || (next.from === "" && next.to === ""))) {
        onCommit(range);
      }
    },
    [callerApplies, onCommit, setDraft, setMonth, texts]
  );

  const focusFirstProblem = useCallback(() => {
    setSeen({ from: true, to: true });
    (problems.from ? fromRef : toRef).current?.focus();
  }, [problems.from]);

  const onApply = useCallback(() => {
    const range = typedRange(texts);
    if (range) {
      commit(range);
    } else {
      focusFirstProblem();
    }
  }, [commit, focusFirstProblem, texts]);

  const toggle = useCallback(() => {
    adopt(callerApplies ? (value ?? undefined) : draft);
    setOpen((was) => !was);
  }, [adopt, callerApplies, draft, value]);

  useEffect(() => {
    if (open) {
      fromRef.current?.focus();
    }
  }, [open]);

  // the button of the Dialog is a submit: pressed with the range not good, it says what is wrong and goes to the field
  useEffect(() => {
    const form = anchor.current?.closest("form");
    if (!(open && callerApplies && form)) {
      return;
    }
    const onSubmit = () => {
      if (blocksCaller) {
        focusFirstProblem();
      }
    };
    form.addEventListener("submit", onSubmit);
    return () => form.removeEventListener("submit", onSubmit);
  }, [blocksCaller, callerApplies, focusFirstProblem, open]);

  const onBlurField = useCallback(
    (field: TypedField) => setSeen((was) => ({ ...was, [field]: true })),
    []
  );

  return {
    adopt,
    anchor,
    blocksCaller,
    commit,
    open,
    reason: reason || undefined,
    statusId,
    statusQuiet: errors.from !== undefined || errors.to !== undefined,
    typingProps: {
      apply: callerApplies ? undefined : { blocked: hasProblem, onApply },
      errors,
      inputRefs: { from: fromRef, to: toRef },
      onBlurField,
      onToggle: toggle,
      onType,
      open,
      statusId,
      texts,
    } satisfies DateRangeTypingProps,
  };
}
