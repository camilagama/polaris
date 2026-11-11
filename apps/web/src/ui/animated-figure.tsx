import {
  type AnimationEvent,
  type ReactNode,
  useCallback,
  useState,
} from "react";
import { cn } from "@/lib/utils";

/**
 * The new figure comes in whole (fade and a slight rise), never digit by digit. `children` stays the plain DOM, so
 * readers get the final text at once. Only a different `text` after the first draw remounts the box with the entrance;
 * the entrance is dropped when it ends, so a later change of motion level does not replay it; `motion-full:` keeps it off on a phone and under `prefers-reduced-motion`, and a change made while the values are
 * hidden is not played when they come back.
 */

export const ENTRANCE =
  "motion-full:fade-in-0 motion-full:slide-in-from-bottom-1 motion-full:animate-in motion-full:duration-200";

export interface FigureState {
  animate: boolean;
  generation: number;
  text: string;
}

export function nextFigureState(
  last: FigureState,
  text: string,
  hidden: boolean
): FigureState {
  if (last.text === text) {
    return last;
  }
  return { animate: !hidden, generation: last.generation + 1, text };
}

export function AnimatedFigure({
  children,
  hidden = false,
  text,
}: {
  children: ReactNode;
  hidden?: boolean;
  /** The figure as the app writes it ("R$ 1.234,56"): when it changes, the new one enters. */
  text: string;
}) {
  const [last, setLast] = useState<FigureState>({
    animate: false,
    generation: 0,
    text,
  });
  const settle = useCallback((event: AnimationEvent<HTMLSpanElement>) => {
    if (event.target === event.currentTarget) {
      setLast((state) => ({ ...state, animate: false }));
    }
  }, []);
  const next = nextFigureState(last, text, hidden);
  if (next !== last) {
    setLast(next);
  }
  return (
    <span
      className={cn("inline-block align-baseline", last.animate && ENTRANCE)}
      data-figure-changed={last.animate ? "" : undefined}
      key={last.generation}
      onAnimationEnd={settle}
    >
      {children}
    </span>
  );
}
