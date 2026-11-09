import RefreshCwIcon from "lucide-react/dist/esm/icons/refresh-cw";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { Button } from "./button";

type RefreshButtonProps = Omit<
  ComponentProps<typeof Button>,
  "children" | "size" | "variant"
> & {
  /** The read is running: the icon turns (only with full motion) and the button says `aria-busy`. */
  busy?: boolean;
  /** What is read again, when the page has more than one "Atualizar" ("metas"): it ends the accessible name. */
  object?: string;
};

/**
 * "Atualizar": the one button that reads a screen again, outline, with the control height (32 with a mouse, 36 with
 * touch). Below 760 px it is the icon alone, with a 44 px touch area, as "Esconder valores" beside it. The visible
 * text is always inside the accessible name ("Atualizar metas"), so a voice command that says what it sees works
 * (WCAG 2.5.3). The turning icon is under `motion-full:`: on a phone and with `prefers-reduced-motion` it stays still,
 * and the button keeps its size and its place either way.
 */
export function RefreshButton({
  busy = false,
  className,
  object,
  ...props
}: RefreshButtonProps) {
  return (
    <Button
      aria-busy={busy || undefined}
      aria-label={object ? `Atualizar ${object}` : undefined}
      className={cn("max-md:size-ctl-lg max-md:px-0", className)}
      data-refresh-button=""
      type="button"
      variant="outline"
      {...props}
    >
      <RefreshCwIcon
        aria-hidden="true"
        className={busy ? "motion-full:animate-spin" : undefined}
        data-icon="inline-start"
      />
      <span className="max-md:sr-only">Atualizar</span>
    </Button>
  );
}
