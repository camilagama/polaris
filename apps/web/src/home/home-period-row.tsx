import { cn } from "@/lib/utils";
import { PeriodPicker } from "../dashboard/period-picker";
import type { Period, PeriodPreset } from "../dashboard/result-period";
import { type HomeSelection, OFFLINE_ONLY } from "./home-period";

/**
 * The period of the cards, of Vendas por dia and of Mais vendidos: the Resultado's picker (one month at a time), the
 * first of the actions in the line of the title of the Início, so it is read before the figures it governs. It stays
 * in its place in every state of the page, off when there are no figures to apply it to.
 */
export function HomePeriodPicker({
  disabled,
  offline,
  onCustom,
  onPreset,
  period,
  selection,
  today,
}: {
  /** The figures the period applies to are not on screen (still being read, or none). */
  disabled: boolean;
  offline: boolean;
  onCustom: (period: Period) => void;
  onPreset: (preset: PeriodPreset) => void;
  period: Period;
  selection: HomeSelection;
  today: string;
}) {
  return (
    <div className="grid grow min-[47.5rem]:grow-0" data-home-period-picker="">
      <PeriodPicker
        disabled={disabled}
        onCustom={onCustom}
        only={offline ? OFFLINE_ONLY : undefined}
        onPreset={onPreset}
        period={period}
        preset={selection.preset}
        today={today}
      />
    </div>
  );
}

/**
 * What the picker has to say, under the row of actions: without a connection only this month and the last one open
 * (the others are off in the panel, with the reason), and from 640 px the line says it too (on a phone it is for the
 * screen reader, the panel has it in words); `note` is the line about what is on screen (a copy, a failure). With the
 * picker off there is no sentence: the button opens nothing, and the line under the title says why there are no numbers.
 * Without either, nothing is drawn.
 */
export function HomePeriodNotes({
  disabled,
  note,
  offline,
}: {
  disabled: boolean;
  note: React.ReactNode;
  offline: boolean;
}) {
  const said = offline && !disabled;
  if (!(said || note)) {
    return null;
  }
  return (
    <div
      className={cn(
        "flex w-full flex-col gap-1 sm:text-right",
        !note && "max-sm:contents"
      )}
      data-home-period=""
    >
      {said ? (
        <p className="text-muted-foreground text-support max-sm:sr-only">
          {OFFLINE_ONLY.reason}
        </p>
      ) : null}
      {note ? <div>{note}</div> : null}
    </div>
  );
}
