import { useSyncExternalStore } from "react";

/**
 * How much the interface moves (ADR 0103, "Níveis de movimento"). One definition, read by the
 * CSS through `<html data-motion>` (the `motion-full:` variant of theme.css) and by the code that animates in
 * JavaScript (the filter bar, the charts and the panel of the phone) through `useMotionLevel()` or `readMotionLevel()`.
 * No component reads the width or the pointer on its own.
 *
 * - `none`: `prefers-reduced-motion: reduce`. It wins over everything: not even the essential motion runs (theme.css).
 * - `essential`: a phone, a coarse pointer on a narrow screen (under 760 px, the line of the sidebar and of
 *   `useIsMobile`) or a short one (500 px or less: the phone on its side). Only the motion of `ESSENTIAL_MOTION`
 *   (scripts/ui-source-rules.test.ts) runs: the press of a button, the pulse of the skeleton, the drag of a toast,
 *   the tooltip of a chart following the finger and the row of pills scrolling to a pill.
 * - `full`: the rest, the tablet and the narrow desktop window included.
 */
export type MotionLevel = "essential" | "full" | "none";

/** Under this width a touch screen is a phone: the 760 px of DESIGN.md. */
const PHONE_WIDTH = 760;
/** At this height or less a touch screen is a phone on its side (932×430), wider than the line above. */
const PHONE_SIDEWAYS_HEIGHT = 500;

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";
const COARSE_QUERY = "(pointer: coarse)";
/** Only to hear the window crossing one of the two lines: the level is computed from the width and height. */
const PHONE_SIZE_QUERY = `(max-width: ${PHONE_WIDTH - 0.02}px), (max-height: ${PHONE_SIDEWAYS_HEIGHT}px)`;

export interface MotionInputs {
  /** `(pointer: coarse)`: the primary pointer is a finger. */
  coarse: boolean;
  height: number;
  /** `prefers-reduced-motion: reduce`. */
  reduced: boolean;
  width: number;
}

export function motionLevel({
  coarse,
  height,
  reduced,
  width,
}: MotionInputs): MotionLevel {
  if (reduced) {
    return "none";
  }
  const phone =
    coarse && (width < PHONE_WIDTH || height <= PHONE_SIDEWAYS_HEIGHT);
  return phone ? "essential" : "full";
}

/** The level of this window now; with no window (a render to a string) the safe one, with no dispensable motion. */
export function readMotionLevel(): MotionLevel {
  if (typeof window === "undefined" || !window.matchMedia) {
    return "essential";
  }
  return motionLevel({
    coarse: window.matchMedia(COARSE_QUERY).matches,
    height: window.innerHeight,
    reduced: window.matchMedia(REDUCED_QUERY).matches,
    width: window.innerWidth,
  });
}

/** Calls `onChange` when the motion preference, the pointer or one of the two lines of size changes. */
function subscribeMotionLevel(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) {
    return () => undefined;
  }
  const queries = [REDUCED_QUERY, COARSE_QUERY, PHONE_SIZE_QUERY].map((query) =>
    window.matchMedia(query)
  );
  for (const query of queries) {
    query.addEventListener("change", onChange);
  }
  return () => {
    for (const query of queries) {
      query.removeEventListener("change", onChange);
    }
  };
}

/**
 * Writes the level on `<html data-motion>` and keeps it there as the window changes. Called by main.tsx before the
 * first render; with no attribute the CSS runs no dispensable motion.
 */
export function followMotionLevel(
  root: HTMLElement = document.documentElement
) {
  const write = () => {
    root.dataset.motion = readMotionLevel();
  };
  write();
  return subscribeMotionLevel(write);
}

const serverLevel = (): MotionLevel => "essential";

/** The level for a component, updated when it changes. */
export function useMotionLevel(): MotionLevel {
  return useSyncExternalStore(
    subscribeMotionLevel,
    readMotionLevel,
    serverLevel
  );
}
