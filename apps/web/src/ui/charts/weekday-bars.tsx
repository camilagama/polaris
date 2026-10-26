/* Polaris adaptation of the Bklit UI sparkline (the blocks are in src/ui/bklit/, unchanged but for BKLIT-UI.md), MIT */
import { MotionConfig } from "motion/react";
import { useMemo } from "react";
import { useMotionLevel } from "@/lib/motion-level";
import { cn } from "@/lib/utils";
import { BarSparkline } from "../bklit/charts/sparkline";
import { drawn } from "./chart-data";

export interface WeekdayBarsProps {
  /** The bar in green (the best weekday), or null: every bar grey. */
  best: number | null;
  className?: string;
  height?: number;
  /** Drawn finished, with no entrance (a phone, v7 § 7, and reduced motion). */
  still?: boolean;
  /** One value per weekday, Sunday first. */
  values: readonly number[];
}

/**
 * The mean by weekday beside the map (v7 § 3 item 10): Bklit UI's `BarSparkline` twice on the same scale, every bar in
 * grey and, over it, only the best weekday in the green of the sales (the block draws all its bars in one color). It
 * is `aria-hidden`: the sentence under the map says the best weekday and its mean, and the labels are the screen's.
 */
export function WeekdayBars({
  best,
  className,
  height = 64,
  still: drawnFinished = false,
  values,
}: WeekdayBarsProps) {
  const still = useMotionLevel() !== "full" || drawnFinished;
  const signature = values.join();
  const bars = useMemo(() => {
    const all = values.map((value) => ({ value: drawn(value) }));
    const top = Math.max(0, ...all.map((bar) => bar.value));
    return {
      all,
      best: all.map((bar, index) => ({
        value: index === best ? bar.value : 0,
      })),
      domain: [0, top > 0 ? top : 1] as [number, number],
    };
  }, [signature, best]);
  const common = {
    animate: !still,
    barGap: 6,
    barRadius: 4,
    dataKey: "value" as const,
    height,
    interactive: false,
    padding: 0,
    yDomain: bars.domain,
  };
  return (
    <span
      aria-hidden="true"
      className={cn("relative block w-full", className)}
      data-weekday-bars=""
      style={{ height }}
    >
      <MotionConfig reducedMotion={still ? "always" : "user"}>
        <span className="absolute inset-0">
          <BarSparkline
            {...common}
            color="color-mix(in oklch, var(--foreground) 16%, var(--card))"
            data={bars.all}
          />
        </span>
        {best === null ? null : (
          <span className="absolute inset-0">
            <BarSparkline
              {...common}
              color="var(--chart-sales)"
              data={bars.best}
            />
          </span>
        )}
      </MotionConfig>
    </span>
  );
}
