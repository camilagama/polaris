import { type ReactNode, useEffect, useState } from "react";
import { useHiddenValues } from "@/lib/hidden-values";
import { readMotionLevel, useMotionLevel } from "@/lib/motion-level";

/**
 * The counter of the main number of a card (the value of a KPI): Bklit UI's `ChartStatFlow` counter, in
 * `figure-counter.tsx`. Nothing else on a screen counts: the chip, the percent of the goal and the margin change with no
 * animation, and every figure is drawn finished, with no count from zero.
 *
 * The figure is written twice on purpose. The static one (`children`, the same DOM the screen had before the counter)
 * stays in the tree for a screen reader, a search and the tests, with the final text from the first frame; the counter
 * is `aria-hidden`, so no step of the roll is ever announced. Both sit in the same cell of a grid: the static figure is
 * transparent and holds the width of the final text, so the counter has its room in every frame of a figure that grows
 * and the neighbours of the figure never move.
 *
 * The counter rolls only when the value changes (another period, a day read on the sparkline, a refresh), and only at the
 * `full` level of motion: on a phone (under 760 px) and under `prefers-reduced-motion` the static figure is all there is
 * and the counter's code is never requested nor run: it is a chunk of its own, loaded by `import()` only when a figure is
 * about to roll. A tablet with touch from 760 px up has the desktop's layout and rolls. A figure built before the chunk
 * arrives swaps to the counter showing the same final text. If the chunk fails, or the browser cannot set the counter up,
 * the static figure stays. The counter never runs while the values are hidden (the amount is written "R$ ••••" and no
 * digit goes through the DOM).
 */

const MONEY = /^([-+−]?)R\$\s?(\d[\d.]*),(\d{2})$/;
const NEGATIVE = /^[-−]/;

export interface Figure {
  signed: boolean;
  value: number;
}

/** The amount as the app writes it ("-R$ 1.234,56", "+R$ 436,86"), or null for any other text. */
export function parseFigure(text: string): Figure | null {
  const money = MONEY.exec(text.trim());
  if (!money) {
    return null;
  }
  const magnitude = Number(
    `${(money[2] ?? "0").replaceAll(".", "")}.${money[3]}`
  );
  return {
    signed: money[1] === "+",
    value: NEGATIVE.test(money[1] ?? "") ? -magnitude : magnitude,
  };
}

type CounterModule = typeof import("./figure-counter");

let loaded: CounterModule | null = null;
let loading: Promise<CounterModule | null> | null = null;

/** The module of the counter, or null when it could not be loaded or this browser cannot set the counter up. */
function loadCounter(): Promise<CounterModule | null> {
  loading ??= import("./figure-counter").then(
    (module) => {
      loaded = module.COUNTER_READY ? module : null;
      return loaded;
    },
    () => {
      loading = null;
      return null;
    }
  );
  return loading;
}

/* a screen with figures is on its way here: ask for the chunk now, so it is evaluated before the data arrives and the first
   count does not start in the frame that also builds the cards; a phone and reduced motion never get here */
if (readMotionLevel() === "full") {
  loadCounter();
}

function useCounterModule(wanted: boolean) {
  const [module, setModule] = useState(loaded);
  useEffect(() => {
    if (!wanted || module) {
      return;
    }
    let current = true;
    loadCounter().then((found) => {
      if (current && found) {
        setModule(found);
      }
    });
    return () => {
      current = false;
    };
  }, [wanted, module]);
  return module;
}

/* the figure and its counter share the one cell of a grid, aligned by their baselines */
const WRAPPER =
  "inline-grid align-baseline *:col-start-1 *:row-start-1 *:self-baseline";
/* the static figure: it holds the width of the final text, no height (the counter sets the line), and is seen only by the reading tools */
const TWIN = "pointer-events-none h-0 select-none whitespace-nowrap opacity-0";

export function AnimatedFigure({
  children,
  text,
}: {
  /** The static figure: what the screen wrote before the counter, in the same DOM. */
  children: ReactNode;
  /** The figure as the app writes it: "R$ 1.234,56". */
  text: string;
}) {
  const level = useMotionLevel();
  const [hidden] = useHiddenValues();
  const figure = parseFigure(text);
  const wanted = level === "full" && figure !== null && !hidden;
  const module = useCounterModule(wanted);
  if (!(wanted && module && figure)) {
    return <>{children}</>;
  }
  return (
    <span className={WRAPPER}>
      <span className={TWIN}>{children}</span>
      <module.Counter figure={figure} />
    </span>
  );
}
