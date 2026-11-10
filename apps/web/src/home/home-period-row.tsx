import { cn } from "@/lib/utils";
import { PeriodPicker } from "../dashboard/period-picker";
import type { Period, PeriodPreset } from "../dashboard/result-period";
import { type HomeSelection, OFFLINE_ONLY } from "./home-period";

/**
 * The period of the cards of the month, of Vendas por dia and of Mais vendidos: the Resultado's picker (one month at a
 * time), under the title. Without a connection only this month and the last one open, and the line beside the button
 * says why the others are off; `note` is the line about what is on screen (a copy, a failure).
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
  /** The figures the period applies to are still being read. */
  disabled: boolean;
  note: React.ReactNode;
  offline: boolean;
  onCustom: (period: Period) => void;
  onPreset: (preset: PeriodPreset) => void;
  period: Period;
  selection: HomeSelection;
  today: string;
}) {
  return (
    <div
      className="flex min-h-9 flex-wrap items-center gap-x-4 gap-y-1.5"
      data-home-period=""
    >
      <PeriodPicker
        disabled={disabled}
        onCustom={onCustom}
        onPreset={onPreset}
        only={offline ? OFFLINE_ONLY : undefined}
        period={period}
        preset={selection.preset}
        today={today}
      />
      {/* always in the line, hidden with a connection: the line it takes on a phone is kept, so the page does not move
          when the connection goes or comes back */}
      <p
        aria-hidden={offline ? undefined : true}
        className={cn(
          "text-muted-foreground text-support",
          !offline && "invisible"
        )}
      >
        {OFFLINE_ONLY.reason}
      </p>
      {note}
    </div>
  );
}
