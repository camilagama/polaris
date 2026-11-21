import ArrowDownIcon from "lucide-react/dist/esm/icons/arrow-down";
import ArrowUpIcon from "lucide-react/dist/esm/icons/arrow-up";
import MinusIcon from "lucide-react/dist/esm/icons/minus";
import { cn } from "@/lib/utils";

export type PaceState = "ahead" | "behind" | "on_pace";

const ICONS = {
  ahead: ArrowUpIcon,
  behind: ArrowDownIcon,
  on_pace: MinusIcon,
} as const satisfies Record<PaceState, unknown>;

/**
 * The word of a pace ("Adiantada", "No ritmo", "Atrasada"), written, in the color of the text (it is not an error),
 * with a 12 px icon as decoration. The line is always there, empty when there is no word (`state` null), so the
 * block keeps its height with and without it.
 */
function PaceLine({
  className,
  label,
  state,
}: {
  className?: string;
  label: string | null;
  state: PaceState | null;
}) {
  const Icon = state ? ICONS[state] : null;
  return (
    <p
      className={cn(
        "flex min-h-4.5 items-center gap-1 text-support",
        className
      )}
      data-pace={state ?? ""}
    >
      {Icon ? <Icon aria-hidden="true" className="size-3 shrink-0" /> : null}
      {state ? label : null}
    </p>
  );
}

export { PaceLine };
