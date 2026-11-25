import type * as React from "react";
import { cn } from "@/lib/utils";

interface InsetBlockProps extends React.ComponentProps<"div"> {
  /**
   * `destructive` is the confirmation of something that cannot be undone, asked in the row itself: the same grey with a
   * 1 px inner ring in `destructive` at 60 %, which keeps 3:1 against `--muted` in both themes (WCAG 1.4.11, held by
   * `styles/contrast.test.ts`). No red fill and no red text.
   */
  tone?: "default" | "destructive";
}

/**
 * The block set back into a card, a block or a dialog, for data that is read: the full `--muted` fill, rounded, no
 * border (a ring inside the card's ring reads as a box in a box). One grey only, never a fraction of it. A form's
 * fields go in `FieldGroup` instead.
 */
function InsetBlock({
  className,
  tone = "default",
  ...props
}: InsetBlockProps) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-lg bg-muted p-4",
        tone === "destructive" && "ring-1 ring-destructive/60 ring-inset",
        className
      )}
      data-slot="inset-block"
      {...props}
    />
  );
}

export { InsetBlock };
