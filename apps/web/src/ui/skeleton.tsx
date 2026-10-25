import type * as React from "react";
import { cn } from "@/lib/utils";

/* Polaris v5.1: a pulse of the muted color. Tailwind's `pulse` moves only the opacity and the base stops every animation under
   `prefers-reduced-motion`. */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-muted", className)}
      data-slot="skeleton"
      {...props}
    />
  );
}

export { Skeleton };
