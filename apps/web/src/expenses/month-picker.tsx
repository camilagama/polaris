import ChevronLeftIcon from "lucide-react/dist/esm/icons/chevron-left";
import ChevronRightIcon from "lucide-react/dist/esm/icons/chevron-right";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { ButtonGroup } from "@/ui/button-group";
import { Field, FieldLabel } from "@/ui/field";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import {
  EARLIEST_EXPENSE_MONTH,
  formatMonthLabel,
  moveMonthCursor,
  shiftMonth,
} from "./expense-model";

/* The month picker of Despesas (v5.1): "‹ Outubro de 2026 ›" glued in one ButtonGroup.
   The month in the middle opens a Popover with the year ("‹ 2026 ›") over a grid of 3 x 4 months and, in the footer,
   "Este mês" (the store's current month, like the "Hoje" of the DatePicker); a touch or a click on a month chooses it
   and closes. The month is written by the screen, never by the browser's locale, so there is no native month field
   and no fallback for the browsers that lack one. The phone uses the same Popover; the full-screen Dialog comes with
   t331. The grid goes back to January 2000 (the same floor as the Data de competência) and forward to any year: the
   list of the expenses reads any month, future ones included. The arrows beside the month keep reaching every month
   from 0000-01 to 9999-12, as before. */

const MONTH_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
const FIRST_YEAR = Number(EARLIEST_EXPENSE_MONTH.slice(0, 4));
const LAST_YEAR = 9999;

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

function yearText(year: number): string {
  return String(year).padStart(4, "0");
}

function monthOf(year: number, month: number): string {
  return `${yearText(year)}-${twoDigits(month)}`;
}

function parts(month: string): { month: number; year: number } {
  return { month: Number(month.slice(5, 7)), year: Number(month.slice(0, 4)) };
}

interface MonthCellProps {
  cursor: boolean;
  month: string;
  onChoose: (month: string) => void;
  selected: boolean;
}

/** One month of the grid: pressed when it is the one on screen; only the cursor is in the tab order. */
function MonthCell({ cursor, month, onChoose, selected }: MonthCellProps) {
  const choose = useCallback(() => onChoose(month), [month, onChoose]);
  const words = formatMonthLabel(month);
  const short = capitalized(words.slice(0, 3));
  return (
    <button
      // the name starts with the text the cell shows ("Jan, janeiro de 2026"): the name holds the visible text (WCAG 2.5.3)
      aria-label={`${short}, ${words}`}
      aria-pressed={selected}
      className="touch-hit focus-ring relative inline-flex h-ctl-md touch:h-11 items-center justify-center rounded-md border border-transparent font-medium text-sm motion-full:transition-[background-color,color] hover:bg-muted aria-pressed:bg-primary aria-pressed:text-primary-foreground"
      data-month={month}
      onClick={choose}
      tabIndex={cursor ? 0 : -1}
      type="button"
    >
      {short}
    </button>
  );
}

interface MonthGridProps {
  /** The store's current month, YYYY-MM. */
  currentMonth: string;
  month: string;
  onChoose: (month: string) => void;
}

/**
 * The year with its arrows over the twelve months. The arrow keys move the cursor in the grid (past January or
 * December it goes to the next or the previous year), Home and End go to the year's first and last month, PageUp and
 * PageDown to the same month of another year (none goes back past January 2000); Enter and Space choose, as on any
 * button. "Este mês" in the footer chooses the store's current month.
 */
