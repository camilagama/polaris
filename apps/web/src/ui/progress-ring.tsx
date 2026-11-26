import { cn } from "@/lib/utils";

const BOX = 16;
const STROKE = 2;
const RADIUS = (BOX - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** The part of the circle left bare for `done` of `total`, in the units of the circle's own length. */
export function ringOffset(done: number, total: number): number {
  const share = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  return CIRCUMFERENCE * (1 - share);
}

/**
 * A 16 px ring that fills clockwise from the top: the track in ink at 15 %, the arc in ink. It is only a drawing
 * (`aria-hidden`): the figure it shows is always written beside it. The arc moves from the old value to the new one
 * only where the interface moves (`motion-full:`, so never on a phone or under reduced motion), and a ring drawn
 * for the first time starts already at its value.
 */
export function ProgressRing({
  className,
  done,
  total,
}: {
  className?: string;
  done: number;
  total: number;
}) {
  return (
    <svg
      aria-hidden="true"
      className={cn("size-4 shrink-0 -rotate-90", className)}
      data-progress-ring=""
      fill="none"
      focusable="false"
      viewBox={`0 0 ${BOX} ${BOX}`}
    >
      <circle
        className="stroke-primary/15"
        cx={BOX / 2}
        cy={BOX / 2}
        r={RADIUS}
        strokeWidth={STROKE}
      />
      <circle
        className="stroke-primary motion-full:transition-[stroke-dashoffset] motion-full:duration-300 motion-full:ease-out"
        cx={BOX / 2}
        cy={BOX / 2}
        data-progress-arc=""
        r={RADIUS}
        strokeDasharray={CIRCUMFERENCE}
        strokeWidth={STROKE}
        style={{ strokeDashoffset: ringOffset(done, total) }}
      />
    </svg>
  );
}
