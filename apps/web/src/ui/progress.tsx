"use client";

import { Progress as ProgressPrimitive } from "@base-ui/react/progress";
import { cn } from "@/lib/utils";

/* Polaris v5.1: a 4 px track in the muted color and the indicator in ink (`primary`): the emerald is for
   the exceptional. The width changes without a transition (opacity is the only movement). */
function Progress({
  className,
  children,
  gap = "3",
  value,
  ...props
}: ProgressPrimitive.Root.Props & {
  /** The space between the label, the value and the bar: 12 px, or 6 px. */
  gap?: "1.5" | "3";
}) {
  return (
    <ProgressPrimitive.Root
      className={cn(
        "flex flex-wrap",
        gap === "3" ? "gap-3" : "gap-1.5",
        className
      )}
      data-slot="progress"
      value={value}
      {...props}
    >
      {children}
      <ProgressTrack>
        <ProgressIndicator />
      </ProgressTrack>
    </ProgressPrimitive.Root>
  );
}

function ProgressTrack({ className, ...props }: ProgressPrimitive.Track.Props) {
  return (
    <ProgressPrimitive.Track
      className={cn(
        "relative flex h-1 w-full items-center overflow-x-hidden rounded-full bg-muted",
        className
      )}
      data-slot="progress-track"
      {...props}
    />
  );
}

function ProgressIndicator({
  className,
  ...props
}: ProgressPrimitive.Indicator.Props) {
  return (
    <ProgressPrimitive.Indicator
      className={cn("h-full bg-primary", className)}
      data-slot="progress-indicator"
      {...props}
    />
  );
}

function ProgressLabel({ className, ...props }: ProgressPrimitive.Label.Props) {
  return (
    <ProgressPrimitive.Label
      className={cn("font-medium text-sm", className)}
      data-slot="progress-label"
      {...props}
    />
  );
}

function ProgressValue({
  className,
  tone = "muted",
  ...props
}: ProgressPrimitive.Value.Props & { tone?: "foreground" | "muted" }) {
  return (
    <ProgressPrimitive.Value
      className={cn(
        "ml-auto text-sm tabular-nums",
        tone === "foreground" ? "text-foreground" : "text-muted-foreground",
        className
      )}
      data-slot="progress-value"
      {...props}
    />
  );
}

export { Progress, ProgressLabel, ProgressValue };