function MonthGrid({ currentMonth, month, onChoose }: MonthGridProps) {
  const [cursor, setCursor] = useState(month);
  const grid = useRef<HTMLFieldSetElement>(null);
  // the grid is only mounted while the popover is open: the focus goes to the month on screen as it opens
  const focusCursor = useRef<boolean>(true);
  const { year } = parts(cursor);

  // after a key moved the cursor the new button is on screen (the year may have changed): the focus follows it
  // (the ref is set again on every key, and starts set for the opening)
  useEffect(() => {
    if (focusCursor.current) {
      focusCursor.current = false;
      grid.current
        ?.querySelector<HTMLElement>(`[data-month="${cursor}"]`)
        ?.focus();
    }
  }, [cursor]);

  const handleKey = useCallback(
    (event: KeyboardEvent<HTMLFieldSetElement>) => {
      const target = moveMonthCursor(cursor, event.key);
      if (target === null) {
        return;
      }
      event.preventDefault();
      focusCursor.current = true;
      setCursor(target);
    },
    [cursor]
  );
  // the arrows of the year are PageUp and PageDown: the same floor, the same edge
  const handlePreviousYear = useCallback(
    () => setCursor((current) => moveMonthCursor(current, "PageUp") ?? current),
    []
  );
  const handleNextYear = useCallback(
    () =>
      setCursor((current) => moveMonthCursor(current, "PageDown") ?? current),
    []
  );
  const handleCurrentMonth = useCallback(
    () => onChoose(currentMonth),
    [currentMonth, onChoose]
  );

  // gap-2.5: the 48 px touch area of an arrow (32 px + 8 above and below) and the one of a month (44 px + 2) end at the
  // same line, not one over the other
  return (
    <div className="grid gap-2.5">
      <div className="flex items-center justify-between gap-2">
        <Button
          aria-label="Ano anterior"
          aria-disabled={year <= FIRST_YEAR ? true : undefined}
          onClick={handlePreviousYear}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <ChevronLeftIcon aria-hidden="true" />
        </Button>
        <span
          aria-live="polite"
          className="font-medium tabular-nums"
          data-slot="month-picker-year"
        >
          {yearText(year)}
        </span>
        <Button
          aria-label="Próximo ano"
          aria-disabled={year >= LAST_YEAR ? true : undefined}
          onClick={handleNextYear}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <ChevronRightIcon aria-hidden="true" />
        </Button>
      </div>
      {/* the keys are the arrows of the buttons inside: the group only listens (they bubble up to it) */}
      {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: key handling of the focusable buttons inside */}
      <fieldset
        aria-label={`Meses de ${yearText(year)}`}
        className="m-0 grid min-w-0 grid-cols-3 gap-1 border-0 p-0"
        onKeyDown={handleKey}
        ref={grid}
      >
        {MONTH_NUMBERS.map((number) => {
          const value = monthOf(year, number);
          return (
            <MonthCell
              cursor={value === cursor}
              key={value}
              month={value}
              onChoose={onChoose}
              selected={value === month}
            />
          );
        })}
      </fieldset>
      <div className="flex justify-end border-border border-t pt-2">
        <Button
          onClick={handleCurrentMonth}
          size="sm"
          type="button"
          variant="ghost"
        >
          Este mês
        </Button>
      </div>
    </div>
  );
}

interface MonthPickerProps {
  className?: string | undefined;
  /** The store's current month, YYYY-MM: what "Este mês" chooses. */
  currentMonth: string;
  id: string;
  label: string;
  /** YYYY-MM */
  month: string;
  onChange: (month: string) => void;
}

export function MonthPicker({
  className,
  currentMonth,
  id,
  label,
  month,
  onChange,
}: MonthPickerProps) {
  const [open, setOpen] = useState(false);
  const previous = shiftMonth(month, -1);
  const next = shiftMonth(month, 1);
  const labelId = `${id}-label`;
  const text = capitalized(formatMonthLabel(month));

  const handlePrevious = useCallback(() => {
    if (previous) {
      onChange(previous);
    }
  }, [onChange, previous]);
  const handleNext = useCallback(() => {
    if (next) {
      onChange(next);
    }
  }, [next, onChange]);
  const choose = useCallback(
    (chosen: string) => {
      setOpen(false);
      if (chosen !== month) {
        onChange(chosen);
      }
    },
    [month, onChange]
  );

  return (
    <Field className={cn("w-auto min-w-0", className)}>
      <FieldLabel id={labelId}>{label}</FieldLabel>
      <ButtonGroup aria-labelledby={labelId}>
        <Button
          aria-label="Mês anterior"
          disabled={previous === null}
          onClick={handlePrevious}
          size="icon"
          type="button"
          variant="outline"
        >
          <ChevronLeftIcon aria-hidden="true" />
        </Button>
        <Popover onOpenChange={setOpen} open={open}>
          {/* the accessible name holds the text the button shows (WCAG 2.5.3): "Mês de competência, Outubro de 2026" */}
          <PopoverTrigger
            render={
              <Button
                aria-label={`${label}, ${text}`}
                className="min-w-40 flex-1 bg-card shadow-xs dark:bg-secondary/60"
                id={id}
                type="button"
                variant="outline"
              />
            }
          >
            {text}
          </PopoverTrigger>
          <PopoverContent
            align="center"
            aria-label={label}
            className="w-72 gap-2 p-2"
            initialFocus={false}
          >
            <MonthGrid
              currentMonth={currentMonth}
              month={month}
              onChoose={choose}
            />
          </PopoverContent>
        </Popover>
        <Button
          aria-label="Próximo mês"
          disabled={next === null}
          onClick={handleNext}
          size="icon"
          type="button"
          variant="outline"
        >
          <ChevronRightIcon aria-hidden="true" />
        </Button>
      </ButtonGroup>
    </Field>
  );
}
