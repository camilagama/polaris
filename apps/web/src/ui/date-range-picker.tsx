import CalendarDaysIcon from "lucide-react/dist/esm/icons/calendar-days";
import {
  type MouseEvent,
  useCallback,
  useEffect,
  useId,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { OnDemandCalendar, warmCalendar } from "@/ui/calendar-on-demand";
import {
  type DateRange,
  type DraftRange,
  formatDate,
  formatRange,
  type IsoDate,
  matchingPreset,
  nextRange,
  parseIsoDate,
  presetRange,
  RANGE_PRESETS,
  type RangePreset,
  toIsoDate,
  todayOr,
  validRange,
} from "@/ui/date-values";
import { FieldError } from "@/ui/field";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";

export interface DateRangePickerProps {
  className?: string | undefined;
  /** The id of a help text the screen shows under the button, read after the error. */
  describedBy?: string | undefined;
  disabled?: boolean | undefined;
  /** The error under the button (the screen's text). */
  error?: string | undefined;
  id?: string | undefined;
  /** The name of the field, in the accessible name of the button: "Período, 01/10 a 24/10". */
  label: string;
  onValueChange: (value: DateRange | null) => void;
  /** The store's day (the screen takes it from the server); the device's day when absent. */
  today?: IsoDate | undefined;
  /** The chosen range, both ends `AAAA-MM-DD`, or null. */
  value: DateRange | null;
}

/** From 1280 px the calendar shows two months side by side (`xl`, the same width as the `xl:flex-row` of the months). */
const TWO_MONTHS = "(min-width: 1280px)";

function useTwoMonths(): boolean {
  const [wide, setWide] = useState(
    () => typeof window !== "undefined" && window.matchMedia(TWO_MONTHS).matches
  );
  useEffect(() => {
    const query = window.matchMedia(TWO_MONTHS);
    const update = () => setWide(query.matches);
    query.addEventListener("change", update);
    update();
    return () => query.removeEventListener("change", update);
  }, []);
  return wide;
}

/** The first month shown: the start of the range; with two months, the month before the end when that fits it all. */
function firstMonth(range: DraftRange | undefined, today: Date, two: boolean) {
  const from = parseIsoDate(range?.from);
  if (!two) {
    return from ?? today;
  }
  const end = parseIsoDate(range?.to) ?? from ?? today;
  const previous = new Date(end.getFullYear(), end.getMonth() - 1, 1, 12);
  return from && from < previous ? from : previous;
}

/**
 * A period in one field: the button writes "01/10 a 24/10" ("24/10/2026" for one day, "Escolher período" for none)
 * and opens the month in a Popover, with the shortcuts above it (Hoje · 7 dias · Este mês · Mês passado) and
 * "Limpar" below. The first touch on a day marks the start and keeps the popover open; the second closes the range
 * and hands it over, with the earlier day as the start, so an inverted range ("Até" before "De") cannot be made.
 * Closing with only the start marked keeps the range there was. Two months side by side from 1280 px, one below.
 */
export function DateRangePicker({
  className,
  describedBy,
  disabled,
  error,
  id,
  label,
  onValueChange,
  today: todayProp,
  value: valueProp,
}: DateRangePickerProps) {
  const value = validRange(valueProp);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DraftRange | undefined>(
    value ?? undefined
  );
  const errorId = useId();
  const two = useTwoMonths();
  const today = todayOr(todayProp);
  const todayDate = parseIsoDate(today) as Date;
  const pressed = matchingPreset(value, today);
  // the accessible name holds the text the button shows (WCAG 2.5.3): "Período, 01/10 a 24/10"
  const text = value ? formatRange(value, today) : "Escolher período";

  const openChange = useCallback(
    (next: boolean) => {
      // every opening starts from the range there is; a half-chosen one is dropped on closing
      setDraft(value ?? undefined);
      setOpen(next);
    },
    [value]
  );

  const commit = useCallback(
    (range: DateRange | null) => {
      onValueChange(range);
      setDraft(range ?? undefined);
      setOpen(false);
    },
    [onValueChange]
  );

  const pickDay = useCallback(
    (_range: unknown, day: Date) => {
      const next = nextRange(draft, toIsoDate(day));
      if (next.complete) {
        commit(next.range);
      } else {
        setDraft(next.draft);
      }
    },
    [commit, draft]
  );

  const pickPreset = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const preset = event.currentTarget.dataset.preset as RangePreset;
      commit(presetRange(preset, today));
    },
    [commit, today]
  );

  const clear = useCallback(() => commit(null), [commit]);

  const selected = {
    from: parseIsoDate(draft?.from),
    to: parseIsoDate(draft?.to),
  };
  const half = draft?.from && !draft.to ? draft.from : undefined;

  return (
    <div className={cn("grid gap-1.5", className)}>
      <Popover onOpenChange={openChange} open={open}>
        <PopoverTrigger
          render={
            <Button
              aria-describedby={
                [error ? errorId : null, describedBy]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
              aria-invalid={error ? true : undefined}
              aria-label={`${label}, ${text}`}
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
          className="max-h-(--available-height) w-auto max-w-[calc(100vw-1rem)] gap-3 overflow-y-auto p-2"
          initialFocus={false}
        >
          {/* 16 px down to the month: the 48 px areas of the shortcuts and of the month arrows stay apart at 320 px */}
          <fieldset
            aria-label="Atalhos do período"
            className="m-0 mb-1 flex min-w-0 rounded-md border-0 p-0 shadow-xs"
          >
            {RANGE_PRESETS.map((preset) => (
              <button
                aria-pressed={preset.value === pressed}
                className="touch-hit focus-ring not-first:-ml-px inline-flex h-ctl-sm min-w-fit flex-auto items-center justify-center whitespace-nowrap border border-border bg-card px-2 font-medium text-foreground text-xs transition-colors first:rounded-l-md last:rounded-r-md hover:bg-accent aria-pressed:bg-accent aria-pressed:text-accent-foreground dark:bg-secondary/60"
                data-preset={preset.value}
                key={preset.value}
                onClick={pickPreset}
                type="button"
              >
                {preset.label}
              </button>
            ))}
          </fieldset>
          <OnDemandCalendar
            autoFocus
            defaultMonth={firstMonth(draft, todayDate, two)}
            mode="range"
            numberOfMonths={two ? 2 : 1}
            onSelect={pickDay}
            selected={selected}
            // with two months a day of the neighbour would show twice, once in each
            showOutsideDays={!two}
            today={todayDate}
          />
          <div className="flex min-h-ctl-sm items-center justify-between gap-2 border-border border-t pt-2">
            <p
              aria-live="polite"
              className="text-muted-foreground text-support"
            >
              {half
                ? `Início ${formatDate(half)}. Escolha o último dia.`
                : null}
            </p>
            {value || half ? (
              <Button onClick={clear} size="sm" variant="ghost">
                Limpar
              </Button>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>
      <FieldError id={errorId}>{error}</FieldError>
    </div>
  );
}
