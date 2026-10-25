import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useId,
  useState,
} from "react";
import { Button } from "@/ui/button";
import {
  Field,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/ui/field";
import { Input } from "@/ui/input";
import {
  availablePresets,
  maxPeriodDays,
  type Period,
  type PeriodPreset,
  PRESET_LABELS,
  type RangeProblem,
  rangeMessage,
  rangeProblem,
} from "./result-period";

interface PeriodPickerProps {
  /** A range the person typed and the screen validated (AC-2): it is the period from now on. */
  onCustom: (period: Period) => void;
  onPreset: (preset: PeriodPreset) => void;
  /** What the screen reads now: it fills the fields when the range opens. */
  period: Period;
  preset: PeriodPreset;
}

interface PresetButtonProps {
  onChoose: (preset: PeriodPreset) => void;
  preset: PeriodPreset;
  selected: boolean;
}

/** One period of the row: pressed when it is the one on screen. */
function PresetButton({ onChoose, preset, selected }: PresetButtonProps) {
  const choose = useCallback(() => onChoose(preset), [onChoose, preset]);
  return (
    <Button
      aria-pressed={selected}
      onClick={choose}
      size="sm"
      type="button"
      variant={selected ? "secondary" : "outline"}
    >
      {PRESET_LABELS[preset]}
    </Button>
  );
}

/**
 * The periods of the Resultado (AC-1, AC-2): "Este mês" (the one it opens on), "Mês passado", "Últimos 30 dias" and
 * "Período", a free range of up to 62 days ("Este ano" and longer ranges wait for the CPU measure, AC-23). A preset reads
 * at once. The range has its own fields and a button: an invalid one says what is wrong under the fields and asks
 * the server for nothing.
 */
export function PeriodPicker({
  onCustom,
  onPreset,
  period,
  preset,
}: PeriodPickerProps) {
  const id = useId();
  const [open, setOpen] = useState(preset === "custom");
  const [from, setFrom] = useState(period.from);
  const [to, setTo] = useState(period.to);
  const [problem, setProblem] = useState<RangeProblem | null>(null);
  const maxDays = maxPeriodDays();
  const errorId = `${id}-error`;
  const describedBy = problem ? errorId : undefined;

  const choose = useCallback(
    (next: PeriodPreset) => {
      if (next === "custom") {
        if (!open) {
          // the range opens on what is on screen
          setFrom(period.from);
          setTo(period.to);
        }
        setOpen(true);
        return;
      }
      setOpen(false);
      setProblem(null);
      onPreset(next);
    },
    [onPreset, open, period.from, period.to]
  );
  const handleFrom = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      setFrom(event.currentTarget.value),
    []
  );
  const handleTo = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setTo(event.currentTarget.value),
    []
  );
  const apply = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const found = rangeProblem(from, to, maxDays);
      setProblem(found);
      if (found === null) {
        onCustom({ from, to });
      }
    },
    [from, maxDays, onCustom, to]
  );

  return (
    <div className="grid gap-4">
      <FieldSet className="flex-row flex-wrap gap-x-2 gap-y-4">
        <FieldLegend className="sr-only" variant="label">
          Período
        </FieldLegend>
        {availablePresets().map((item) => (
          <PresetButton
            key={item}
            onChoose={choose}
            preset={item}
            selected={item === preset}
          />
        ))}
      </FieldSet>
      {open ? (
        <form
          aria-label="Escolher o período"
          className="grid gap-4 sm:flex sm:flex-wrap sm:items-end"
          noValidate
          onSubmit={apply}
        >
          <Field className="sm:w-44">
            <FieldLabel htmlFor={`${id}-from`}>De</FieldLabel>
            <Input
              aria-describedby={describedBy}
              aria-invalid={problem !== null}
              id={`${id}-from`}
              name="from"
              onChange={handleFrom}
              type="date"
              value={from}
            />
          </Field>
          <Field className="sm:w-44">
            <FieldLabel htmlFor={`${id}-to`}>Até</FieldLabel>
            <Input
              aria-describedby={describedBy}
              aria-invalid={problem !== null}
              id={`${id}-to`}
              name="to"
              onChange={handleTo}
              type="date"
              value={to}
            />
          </Field>
          <Button size="sm" type="submit">
            Ver período
          </Button>
          {problem ? (
            <FieldError className="sm:basis-full" id={errorId}>
              {rangeMessage(problem, maxDays)}
            </FieldError>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
