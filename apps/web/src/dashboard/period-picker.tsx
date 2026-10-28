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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
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

const PRESETS = availablePresets();
const PRESET_ITEMS = PRESETS.map((item) => ({
  label: PRESET_LABELS[item],
  value: item,
}));

/* The segmented strip of the tabs (`ui/tabs.tsx`): the one that is chosen has the card background. */
const STRIP_BUTTON =
  "touch-hit focus-ring relative inline-flex h-full flex-1 items-center justify-center whitespace-nowrap rounded-md border border-transparent px-2.5 font-medium text-muted-foreground text-sm motion-full:transition-[background-color,color,box-shadow] hover:text-foreground aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:shadow-xs dark:aria-pressed:bg-secondary";

interface StripButtonProps {
  onChoose: (preset: PeriodPreset) => void;
  preset: PeriodPreset;
  selected: boolean;
}

/** One period of the strip: pressed when it is the one on screen. */
function StripButton({ onChoose, preset, selected }: StripButtonProps) {
  const choose = useCallback(() => onChoose(preset), [onChoose, preset]);
  return (
    <button
      aria-pressed={selected}
      className={STRIP_BUTTON}
      onClick={choose}
      type="button"
    >
      {PRESET_LABELS[preset]}
    </button>
  );
}

interface PresetChoiceProps {
  onChoose: (preset: PeriodPreset) => void;
  preset: PeriodPreset;
}

/**
 * The periods as a choice: a `Select` on a phone (four chips would break into three lines there), the segmented strip
 * of the tabs from 768 px. Only one of the two is on screen.
 */
function PresetChoice({ onChoose, preset }: PresetChoiceProps) {
  const change = useCallback(
    (value: string | null) => {
      const next = PRESETS.find((item) => item === value);
      if (next) {
        onChoose(next);
      }
    },
    [onChoose]
  );
  return (
    <>
      <div className="md:hidden">
        <Select items={PRESET_ITEMS} onValueChange={change} value={preset}>
          <SelectTrigger aria-label="Período" className="w-full min-w-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PRESET_ITEMS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <FieldSet className="hidden h-ctl-md w-fit flex-row items-center gap-0 rounded-lg bg-muted p-[3px] md:flex">
        <FieldLegend className="sr-only" variant="label">
          Período
        </FieldLegend>
        {PRESETS.map((item) => (
          <StripButton
            key={item}
            onChoose={onChoose}
            preset={item}
            selected={item === preset}
          />
        ))}
      </FieldSet>
    </>
  );
}

/**
 * The periods of the Resultado (AC-1, AC-2): "Este mês" (the one it opens on), "Mês passado", "Últimos 30 dias" and
 * "Período", a free range of up to 62 days ("Este ano" and longer ranges wait for the CPU measure, AC-23). A preset reads
 * at once. The range has its own fields and a button: an invalid one says what is wrong under the field "Até" and asks
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
      <PresetChoice onChoose={choose} preset={preset} />
      {open ? (
        <form
          aria-label="Escolher o período"
          className="grid gap-4 sm:flex sm:flex-wrap sm:items-start"
          // the period goes in the address once applied, and two dates are cheap to pick again: it does not hold the
          // swap of the build (pwa/swap-guard.ts)
          data-swap-ignore=""
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
            {problem ? (
              <FieldError id={errorId}>
                {rangeMessage(problem, maxDays)}
              </FieldError>
            ) : null}
          </Field>
          <Button className="sm:mt-[1.625rem]" size="sm" type="submit">
            Ver período
          </Button>
        </form>
      ) : null}
    </div>
  );
}
