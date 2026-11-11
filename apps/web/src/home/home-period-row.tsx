import { cn } from "@/lib/utils";
import { PeriodPicker } from "../dashboard/period-picker";
import type { Period, PeriodPreset } from "../dashboard/result-period";
import { type HomeSelection, OFFLINE_ONLY } from "./home-period";

/**
 * The period of the cards of the month, of Vendas por dia and of Mais vendidos: the Resultado's picker (one month at a
 * time), at the end of the line that names the month. Without a connection only this month and the last one open: the
 * others are off in the panel, with the reason, and from 640 px the line says it beside the button too (on a phone it is
 * for the screen reader, the panel has it in words). The sentence is always in the line, invisible with a connection, so
 * the line does not change height when the connection goes or comes back. `note` is the line about what is on screen (a
 * copy, a failure). With the picker off (no figures to apply it to) the sentence stays invisible and out of the screen
 * reader even offline: the button opens nothing, and the line under the title says why there are no numbers.
 */
export function HomePeriodRow({
  disabled,
  note,
  offline,
  onCustom,
  onPreset,
  period,
  selection,
  today,
}: {
  /** The figures the period applies to are not on screen (still being read, or none). */
  disabled: boolean;
  note: React.ReactNode;
  offline: boolean;
  onCustom: (period: Period) => void;
  onPreset: (preset: PeriodPreset) => void;
  period: Period;
  selection: HomeSelection;
  today: string;
}) {
  const said = offline && !disabled;
  return (
    <div
      className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1"
      data-home-period=""
    >
      <p
        aria-hidden={said ? undefined : true}
        className={cn(
          "text-muted-foreground text-support",
          said ? "max-sm:sr-only" : "invisible max-sm:hidden"
        )}
      >
        {OFFLINE_ONLY.reason}
      </p>
      <PeriodPicker
        disabled={disabled}
        onCustom={onCustom}
        onPreset={onPreset}
        only={offline ? OFFLINE_ONLY : undefined}
        period={period}
        preset={selection.preset}
        today={today}
      />
      {note ? <div className="basis-full text-right">{note}</div> : null}
    </div>
  );
}
