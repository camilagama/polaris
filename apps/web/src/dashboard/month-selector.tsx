import { type ChangeEvent, useCallback, useEffect, useState } from "react";
import { isMonthValue, shiftMonth } from "../expenses/expense-model";

interface MonthSelectorProps {
  /** YYYY-MM */
  month: string;
  onChange: (month: string) => void;
}

/** Previous and next month buttons around a month field. */
export function MonthSelector({ month, onChange }: MonthSelectorProps) {
  // typed text can be half a month for a moment: only a whole month is applied
  const [monthText, setMonthText] = useState(month);
  useEffect(() => setMonthText(month), [month]);

  const previous = shiftMonth(month, -1);
  const next = shiftMonth(month, 1);

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
  const handleMonth = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const { value } = event.currentTarget;
      setMonthText(value);
      if (isMonthValue(value) && value !== month) {
        onChange(value);
      }
    },
    [month, onChange]
  );

  return (
    <div className="dashboard-month">
      <label className="field-label" htmlFor="dashboard-month">
        Mês
      </label>
      <div className="dashboard-month-controls">
        <button
          aria-label="Mês anterior"
          className="quiet-button"
          disabled={previous === null}
          onClick={handlePrevious}
          type="button"
        >
          ‹
        </button>
        <input
          id="dashboard-month"
          onChange={handleMonth}
          pattern="\d{4}-\d{2}"
          placeholder="AAAA-MM"
          type="month"
          value={monthText}
        />
        <button
          aria-label="Próximo mês"
          className="quiet-button"
          disabled={next === null}
          onClick={handleNext}
          type="button"
        >
          ›
        </button>
      </div>
    </div>
  );
}
