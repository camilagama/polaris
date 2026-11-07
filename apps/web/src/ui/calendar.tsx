import { format } from "date-fns";
import ChevronLeftIcon from "lucide-react/dist/esm/icons/chevron-left";
import ChevronRightIcon from "lucide-react/dist/esm/icons/chevron-right";
import { createContext, useContext, useEffect, useId, useRef } from "react";
import {
  type ChevronProps,
  DateLib,
  type DateLibOptions,
  type DayButtonProps,
  DayPicker,
  type DayPickerProps,
  getDefaultClassNames,
  type Modifiers,
} from "react-day-picker";
import { ptBR } from "react-day-picker/locale/pt-BR";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/ui/button";

/**
 * The month grid of the date pickers: the shadcn `calendar` (base-nova) over react-day-picker 10, with the Polaris
 * tokens and rules. Days are 36 px with a mouse and 44 px with touch (shrinking below 360 px so the week fits at
 * 320), the cell itself is the touch area (days touch each other and never overlap), focus is the 3 px outline of
 * the other controls, the arrows move the focus between days (DayPicker's own
 * keyboard grid), the text is Brazilian Portuguese. A day outside the allowed ones is `aria-disabled` and says why
 * through `aria-describedby` (the project's rule for a disabled control with a reason), so a screen reader that
 * reaches it hears the reason instead of a silent dimmed number.
 *
 * Heavy (it brings react-day-picker and date-fns): screens never import it. They use the pickers, which load it
 * on demand through `calendar-on-demand.tsx`; a guard of `pwa/precache-budget.ts` fails the build otherwise.
 */
export type CalendarProps = DayPickerProps & {
  /** Why the disabled days cannot be chosen ("Só até hoje"); read by the screen reader on each one. */
  disabledReason?: string | undefined;
};

const ReasonContext = createContext<string | undefined>(undefined);

function CalendarChevron({ className, orientation }: ChevronProps) {
  const Icon = orientation === "left" ? ChevronLeftIcon : ChevronRightIcon;
  return <Icon aria-hidden="true" className={cn("size-4", className)} />;
}

function CalendarDayButton({
  className,
  day,
  disabled,
  modifiers,
  ...props
}: DayButtonProps) {
  const reasonId = useContext(ReasonContext);
  const ref = useRef<HTMLButtonElement>(null);
  // the arrows move DayPicker's focused day; the button follows it (as DayPicker's own DayButton does)
  useEffect(() => {
    if (modifiers.focused) {
      ref.current?.focus();
    }
  }, [modifiers.focused]);
  // DayPicker sets `disabled` on a disabled day (dropped above): it becomes aria-disabled with its reason, and
  // DayPicker already ignores the click on it.
  const off = Boolean(modifiers.disabled);
  const single =
    modifiers.selected &&
    !modifiers.range_start &&
    !modifiers.range_end &&
    !modifiers.range_middle;
  return (
    <button
      {...props}
      aria-describedby={off ? reasonId : undefined}
      aria-disabled={off || undefined}
      className={cn(
        buttonVariants({ size: "icon", variant: "ghost" }),
        // the cell is the target: with `touch-hit` its area would reach 2 px into each neighbour; `!` because the
        // pseudo-element of `touch-hit` sets its own `content`
        "size-(--cell-size) font-normal tabular-nums before:content-none!",
        "data-[today=true]:font-semibold data-[today=true]:underline data-[today=true]:decoration-2 data-[today=true]:underline-offset-4",
        "data-[outside=true]:bg-transparent! data-[outside=true]:text-muted-foreground! data-[outside=true]:hover:bg-accent!",
        "data-[range-middle=true]:rounded-none data-[range-middle=true]:bg-transparent data-[range-middle=true]:text-foreground",
        "data-[selected-single=true]:bg-primary data-[selected-single=true]:text-primary-foreground data-[selected-single=true]:hover:bg-primary/88",
        "data-[range-end=true]:bg-primary data-[range-start=true]:bg-primary data-[range-end=true]:text-primary-foreground data-[range-start=true]:text-primary-foreground data-[range-end=true]:hover:bg-primary/88 data-[range-start=true]:hover:bg-primary/88",
        "aria-disabled:line-through aria-disabled:opacity-40",
        className
      )}
      data-day={day.isoDate}
      data-outside={day.outside || undefined}
      data-range-end={modifiers.range_end || undefined}
      data-range-middle={modifiers.range_middle || undefined}
      data-range-start={modifiers.range_start || undefined}
      data-selected-single={single || undefined}
      data-today={modifiers.today || undefined}
      ref={ref}
    />
  );
}

