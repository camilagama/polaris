import ChevronLeftIcon from "lucide-react/dist/esm/icons/chevron-left";
import ChevronRightIcon from "lucide-react/dist/esm/icons/chevron-right";
import { useCallback } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { ButtonGroup } from "@/ui/button-group";
import { DateRangePicker } from "@/ui/date-range-picker";
import type { DateRange, IsoDate, RangePreset } from "@/ui/date-values";
import {
  MAX_PERIOD_DAYS,
  monthStep,
  type Period,
  type PeriodPreset,
  PRESET_SHORTCUTS,
  periodText,
  presetOfShortcut,
  rangeMessage,
  rangeProblem,
  wholeMonthOf,
} from "./result-period";

interface PeriodPickerProps {
  onCustom: (period: Period) => void;
  onPreset: (preset: PeriodPreset) => void;
  period: Period;
  preset: PeriodPreset;
  today: IsoDate;
}

const SHORTCUTS: readonly RangePreset[] = Object.values(PRESET_SHORTCUTS);
const SPAN = { days: MAX_PERIOD_DAYS, reason: rangeMessage("too_long") };

interface MonthArrowsProps {
  onStep: (delta: -1 | 1) => void;
  period: Period;
  today: IsoDate;
}

/**
 * "‹ ›" beside the period when it is exactly one calendar month: one touch reads the month before or after. "›" is
 * `aria-disabled` (still focusable, so the focus is not lost) on the store's current month, where there is nothing
 * ahead to read. Any other period (30 days, the year, a free range) has no arrows.
 */
function MonthArrows({ onStep, period, today }: MonthArrowsProps) {
  const previous = monthStep(period, -1, today);
  const next = monthStep(period, 1, today);
  const handlePrevious = useCallback(() => {
    if (previous) {
      onStep(-1);
    }
  }, [onStep, previous]);
  const handleNext = useCallback(() => {
    if (next) {
      onStep(1);
    }
  }, [next, onStep]);
  return (
    <ButtonGroup aria-label="Mês do período" className="shrink-0">
      <Button
        aria-disabled={previous === null ? true : undefined}
        aria-label="Mês anterior"
        onClick={handlePrevious}
        size="icon"
        type="button"
        variant="outline"
      >
        <ChevronLeftIcon aria-hidden="true" />
      </Button>
      <Button
        aria-disabled={next === null ? true : undefined}
        aria-label="Próximo mês"
        onClick={handleNext}
        size="icon"
        type="button"
        variant="outline"
      >
        <ChevronRightIcon aria-hidden="true" />
      </Button>
    </ButtonGroup>
  );
}

/**
 * A shortcut keeps the preset the screen copies and counts offline by; a range chosen or typed is "Período", up to
 * 366 days (the panel does not let a longer one be made).
 */
export function PeriodPicker({
  onCustom,
  onPreset,
  period,
  preset,
  today,
}: PeriodPickerProps) {
  const change = useCallback(
    (range: DateRange | null, shortcut?: RangePreset) => {
      if (range === null) {
        return;
      }
      const chosen = shortcut ? presetOfShortcut(shortcut) : null;
      if (chosen) {
        onPreset(chosen);
        return;
      }
      if (rangeProblem(range.from, range.to) === null) {
        onCustom(range);
      }
    },
    [onCustom, onPreset]
  );
  const step = useCallback(
    (delta: -1 | 1) => {
      const target = monthStep(period, delta, today);
      if (target === null) {
        return;
      }
      if (target.custom) {
        onCustom(target.custom);
      } else {
        onPreset(target.preset);
      }
    },
    [onCustom, onPreset, period, today]
  );
  // a window that moves (30 days, the year) is not a month even on the days its dates happen to be one
  const wholeMonth =
    preset !== "last-30" && preset !== "year" && wholeMonthOf(period) !== null;
  // the dates say the year when the period is not all of this year (formatRange): too long to share a 320 px line with
  // the arrows at a large letter, so only then the button keeps its own width and lets the arrows wrap under it
  const datesWithYear =
    period.from.slice(0, 4) !== today.slice(0, 4) ||
    period.to.slice(0, 4) !== today.slice(0, 4);
  // the row keeps the height of a control with or without the arrows, so none of the screen below jumps; only a window
  // too narrow for the dates and the arrows (a year written, a large letter) wraps the arrows under the button, whole.
  return (
    <div
      className="flex min-h-ctl-md touch:min-h-11 flex-wrap items-center gap-x-3 gap-y-2"
      data-period-row
    >
      <DateRangePicker
        action="editar"
        className={cn(
          "min-w-0 sm:flex-none",
          datesWithYear ? "flex-auto" : "flex-1"
        )}
        clearable={false}
        label="Período"
        onValueChange={change}
        pressed={preset === "custom" ? null : PRESET_SHORTCUTS[preset]}
        shortcuts={SHORTCUTS}
        span={SPAN}
        today={today}
        value={period}
      />
      {wholeMonth ? (
        <>
          <MonthArrows onStep={step} period={period} today={today} />
          {/* the arrows keep the focus and their names, so the new month is said here, once per step */}
          <p
            aria-atomic="true"
            aria-live="polite"
            className="sr-only"
            data-month-live
          >
            {`Período: ${periodText(period, today.slice(0, 4))}`}
          </p>
        </>
      ) : null}
    </div>
  );
}
