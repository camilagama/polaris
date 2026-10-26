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

export interface DatePickerProps {
  className?: string | undefined;
  disabled?: boolean | undefined;
  /** Why the days outside `min`..`max` cannot be chosen ("Só até hoje"). */
  disabledReason?: string | undefined;
  /** The id of a help text the screen shows under the button, read after the error. */
  describedBy?: string | undefined;
  /** The error under the button; `true` is the default text, "Escolha uma data". */
  error?: boolean | string | undefined;
  id?: string | undefined;
  /** The name of the field, in the accessible name of the button: "Data de competência, 24/10/2026". */
  label: string;
  /** The last day that can be chosen, `AAAA-MM-DD`. */
  max?: IsoDate | undefined;
  /** The first day that can be chosen, `AAAA-MM-DD`. */
  min?: IsoDate | undefined;
  onValueChange: (value: IsoDate | null) => void;
  /** The store's day (the screen takes it from the server); the device's day when absent. */
  today?: IsoDate | undefined;
  /** The chosen day, `AAAA-MM-DD`, or null. */
  value: IsoDate | null;
}

/**
 * One date: an outline button with the calendar icon and the date written "24/10/2026" ("Escolher data" when there
 * is none) opens the month in a Popover, with "Hoje" in its footer. A touch on a day chooses it and closes. In this
 * first version the phone uses the same Popover; the full-screen Dialog comes with t331.
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
  const todayReasonId = useId();
  const todayReason = disabledReason ?? "Hoje está fora das datas permitidas";

  return (
    <div className={cn("grid gap-1.5", className)}>
      <Popover onOpenChange={setOpen} open={open}>
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
              mode="single"
              onSelect={pickDay}
              selected={selected}
              today={todayDate}
            />
          </div>
          <div className="flex shrink-0 justify-end border-border border-t pt-2">
            <Button
              aria-describedby={todayAllowed ? undefined : todayReasonId}
              aria-disabled={todayAllowed ? undefined : true}
              onClick={pickToday}
              size="sm"
              variant="ghost"
            >
              Hoje
            </Button>
            {todayAllowed ? null : (
              <span className="sr-only" id={todayReasonId}>
                {todayReason}
              </span>
            )}
          </div>
        </PopoverContent>
      </Popover>
      <FieldError id={errorId}>{errorText}</FieldError>
    </div>
  );
}