/** "Outubro de 2026": the caption of a month. */
function formatCaption(month: Date) {
  const text = format(month, "LLLL 'de' yyyy", { locale: ptBR });
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** "D S T Q Q S S" on screen, the full name of the weekday for the screen reader (DayPicker's `aria-label`). */
function formatWeekdayName(weekday: Date) {
  return format(weekday, "cccccc", { locale: ptBR }).charAt(0).toUpperCase();
}

/** "início do período", "fim do período" or both; nothing for a day in the middle or for a single-day picker. */
function rangeRole(mode: DayPickerProps["mode"], modifiers: Modifiers) {
  if (mode !== "range" || !modifiers.selected) {
    return null;
  }
  const start = Boolean(modifiers.range_start);
  const end = Boolean(modifiers.range_end);
  if (start && end) {
    return "início e fim do período";
  }
  if (start) {
    return "início do período";
  }
  if (end) {
    return "fim do período";
  }
  // `range_start` and `range_end` need both ends: a day selected with no range modifier is the lone start
  return modifiers.range_middle ? null : "início do período";
}

/** "{Hoje, }{weekday}, {d de mês de ano}{, role in the period}{, selecionado}": the role comes before the state. */
function makeLabelDayButton(mode: DayPickerProps["mode"]) {
  return (
    date: Date,
    modifiers: Modifiers,
    options?: DateLibOptions,
    dateLib?: DateLib
  ) => {
    const lib = dateLib ?? new DateLib(options);
    const parts = [lib.format(date, "PPPP")];
    if (modifiers.today) {
      parts.unshift("Hoje");
    }
    const role = rangeRole(mode, modifiers);
    if (role) {
      parts.push(role);
    }
    if (modifiers.selected) {
      parts.push("selecionado");
    }
    return parts.join(", ");
  };
}

export function Calendar({
  className,
  classNames,
  components,
  disabledReason,
  formatters,
  labels,
  fixedWeeks = true,
  showOutsideDays = true,
  ...props
}: CalendarProps) {
  const defaults = getDefaultClassNames();
  const reasonId = useId();
  return (
    <ReasonContext.Provider value={disabledReason ? reasonId : undefined}>
      <DayPicker
        className={cn(
          "w-fit bg-transparent [--cell-size:2.25rem] touch:[--cell-size:min(2.75rem,calc((100vw_-_3rem)/7))]",
          className
        )}
        classNames={{
          button_next: cn(
            buttonVariants({ size: "icon", variant: "ghost" }),
            "size-(--cell-size) p-0 aria-disabled:opacity-40",
            defaults.button_next
          ),
          button_previous: cn(
            buttonVariants({ size: "icon", variant: "ghost" }),
            "size-(--cell-size) p-0 aria-disabled:opacity-40",
            defaults.button_previous
          ),
          caption_label: cn(
            "select-none font-medium text-sm",
            defaults.caption_label
          ),
          day: cn("relative p-0 text-center", defaults.day),
          hidden: cn("invisible", defaults.hidden),
          month: cn("flex w-full flex-col gap-3", defaults.month),
          month_caption: cn(
            "flex h-(--cell-size) w-full items-center justify-center px-(--cell-size)",
            defaults.month_caption
          ),
          month_grid: cn("w-full border-collapse", defaults.month_grid),
          months: cn(
            "relative flex flex-col gap-4 xl:flex-row",
            defaults.months
          ),
          nav: cn(
            "absolute inset-x-0 top-0 flex w-full items-center justify-between gap-1",
            defaults.nav
          ),
          // a day of the month before or after is never drawn as chosen: the range shows in its own month
          outside: cn("bg-transparent!", defaults.outside),
          range_end: cn("rounded-r-md bg-accent", defaults.range_end),
          range_middle: cn("bg-accent", defaults.range_middle),
          range_start: cn("rounded-l-md bg-accent", defaults.range_start),
          root: cn("w-fit", defaults.root),
          week: cn("mt-1 flex w-full", defaults.week),
          weekday: cn(
            "w-(--cell-size) select-none font-normal text-muted-foreground text-xs",
            defaults.weekday
          ),
          weekdays: cn("flex", defaults.weekdays),
          ...classNames,
        }}
        components={{
          Chevron: CalendarChevron,
          DayButton: CalendarDayButton,
          ...components,
        }}
        data-slot="calendar"
        // six weeks always: the popover keeps its height from month to month
        fixedWeeks={fixedWeeks}
        formatters={{ formatCaption, formatWeekdayName, ...formatters }}
        labels={{
          labelDayButton: makeLabelDayButton(props.mode),
          labelNext: () => "Próximo mês",
          labelPrevious: () => "Mês anterior",
          ...labels,
        }}
        locale={ptBR}
        showOutsideDays={showOutsideDays}
        {...props}
      />
      {disabledReason ? (
        <span className="sr-only" id={reasonId}>
          {disabledReason}
        </span>
      ) : null}
    </ReasonContext.Provider>
  );
}
