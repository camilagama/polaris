import { useCallback } from "react";
import { DateRangePicker, type RangeOnly } from "@/ui/date-range-picker";
import type { DateRange, IsoDate, RangePreset } from "@/ui/date-values";
import {
  MAX_PERIOD_DAYS,
  type Period,
  type PeriodPreset,
  PRESET_SHORTCUTS,
  presetOfShortcut,
  rangeMessage,
  rangeProblem,
} from "./result-period";

interface PeriodPickerProps {
  onCustom: (period: Period) => void;
  onPreset: (preset: PeriodPreset) => void;
  /** Without a connection: only these shortcuts open (the Início reads a period only from the server or a kept month). */
  only?: RangeOnly | undefined;
  period: Period;
  preset: PeriodPreset;
  today: IsoDate;
}

const SHORTCUTS: readonly RangePreset[] = Object.values(PRESET_SHORTCUTS);
const SPAN = { days: MAX_PERIOD_DAYS, reason: rangeMessage("too_long") };

/**
 * A shortcut keeps the preset the screen copies and counts offline by; a range chosen or typed is "Período", up to
 * 366 days (the panel does not let a longer one be made).
 */
export function PeriodPicker({
  onCustom,
  onPreset,
  only,
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
  return (
    <DateRangePicker
      action="editar"
      clearable={false}
      label="Período"
      onValueChange={change}
      only={only}
      pressed={preset === "custom" ? null : PRESET_SHORTCUTS[preset]}
      shortcuts={SHORTCUTS}
      span={SPAN}
      today={today}
      value={period}
    />
  );
}
