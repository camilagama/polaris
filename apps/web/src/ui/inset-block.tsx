import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The block set back into a card, a block or a dialog, for data that is read: the full `--muted` fill, rounded, no
 * border (a ring inside the card's ring reads as a box in a box). One grey only, never a fraction of it. A form's
 * fields go in `FieldGroup` instead.
 */
function InsetBlock({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("min-w-0 rounded-lg bg-muted p-4", className)}
      data-slot="inset-block"
      {...props}
    />
  );
}

export { InsetBlock };
