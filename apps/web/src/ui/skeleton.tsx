import type * as React from "react";
import { cn } from "@/lib/utils";

/* Polaris v5.1: a pulse of the muted color. Tailwind's `pulse` moves only the opacity (the movement rule, read by
   scripts/ui-source-rules.test.ts) and the base stops every animation under `prefers-reduced-motion`. */
function Skeleton({
  circle = false,
  className,
  ...props
}: React.ComponentProps<"div"> & { circle?: boolean }) {
  return (
    <div
      className={cn(
        "animate-pulse bg-muted",
        circle ? "rounded-full" : "rounded-md",
        className
      )}
      data-slot="skeleton"
      {...props}
    />
  );
}

export { Skeleton };
