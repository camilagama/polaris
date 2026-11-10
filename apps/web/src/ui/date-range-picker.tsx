import CalendarDaysIcon from "lucide-react/dist/esm/icons/calendar-days";
import ChevronDownIcon from "lucide-react/dist/esm/icons/chevron-down";
import {
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
  type Ref,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { OnDemandCalendar, warmCalendar } from "@/ui/calendar-on-demand";
import {
  type DateRange,
  type DraftRange,
  daysInRange,
  formatDate,
  formatRange,
  type IsoDate,
  matchingPreset,
  maskTypedDate,
  nextRange,
  parseIsoDate,
  parseTypedDate,
  type RangePreset,
  type RangeSpan,
  shortcutRange,
  todayOr,
  toIsoDate,
  type TypedField,
  type TypedTexts,
  typedProblems,
  typedRange,
  typedTextsOf,
  validRange,
} from "@/ui/date-values";
import { DEFAULT_SHORTCUTS, shortcutsOf } from "@/ui/date-range-shortcuts";
import { FieldError } from "@/ui/field";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";

/** A screen that can read only some of the shortcuts (without a connection): the rest stay in place, off, with the reason. */
export interface RangeOnly {
  reason: string;
  shortcuts: readonly RangePreset[];
}

export interface DateRangePickerProps {
  /** The verb that ends the accessible name of the button, for a screen where the period is always set: "Período: 01/10 a 24/10, editar". */
  action?: string | undefined;
  className?: string | undefined;
  /** The id of a help text the screen shows under the button, read after the error. */
  describedBy?: string | undefined;
  disabled?: boolean | undefined;
  /** The screen has no future days: "Este mês" ends today, not on the last day of the month. */
  endsToday?: boolean | undefined;
  /** The error under the button (the screen's text). */
  error?: string | undefined;
  id?: string | undefined;
  /** Only these shortcuts can be chosen: the others, the days and the typed dates are off, and the reason is written. */
  only?: RangeOnly | undefined;
  /** The name of the field, in the accessible name of the button: "Período, 01/10 a 24/10". */
  label: string;
  /** The range chosen, or null for "Limpar"; `shortcut` says which one when a shortcut gave it. */
  onValueChange: (value: DateRange | null, shortcut?: RangePreset) => void;
  /** The shortcut shown as pressed, for a screen whose range is not exactly the one the shortcut gives (the Resultado reads the whole month); null for none. */
  pressed?: RangePreset | null | undefined;
  /** The shortcuts to show (`date-range-shortcuts.ts`): the four of the filters when absent. */
  shortcuts?: readonly RangePreset[] | undefined;
  /** The longest range the screen reads: a day that would make a longer one is off, and says why. */
  span?: RangeSpan | undefined;
  /** The store's day (the screen takes it from the server); the device's day when absent. */
  today?: IsoDate | undefined;
  /** The chosen range, both ends `AAAA-MM-DD`, or null. */
  value: DateRange | null;
  /** Whether the panel offers "Limpar"; a screen that always has a period turns it off. */
  clearable?: boolean | undefined;
}

/** The month shown first: the one where the range starts, or today's. */
function firstMonth(range: DraftRange | undefined, today: Date) {
  return parseIsoDate(range?.from) ?? today;
}

// the box takes the width of the month, whatever sentence an error or a status line holds: such a block adds nothing to
// the width the popup asks for (width 0) and fills what the month gave it (min-width 100%), so a long sentence wraps
const HOLD_WIDTH = "w-0 min-w-full";

// at 760 px and up the shortcuts are a column beside the month, the one in use marked; below it they are the segmented row
// above the month, and where the four do not fit (the window in the browser's own rem, so the large letter counts) the
// row scrolls sideways: the 6 px of padding on every side keep the 3 px focus ring (2 px off) and the 44 px touch area
// inside the box that scrolls, and the negative margin gives the space back
const SHORTCUTS_CLASS =
  "-mx-1.5 -mt-1.5 -mb-0.5 flex min-w-0 shrink-0 snap-x overflow-x-auto overscroll-x-contain rounded-md border-0 p-1.5 [scrollbar-width:thin] md:m-0 md:w-36 md:flex-col md:gap-0.5 md:self-start md:overflow-visible md:p-0";
const SHORTCUT_CLASS =
  "touch-hit focus-ring not-first:-ml-px inline-flex h-ctl-sm min-w-fit flex-auto snap-start items-center justify-center whitespace-nowrap border border-border bg-card px-2 font-medium text-foreground text-xs shadow-xs motion-full:transition-colors first:rounded-l-md last:rounded-r-md hover:bg-accent aria-pressed:bg-accent aria-pressed:text-accent-foreground dark:bg-transparent dark:hover:bg-accent dark:aria-pressed:bg-accent md:h-ctl-md md:flex-none md:justify-start md:rounded-md md:border-transparent md:bg-transparent md:px-3 md:text-sm md:shadow-none md:not-first:ml-0 md:first:rounded-md md:last:rounded-md md:aria-pressed:bg-accent";

const FIELD_LABELS: Record<TypedField, string> = { from: "Início", to: "Fim" };
// taken from the keys: a string literal of that word followed by a quote is read as an import by the source scan of src/ui
const FIELDS = Object.keys(FIELD_LABELS) as TypedField[];

interface DateRangeTypingProps {
  /** The button that applies the typed range, for an editor that closes on its own commit; none where the caller applies. */
  apply?: { blocked: boolean; onApply: () => void } | undefined;
  /** What is wrong with each field, shown under it, only for a field the person already left or tried to apply. */
  errors: Record<TypedField, string | undefined>;
  inputRefs: Record<TypedField, Ref<HTMLInputElement>>;
  /** What the button of the fields writes: the range the draft holds ("01/11 a 30/11"), or the name of the action. */
  label: string | undefined;
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
  const box = useRef<HTMLDivElement>(null);
  // the focus scroll brings the input into view, not the sentence that comes under it; the margin keeps the sentence whole
  // where the panel's height is fractional and the browser rounds the scroll position down to a whole pixel
  const showError = useCallback(() => {
    box.current?.scrollIntoView?.({ block: "nearest" });
  }, []);
  useEffect(() => {
    const input = box.current?.querySelector("input");
    if (error && input && document.activeElement === input) {
      showError();
    }
  }, [error, showError]);
  const focus = useCallback(() => {
    if (error) {
      showError();
    }
  }, [error, showError]);
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
    <div className="grid min-w-0 scroll-mb-1 content-start gap-1.5" ref={box}>
      <Label htmlFor={id}>{label}</Label>
      <Input
        aria-describedby={error ? errorId : undefined}
        aria-invalid={error ? true : undefined}
        autoComplete="off"
        enterKeyHint="done"
        id={id}
        inputMode="numeric"
        onBlur={blur}
        onChange={change}
        onFocus={focus}
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
 * "Digitar as datas" inside the panel of a period: a button under the month that writes the range of the draft and opens
 * two text fields (Início, Fim) in `dd/mm/aaaa`,
 * never `type="date"` (the browser's own field differs from one to the other and has no mask on a phone). The fields
 * show and edit the draft the calendar shows. Where the panel closes on its own commit "Aplicar" sits under the fields,
 * `aria-disabled` (still focusable, so it reads why) until both days are good; the toggle is a disclosure button.
 */
function DateRangeTyping({
  apply,
  errors,
  inputRefs,
  label,
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
    <div className={cn("grid shrink-0 gap-2", HOLD_WIDTH)}>
      <Button
        aria-controls={open ? regionId : undefined}
        aria-expanded={open}
        aria-label={label ? `Digitar as datas: ${label}` : undefined}
        className="w-fit justify-self-start tabular-nums"
        onClick={onToggle}
        size="sm"
        type="button"
        variant="ghost"
      >
        {label ?? "Digitar as datas"}
        <ChevronDownIcon
          aria-hidden="true"
          className={open ? "rotate-180" : undefined}
          data-icon="inline-end"
        />
      </Button>
      {open ? (
        <div className="grid gap-3" id={regionId}>
          <div className="grid gap-3 min-[22rem]:grid-cols-2">
            {FIELDS.map((field) => (
              <TypedDateField
                error={errors[field]}
                field={field}
                id={`${base}-${field}`}
                inputRef={inputRefs[field]}
                key={field}
                label={FIELD_LABELS[field]}
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
  onCommit: (range: DateRange | null, shortcut?: RangePreset) => void;
  setDraft: (draft: DraftRange | undefined) => void;
  /** Brings the calendar to the month of a draft the person typed. */
  setMonth: (draft: DraftRange) => void;
  statusId: string | undefined;
  span: RangeSpan | undefined;
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
function useTypedDates({
  callerApplies,
  draft,
  onCommit,
  setDraft,
  setMonth,
  span,
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
  const problems = typedProblems(texts, span);
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
    (range: DateRange | null, shortcut?: RangePreset) => {
      adopt(range ?? undefined);
      onCommit(range, shortcut);
    },
    [adopt, onCommit]
  );

  const onType = useCallback(
    (field: TypedField, text: string) => {
      const next = { ...texts, [field]: maskTypedDate(text) };
      setTexts(next);
      const range = typedRange(next, span);
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
    [callerApplies, onCommit, setDraft, setMonth, span, texts]
  );

  const focusFirstProblem = useCallback(() => {
    setSeen({ from: true, to: true });
    (problems.from ? fromRef : toRef).current?.focus();
  }, [problems.from]);

  const onApply = useCallback(() => {
    const range = typedRange(texts, span);
    if (range) {
      commit(range);
    } else {
      focusFirstProblem();
    }
  }, [commit, focusFirstProblem, span, texts]);

  const toggle = useCallback(() => {
    // opening shows the draft as the calendar has it, a touched first day included; closing drops what was typed and
    // goes back to the range the caller holds, which is what its own button would apply
    adopt(open && callerApplies ? (value ?? undefined) : draft);
    setOpen((was) => !was);
  }, [adopt, callerApplies, draft, open, value]);

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
    } satisfies Omit<DateRangeTypingProps, "label">,
  };
}

/**
 * The line under the panel: why the range cannot be applied yet (the first day waits for the last, or the typed error)
 * and "Limpar". It stays in the tree when there is nothing to say, so the screen reader hears it when it fills; then it
 * is out of the flow, and no empty row (a rule and a blank line) closes the panel. With the fields open the row keeps its
 * height, so the panel does not shrink under the pointer when the last error goes away.
 */
function DateRangeFooter({
  clearable,
  half,
  onClear,
  typed,
}: {
  clearable: boolean;
  half: IsoDate | undefined;
  onClear: () => void;
  typed: Pick<
    ReturnType<typeof useTypedDates>,
    "open" | "reason" | "statusId" | "statusQuiet"
  >;
}) {
  const status = typed.open
    ? typed.reason
    : half && `Início ${formatDate(half)}. Escolha o último dia.`;
  const showStatus = Boolean(status) && !typed.statusQuiet;
  const said = showStatus || clearable;
  return (
    <div
      className={cn(
        said || typed.open
          ? "flex min-h-ctl-sm shrink-0 items-center justify-between gap-2 pt-2"
          : "contents",
        said && "border-border border-t",
        HOLD_WIDTH
      )}
    >
      <p
        aria-live={typed.open ? undefined : "polite"}
        className={cn(
          "min-w-0 text-muted-foreground text-support",
          !showStatus && "sr-only"
        )}
        id={typed.statusId}
      >
        {status}
      </p>
      {clearable ? (
        <Button onClick={onClear} size="sm" variant="ghost">
          Limpar
        </Button>
      ) : null}
    </div>
  );
}

/** Brings the shortcut in use into the sideways row where the four do not fit, so the one marked is not off the edge. */
function useRevealPressed(
  group: RefObject<HTMLFieldSetElement | null>,
  pressed: RangePreset | null | undefined
) {
  useEffect(() => {
    const row = group.current;
    const button = row?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!(row && button) || row.scrollWidth <= row.clientWidth) {
      return;
    }
    const at = button.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    row.scrollLeft += at.left - box.left - (row.clientWidth - at.width) / 2;
  }, [group, pressed]);
}

/** With `only` every day is off; otherwise the days that would make a range longer than the span. */
function onlyDisabled(
  only: RangeOnly | undefined,
  span: RangeSpan | undefined,
  far: (day: Date) => boolean
): ((day: Date) => boolean) | undefined {
  if (only) {
    return () => true;
  }
  return span ? far : undefined;
}

/**
 * What a range editor shows inside a popover: the shortcuts the screen chose (`date-range-shortcuts.ts`) above the month
 * and "Limpar" below. The first touch on a day marks the start and keeps the editor open; the second closes the range and
 * hands it to `onCommit`, with the earlier day as the start, so an inverted range ("Até" before "De") cannot be made.
 * A shortcut hands its range over at once and "Limpar" hands over null. One month at a time at every width, the
 * shortcuts in a column beside it at 760 px and up and in a segmented row above it below. A half-chosen range lives in this
 * component, so closing the popover drops it and every opening begins with the range in `value`. The `DateRangePicker`
 * and the period editor of the filter bar share it.
 */
export function DateRangePanel({
  clearable = true,
  endsToday = false,
  onCommit,
  onHalfChange,
  only,
  pressed: pressedProp,
  shortcuts = DEFAULT_SHORTCUTS,
  span,
  statusId: statusIdProp,
  today: todayProp,
  value: valueProp,
}: {
  clearable?: boolean | undefined;
  /** The screen has no future days: "Este mês" ends today, not on the last day of the month. */
  endsToday?: boolean | undefined;
  /**
   * Called with the closed range, or null for "Limpar"; the caller closes the popover. Where the caller applies by a
   * button of its own it is also called with each typed range that is good, and with null when both fields are emptied.
   * A shortcut says which one it was.
   */
  onCommit: (range: DateRange | null, shortcut?: RangePreset) => void;
  /**
   * Called with whether the range cannot be applied yet: only the start is marked, or a typed date has an error. A
   * caller that applies by a button of its own waits; its presence also takes "Aplicar" out of the typed fields.
   */
  onHalfChange?: ((half: boolean) => void) | undefined;
  only?: RangeOnly | undefined;
  pressed?: RangePreset | null | undefined;
  shortcuts?: readonly RangePreset[] | undefined;
  span?: RangeSpan | undefined;
  /** The id of the line that says why the range cannot be applied (the last day, or the typed error), for a button that is off while it shows. */
  statusId?: string | undefined;
  today?: IsoDate | undefined;
  /** The range there is, both ends `AAAA-MM-DD`, or null. */
  value: DateRange | null;
}) {
  const value = validRange(valueProp);
  const [draft, setDraft] = useState<DraftRange | undefined>(
    value ?? undefined
  );
  const today = todayOr(todayProp);
  const todayDate = parseIsoDate(today) as Date;
  const pressed =
    pressedProp === undefined
      ? matchingPreset(value, today, shortcuts, endsToday)
      : pressedProp;
  const [month, setMonth] = useState(() =>
    firstMonth(value ?? undefined, todayDate)
  );
  const typed = useTypedDates({
    callerApplies: onHalfChange !== undefined,
    draft,
    onCommit,
    setDraft,
    setMonth: (next) => setMonth(firstMonth(next, todayDate)),
    span,
    statusId: statusIdProp,
    value,
  });
  const { adopt, commit } = typed;
  const shortcutRow = useRef<HTMLFieldSetElement>(null);
  useRevealPressed(shortcutRow, pressed);
  const far = useCallback(
    (day: Date) =>
      span !== undefined &&
      draft?.from !== undefined &&
      draft.to === undefined &&
      daysInRange(draft.from, toIsoDate(day)) > span.days,
    [draft, span]
  );

  const half = draft?.from && !draft.to ? draft.from : undefined;
  useEffect(() => {
    onHalfChange?.(Boolean(half) || typed.blocksCaller);
  }, [half, onHalfChange, typed.blocksCaller]);

  const pickDay = useCallback(
    (_range: unknown, day: Date) => {
      const next = nextRange(draft, toIsoDate(day));
      if (next.complete) {
        commit(next.range);
      } else {
        adopt(next.draft);
      }
    },
    [adopt, commit, draft]
  );

  const pickPreset = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const preset = event.currentTarget.dataset.preset as RangePreset;
      if (only && !only.shortcuts.includes(preset)) {
        return;
      }
      commit(shortcutRange(preset, today, endsToday), preset);
    },
    [commit, endsToday, only, today]
  );
  const onlyReasonId = useId();

  const clear = useCallback(() => commit(null), [commit]);

  const rangeLabel =
    draft?.from && draft.to
      ? formatRange({ from: draft.from, to: draft.to }, today)
      : half && `${formatDate(half)} a …`;
  const selected = {
    from: parseIsoDate(draft?.from),
    to: parseIsoDate(draft?.to),
  };

  return (
    <div className="contents md:flex md:min-h-0 md:gap-4">
      <fieldset
        aria-label="Atalhos do período"
        className={SHORTCUTS_CLASS}
        ref={shortcutRow}
      >
        {shortcutsOf(shortcuts).map((preset) => {
          const off =
            only !== undefined && !only.shortcuts.includes(preset.value);
          return (
            <button
              aria-describedby={off ? onlyReasonId : undefined}
              aria-disabled={off || undefined}
              aria-pressed={preset.value === pressed}
              className={cn(
                SHORTCUT_CLASS,
                off && "cursor-not-allowed text-muted-foreground opacity-60"
              )}
              data-preset={preset.value}
              key={preset.value}
              onClick={pickPreset}
              type="button"
            >
              {preset.label}
            </button>
          );
        })}
      </fieldset>
      <div className="contents md:flex md:min-h-0 md:min-w-0 md:flex-col md:gap-3">
        {/* with little room (the popover above the field at 360 px) only the month scrolls: the shortcuts, "Limpar"
          and the line that asks for the last day stay in view; the 4 px around keep the focus ring of a day. With the
          typed fields open the month keeps its six weeks and the whole panel scrolls instead (the popup, or the body
          of the Dialog), so no week is hidden in a box that scrolls on its own */}
        <div
          className={cn(
            "-m-1 p-1",
            typed.open ? "shrink-0" : "min-h-0 overflow-y-auto"
          )}
          data-range-month
        >
          <OnDemandCalendar
            autoFocus
            disabled={onlyDisabled(only, span, far)}
            disabledReason={only?.reason ?? span?.reason}
            mode="range"
            month={month}
            onMonthChange={setMonth}
            onSelect={pickDay}
            selected={selected}
            today={todayDate}
          />
        </div>
        {only ? (
          <p
            className={cn("text-muted-foreground text-support", HOLD_WIDTH)}
            id={onlyReasonId}
          >
            {only.reason}
          </p>
        ) : (
          <>
            <div ref={typed.anchor}>
              <DateRangeTyping
                {...typed.typingProps}
                label={rangeLabel || undefined}
              />
            </div>
            <DateRangeFooter
              clearable={clearable && Boolean(value || half)}
              half={half}
              onClear={clear}
              typed={typed}
            />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * A period in one field: the button writes "01/10 a 24/10" ("24/10/2026" for one day, "Escolher período" for none)
 * and opens the editor (`DateRangePanel`) in a Popover. Closing with only the start marked keeps the range there was.
 */
export function DateRangePicker({
  action,
  className,
  clearable,
  describedBy,
  disabled,
  endsToday,
  error,
  id,
  label,
  onValueChange,
  only,
  pressed,
  shortcuts,
  span,
  today: todayProp,
  value: valueProp,
}: DateRangePickerProps) {
  const value = validRange(valueProp);
  const [open, setOpen] = useState(false);
  const [openings, setOpenings] = useState(0);
  const errorId = useId();
  const today = todayOr(todayProp);
  // the accessible name holds the text the button shows (WCAG 2.5.3): "Período, 01/10 a 24/10"; with an action,
  // "Período: 01/10 a 24/10, editar"
  const text = value ? formatRange(value, today) : "Escolher período";

  const commit = useCallback(
    (range: DateRange | null, shortcut?: RangePreset) => {
      onValueChange(range, shortcut);
      setOpen(false);
    },
    [onValueChange]
  );

  // a popup reopened while it is still leaving keeps its panel mounted: a new key gives each opening a fresh draft and
  // its first month
  const handleOpenChange = useCallback((opening: boolean) => {
    if (opening) {
      setOpenings((count) => count + 1);
    }
    setOpen(opening);
  }, []);

  return (
    <div className={cn("grid gap-1.5", className)}>
      <Popover onOpenChange={handleOpenChange} open={open}>
        <PopoverTrigger
          render={
            <Button
              aria-describedby={
                [error ? errorId : null, describedBy]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
              aria-invalid={error ? true : undefined}
              aria-label={
                action ? `${label}: ${text}, ${action}` : `${label}, ${text}`
              }
              className="w-full justify-start font-normal sm:w-fit"
              disabled={disabled}
              id={id}
              onFocus={warmCalendar}
              onPointerEnter={warmCalendar}
              variant="outline"
            />
          }
        >
          <CalendarDaysIcon aria-hidden="true" data-icon="inline-start" />
          <span
            className={cn("tabular-nums", !value && "text-muted-foreground")}
          >
            {text}
          </span>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          aria-label={label}
          className="max-h-(--available-height) w-auto max-w-[calc(100vw-1rem)] gap-3 overflow-y-auto overflow-x-hidden p-2"
          initialFocus={false}
        >
          <DateRangePanel
            clearable={clearable}
            endsToday={endsToday}
            key={openings}
            onCommit={commit}
            only={only}
            pressed={pressed}
            shortcuts={shortcuts}
            span={span}
            today={today}
            value={value}
          />
        </PopoverContent>
      </Popover>
      <FieldError id={errorId}>{error}</FieldError>
    </div>
  );
}
