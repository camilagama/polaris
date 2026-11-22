import CalendarDaysIcon from "lucide-react/dist/esm/icons/calendar-days";
import {
  type MouseEvent,
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
  nextRange,
  parseIsoDate,
  type RangePreset,
  type RangeSpan,
  shortcutRange,
  todayOr,
  toIsoDate,
  validRange,
} from "@/ui/date-values";
import { DEFAULT_SHORTCUTS, shortcutsOf } from "@/ui/date-range-shortcuts";
import { FieldError } from "@/ui/field";
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
  /** Only these shortcuts can be chosen: the others and the days are off, and the reason is written. */
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

/** The first day alone, by the rule of the year of `formatRange`: no year when it falls in the year of `today`. */
function startDayText(from: IsoDate, today: IsoDate): string {
  const text = formatDate(from);
  return from.slice(0, 4) === today.slice(0, 4) ? text.slice(0, 5) : text;
}

const LONGEST_STATUS = "Início 31/12/2099. Escolha o último dia.";

/**
 * The line under the panel: "Limpar" and, once the first day is marked, the sentence that asks for the last one. The row
 * is always there, with the height of the longest sentence beside "Limpar" in its place (an invisible copy shares the
 * cell, so the wrapping is the same at any letter size), so the panel keeps one height from opening to the last day. The sentence stays in the tree
 * when there is nothing to say, so the screen reader hears it when it fills.
 */
export function DateRangeFooter({
  canClear,
  clearable,
  half,
  onClear,
  statusId,
  today,
}: {
  /** There is a range or a first day to clear: until then "Limpar" holds its place, out of sight and out of the tab order. */
  canClear: boolean;
  clearable: boolean;
  half: IsoDate | undefined;
  onClear: () => void;
  statusId: string | undefined;
  today: IsoDate;
}) {
  const status =
    half && `Início ${startDayText(half, today)}. Escolha o último dia.`;
  return (
    <div className={cn("shrink-0 border-border border-t pt-2", HOLD_WIDTH)}>
      <div className="flex min-h-ctl-sm items-center justify-between gap-2">
        <div className="grid min-w-0 text-muted-foreground text-support">
          <p
            aria-live="polite"
            className={cn("col-start-1 row-start-1", !status && "sr-only")}
            id={statusId}
          >
            {status}
          </p>
          <span
            aria-hidden="true"
            className="invisible col-start-1 row-start-1"
          >
            {LONGEST_STATUS}
          </span>
        </div>
        {clearable ? (
          <Button
            className={cn(!canClear && "invisible")}
            onClick={onClear}
            size="sm"
            variant="ghost"
          >
            Limpar
          </Button>
        ) : null}
      </div>
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
   * Called with the closed range, or null for "Limpar"; the caller closes the popover. A shortcut says which one it was.
   */
  onCommit: (range: DateRange | null, shortcut?: RangePreset) => void;
  /**
   * Called with whether the range cannot be applied yet: only the start is marked. A caller that applies by a button of
   * its own waits.
   */
  onHalfChange?: ((half: boolean) => void) | undefined;
  only?: RangeOnly | undefined;
  pressed?: RangePreset | null | undefined;
  shortcuts?: readonly RangePreset[] | undefined;
  span?: RangeSpan | undefined;
  /** The id of the line that asks for the last day, for a button that is off while it shows. */
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
  const ownStatusId = useId();
  const statusId = statusIdProp ?? ownStatusId;
  const commit = useCallback(
    (range: DateRange | null, shortcut?: RangePreset) => {
      setDraft(range ?? undefined);
      onCommit(range, shortcut);
    },
    [onCommit]
  );
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
    onHalfChange?.(Boolean(half));
  }, [half, onHalfChange]);

  const pickDay = useCallback(
    (_range: unknown, day: Date) => {
      if (only) {
        return;
      }
      const next = nextRange(draft, toIsoDate(day));
      if (next.complete) {
        commit(next.range);
      } else {
        setDraft(next.draft);
      }
    },
    [commit, draft, only]
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
          and the line that asks for the last day stay in view; the 4 px around keep the focus ring of a day */}
        <div className="-m-1 min-h-0 overflow-y-auto p-1" data-range-month>
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
          <DateRangeFooter
            canClear={Boolean(value || half)}
            clearable={clearable}
            half={half}
            onClear={clear}
            statusId={statusId}
            today={today}
          />
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
