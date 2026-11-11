import { type ReactNode, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * The main number of a card (the value of a KPI) when it changes: the new figure comes in with a short fade and a
 * slight rise (`motion-full:animate-in`, 200 ms), the whole figure at once and never digit by digit. Nothing else on a
 * screen animates a number: the chip, the percent of the goal and the margin change with no animation, and every figure
 * is drawn finished, never counted from zero.
 *
 * The figure is the plain DOM the screen already had (`children`), so a screen reader, a search and the tests read the
 * final text from the first frame. A figure that is first drawn does not animate: only a different `text` after that
 * remounts the box with the entrance. Whether it runs is the CSS's: `motion-full:` is there only at the `full` level of
 * motion, so on a phone (under 760 px) and under `prefers-reduced-motion` the figure just changes. A tablet with touch
 * from 760 px up has the desktop's layout and animates. Hiding the values and showing them again does not animate: the
 * entrance is tied to the text changing, not to what is on show, and a change that happened while the values were
 * hidden is not played when they come back.
 */

export const ENTRANCE =
  "motion-full:fade-in-0 motion-full:slide-in-from-bottom-1 motion-full:animate-in motion-full:duration-200";

export interface FigureState {
  animate: boolean;
  generation: number;
  text: string;
}

/** The state after the figure was drawn with `text`: a different text starts a new entrance, unless the values are hidden. */
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
  /** The figure: what the screen wrote, in the same DOM. */
  children: ReactNode;
  /** The values are hidden: a change then is not played. */
  hidden?: boolean;
  /** The figure as the app writes it ("R$ 1.234,56"): when it changes, the new one enters. */
  text: string;
}) {
  const [last, setLast] = useState<FigureState>({
    animate: false,
    generation: 0,
    text,
  });
  const next = nextFigureState(last, text, hidden);
  if (next !== last) {
    setLast(next);
  }
  return (
    <span
      className={cn("inline-block align-baseline", last.animate && ENTRANCE)}
      data-figure-changed={last.animate ? "" : undefined}
      key={last.generation}
    >
      {children}
    </span>
  );
}
