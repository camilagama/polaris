import RefreshCwIcon from "lucide-react/dist/esm/icons/refresh-cw";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { Button } from "./button";

type RefreshButtonProps = Omit<
  ComponentProps<typeof Button>,
  "aria-label" | "children" | "size" | "type" | "variant"
> & {
  /** The read is running: the icon turns (only with full motion) and the button says `aria-busy`. */
  busy?: boolean;
  /** What is read again, when the page has more than one "Atualizar" ("metas"): it ends the accessible name. */
  object?: string;
  /**
   * When the figures on screen were read ("às 09:00"): the button is then the line "Atualizado às 09:00" with the icon,
   * at every width, and its name says the same after "Atualizar".
   */
  updated?: string | undefined;
};

/**
 * "Atualizar": the one button that reads a screen again, outline, with the control height (32 with a mouse, 36 with
 * touch). Below 760 px it is the icon alone, with a 44 px touch area, unless it carries the time of the read
 * (`updated`): then it keeps the time at every width, as the one line "Atualizado às 09:00" that reads again. The
 * visible text is always inside the accessible name ("Atualizar metas", "Atualizar, atualizado às 09:00"),
 * so a voice command that says what it sees works (WCAG 2.5.3). The turning icon
 * is under `motion-full:`: on a phone and with `prefers-reduced-motion` it stays still, and the button keeps its size
 * and its place either way.
 */
export function RefreshButton({
  busy = false,
  className,
  object,
  updated,
  ...props
}: RefreshButtonProps) {
  const name = `Atualizar${object ? ` ${object}` : ""}`;
  const label = updated ? `${name}, atualizado ${updated}` : undefined;
  return (
    <Button
      {...props}
      aria-busy={busy || undefined}
      aria-label={label ?? (object ? name : undefined)}
      className={cn(
        updated
          ? "h-auto min-h-ctl-md max-w-full whitespace-normal px-2.5 py-1 text-support max-md:min-h-ctl-lg"
          : "max-md:size-ctl-lg max-md:px-0",
        className
      )}
      type="button"
      variant="outline"
    >
      <RefreshCwIcon
        aria-hidden="true"
        className={busy ? "motion-full:animate-spin" : undefined}
        data-icon="inline-start"
      />
      {updated ? (
        <span className="text-left">Atualizado {updated}</span>
      ) : (
        <span className="max-md:sr-only">Atualizar</span>
      )}
    </Button>
  );
}
