"use client";

import { Progress as ProgressPrimitive } from "@base-ui/react/progress";
import { cn } from "@/lib/utils";

/* Polaris v5.1: a 4 px track in the muted color and the indicator in ink (`primary`): the brand red is for
   the mark and the current place. The width changes without a transition (opacity is the only movement). */
function Progress({
  className,
  children,
  marker,
  value,
  ...props
}: ProgressPrimitive.Root.Props & {
  /** Where a reference mark crosses the bar, 0 to 100 (a drawing only: say what it means in text). */
  marker?: number | undefined;
}) {
  return (
    <ProgressPrimitive.Root
      className={cn("flex flex-wrap gap-3", className)}
      data-slot="progress"
      value={value}
      {...props}
    >
      {children}
      <div className="relative w-full">
        <ProgressTrack>
          <ProgressIndicator />
        </ProgressTrack>
        {marker === undefined ? null : <ProgressMarker position={marker} />}
      </div>
    </ProgressPrimitive.Root>
  );
}

/* A 2 px mark in the text color, 4 px taller than the bar, with 2 px of the card behind it on each side so it reads on
   the filled part and on the track alike. It does not move: animating a reference draws the eye to what did not change. */
function ProgressMarker({ position }: { position: number }) {
  return (
    <span
      aria-hidden="true"
      className="absolute -top-0.5 h-2 w-0.5 -translate-x-1/2 bg-foreground shadow-[0_0_0_0.125rem_var(--card)]"
      data-slot="progress-marker"
      style={{ left: `${position}%` }}
    />
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

function ProgressValue({ className, ...props }: ProgressPrimitive.Value.Props) {
  return (
    <ProgressPrimitive.Value
      className={cn(
        "ml-auto text-muted-foreground text-sm tabular-nums",
        className
      )}
      data-slot="progress-value"
      {...props}
    />
  );
}

export { Progress, ProgressLabel, ProgressValue };
