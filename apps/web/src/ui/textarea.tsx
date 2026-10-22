import type * as React from "react";
import { cn } from "@/lib/utils";

/* Polaris v5.1: the field of a long text. Border, focus and error as the text field (`InputGroup`): `--input`
   border, `--ring` border with a 30% halo on focus, `--destructive` when invalid; 16 px only with touch (iOS
   zooms in below that). It is taller than 48 px, so it needs no touch area of its own. */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "min-h-20 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm touch:text-base outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60 aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive/25 dark:bg-input/30 dark:disabled:bg-muted",
        className
      )}
      data-slot="textarea"
      {...props}
    />
  );
}

export { Textarea };
