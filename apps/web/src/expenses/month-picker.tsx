import ChevronLeftIcon from "lucide-react/dist/esm/icons/chevron-left";
import ChevronRightIcon from "lucide-react/dist/esm/icons/chevron-right";
import {
  type ChangeEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { ButtonGroup } from "@/ui/button-group";
import { Field, FieldLabel } from "@/ui/field";
import { InputGroup } from "@/ui/input-group";
import { formatMonthLabel, isMonthValue, shiftMonth } from "./expense-model";

/* The month picker of the v5.1 (Despesas, and Resultado after it): "‹ Outubro de 2026 ›" glued in one ButtonGroup.
   The month is written by the screen, never by the browser's locale: the native month field sits invisible over
   the text, so a tap or a click opens the browser's own picker and the keyboard types into it, while the person
   reads "Outubro de 2026". A browser with no month field (Firefox, Safari on the desktop) would show an invisible
   text box there: it gets the text alone, and the arrows. With the keyboard (focus-visible) the field shows itself
   in place of the text, so what is typed is seen; the mouse and the touch keep the invisible field. */

function monthFieldSupported(): boolean {
  if (typeof document === "undefined") {
    // drawn without a browser (a test of the markup): the browser of the person decides at mount
    return true;
  }
  const input = document.createElement("input");
  input.setAttribute("type", "month");
  return input.type === "month";
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

interface MonthPickerProps {
  className?: string | undefined;
  id: string;
  label: string;
  /** YYYY-MM */
  month: string;
  onChange: (month: string) => void;
}

export function MonthPicker({
  className,
  id,
  label,
  month,
  onChange,
}: MonthPickerProps) {
  const [supported] = useState(monthFieldSupported);
  // typed text can be half a month for a moment: only a whole month is applied
  const [monthText, setMonthText] = useState(month);
  useEffect(() => setMonthText(month), [month]);

  const previous = shiftMonth(month, -1);
  const next = shiftMonth(month, 1);
  const labelId = `${id}-label`;

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
  const handleOpen = useCallback((event: MouseEvent<HTMLInputElement>) => {
    try {
      // a click on the desktop only focuses a part of the field: open the picker, as a tap does
      event.currentTarget.showPicker();
    } catch {
      // no picker to show (or not from this gesture): the field stays focused for the keyboard
    }
  }, []);

  return (
    <Field className={cn("w-auto min-w-0", className)}>
      {supported ? (
        <FieldLabel htmlFor={id} id={labelId}>
          {label}
        </FieldLabel>
      ) : (
        <FieldLabel id={labelId}>{label}</FieldLabel>
      )}
      {/* the field has its own label: the group is only layout (role="none"), as the quantity of the sale; with no
          month field, the group is what the label names */}
      <ButtonGroup
        aria-labelledby={supported ? undefined : labelId}
        role={supported ? "none" : "group"}
      >
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
        {supported ? (
          // the group gives the field its 48 px band with touch and the halo of the focus, as every text field
          <InputGroup className="w-auto min-w-40 flex-1 cursor-pointer justify-center bg-card shadow-xs dark:bg-secondary/60">
            <span
              aria-hidden="true"
              className="px-3 font-medium group-has-[[data-slot=input-group-control]:focus-visible]/input-group:opacity-0"
            >
              {capitalized(formatMonthLabel(month))}
            </span>
            <input
              className="absolute inset-0 size-full cursor-pointer rounded-md bg-card px-3 opacity-0 outline-none focus-visible:opacity-100 dark:bg-secondary"
              data-slot="input-group-control"
              id={id}
              onChange={handleMonth}
              onClick={handleOpen}
              type="month"
              value={monthText}
            />
          </InputGroup>
        ) : (
          <span
            className="flex h-ctl-md min-w-40 flex-1 items-center justify-center border border-border bg-card px-3 font-medium shadow-xs dark:bg-secondary/60"
            data-slot="month-picker-value"
          >
            {capitalized(formatMonthLabel(month))}
          </span>
        )}
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
