import CalendarDaysIcon from "lucide-react/dist/esm/icons/calendar-days";
import { useCallback, useId, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { OnDemandCalendar, warmCalendar } from "@/ui/calendar-on-demand";
import {
  formatDate,
  type IsoDate,
  clampDay,
  isWithin,
  parseIsoDate,
  toIsoDate,
  todayOr,
  validDay,
} from "@/ui/date-values";
import { FieldError } from "@/ui/field";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";

/** The error of a date that must be chosen (never "campo obrigatório"). */
const DATE_REQUIRED_ERROR = "Escolha uma data";

/**
 * The limits of a date and the reason for them: a field that disables days (`min` or `max`) must say why, so the
 * disabled day is never mute for the screen reader.
 */
export type DateLimits =
  | {
      min?: undefined;
      max?: undefined;
      /** Why the days outside `min`..`max` cannot be chosen ("Só até hoje"). */
      disabledReason?: string | undefined;
    }
  | {
      /** The first day that can be chosen, `AAAA-MM-DD`. */
      min?: IsoDate | undefined;
      /** The last day that can be chosen, `AAAA-MM-DD`. */
      max?: IsoDate | undefined;
      /** Why the days outside `min`..`max` cannot be chosen ("Só até hoje"). */
      disabledReason: string;
    };

export type DatePickerProps = DateLimits & {
  className?: string | undefined;
  disabled?: boolean | undefined;
  /** The id of a help text the screen shows under the button, read after the error. */
  describedBy?: string | undefined;
  /** The error under the button; `true` is the default text, "Escolha uma data". */
  error?: boolean | string | undefined;
  id?: string | undefined;
  /** The name of the field, in the accessible name of the button: "Data de competência, 24/10/2026". */
  label: string;
  onValueChange: (value: IsoDate | null) => void;
  /** The store's day (the screen takes it from the server); the device's day when absent. */
  today?: IsoDate | undefined;
  /** The chosen day, `AAAA-MM-DD`, or null. */
  value: IsoDate | null;
};

/**
 * One date: an outline button with the calendar icon and the date written "24/10/2026" ("Escolher data" when there
 * is none) opens the month in a Popover, with "Hoje" in its footer. A touch on a day chooses it and closes. In this
 * first version the phone uses the same Popover; the full-screen Dialog comes later.
 */
export function DatePicker({
  className,
  describedBy,
  disabled,
  disabledReason,
  error,
  id,
  label,
  max,
  min,
  onValueChange,
  today: todayProp,
  value: valueProp,
}: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const [openings, setOpenings] = useState(0);
  const errorId = useId();
  const today = todayOr(todayProp);
  const value = validDay(valueProp);
  const selected = parseIsoDate(value);
  // the accessible name holds the text the button shows (WCAG 2.5.3): "Data de competência, 24/10/2026"
  const text = value ? formatDate(value) : "Escolher data";
  const todayDate = parseIsoDate(today) as Date;
  // the month that opens: the chosen day's, or today's brought inside the allowed days
  const firstMonth =
    selected ?? parseIsoDate(clampDay(today, min, max)) ?? todayDate;
  const errorText = error === true ? DATE_REQUIRED_ERROR : error || undefined;
  const todayAllowed = isWithin(today, min, max);
  const outside = [
    ...(min ? [{ before: parseIsoDate(min) as Date }] : []),
    ...(max ? [{ after: parseIsoDate(max) as Date }] : []),
  ];

  // a popup reopened while it is still leaving keeps its calendar mounted: a new key gives each opening its first month
  const handleOpenChange = useCallback((opening: boolean) => {
    if (opening) {
      setOpenings((count) => count + 1);
    }
    setOpen(opening);
  }, []);
  const choose = useCallback(
    (day: IsoDate) => {
      onValueChange(day);
      setOpen(false);
    },
    [onValueChange]
  );
  const pickDay = useCallback(
    (_selected: Date | undefined, day: Date) => choose(toIsoDate(day)),
    [choose]
  );
  const pickToday = useCallback(() => {
    if (todayAllowed) {
      choose(today);
    }
  }, [choose, today, todayAllowed]);

  return (
    <div className={cn("grid gap-1.5", className)}>
      <Popover onOpenChange={handleOpenChange} open={open}>
        <PopoverTrigger
          render={
            <Button
              aria-describedby={
                [errorText ? errorId : null, describedBy]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
              aria-invalid={errorText ? true : undefined}
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
          className="max-h-(--available-height) w-auto max-w-[calc(100vw-1rem)] gap-2 overflow-hidden p-2"
          initialFocus={false}
        >
          {/* with little room (the popover above the field at 360 x 600) only the month scrolls: "Hoje" stays in view
              (the popover itself does not scroll); the 4 px around keep the focus ring of a day */}
          <div className="-m-1 min-h-0 overflow-y-auto p-1" data-date-month>
            <OnDemandCalendar
              autoFocus
              defaultMonth={firstMonth}
              disabled={outside}
              disabledReason={disabledReason}
              key={openings}
              mode="single"
              onSelect={pickDay}
              selected={selected}
              today={todayDate}
            />
          </div>
          <TodayFooter
            allowed={todayAllowed}
            onPickToday={pickToday}
            reason={disabledReason}
          />
        </PopoverContent>
      </Popover>
      <FieldError id={errorId}>{errorText}</FieldError>
    </div>
  );
}

/**
 * The footer of the popover: "Hoje" and, when today is outside the allowed days, the reason written beside it in
 * the small secondary text of the calendar's own reason line, tied to the button by `aria-describedby`. The button
 * stays focusable (`aria-disabled`, never `disabled`) and chooses nothing.
 */
export function TodayFooter({
  allowed,
  onPickToday,
  reason,
}: {
  allowed: boolean;
  onPickToday: () => void;
  reason?: string | undefined;
}) {
  const reasonId = useId();
  return (
    <div
      className="flex shrink-0 items-center justify-end gap-2 border-border border-t pt-2"
      data-date-footer
    >
      {allowed || !reason ? null : (
        <p
          className="min-w-0 flex-1 text-muted-foreground text-support"
          id={reasonId}
        >
          {reason}
        </p>
      )}
      <Button
        aria-describedby={allowed || !reason ? undefined : reasonId}
        aria-disabled={allowed ? undefined : true}
        className="shrink-0"
        onClick={onPickToday}
        size="sm"
        variant="ghost"
      >
        Hoje
      </Button>
    </div>
  );
}
