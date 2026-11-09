import { type ReactNode, useEffect, useRef, useState } from "react";
import { useHiddenValues } from "@/lib/hidden-values";
import { readMotionLevel, useMotionLevel } from "@/lib/motion-level";

/**
 * The counter of the main numbers of the cards (the value of a KPI, the change in percent, the percent of the goal and
 * of the margin): Bklit UI's `ChartStatFlow` counter, in `figure-counter.tsx`. Nothing else on a screen counts: the rest
 * appears finished.
 *
 * The figure is written twice on purpose. The static one (`children`, the same DOM the screen had before the counter)
 * stays in the tree for a screen reader, a search and the tests, with the final text from the first frame; the counter
 * is `aria-hidden`, so no step of the count is ever announced. Both sit in the same cell of a grid: the static figure is
 * transparent and holds the width of the final text, so the counter has its room in every frame of a figure that grows
 * and the neighbours of the figure (the chip beside the value of a card) never move.
 *
 * The counter runs only at the `full` level of motion: on a phone (under 760 px) and under `prefers-reduced-motion` the
 * static figure is all there is, final at the first frame, and the counter's code is never downloaded: it is a chunk of
 * its own, loaded by `import()` only when a figure is about to count. A tablet with touch from 760 px up has the
 * desktop's layout and counts. Until the chunk arrives the figure holds its place, transparent and with its full
 * height; if the chunk fails, or the browser cannot set the counter up, the static figure shows. It also never runs
 * while the values are hidden (the amount is written "R$ ••••" and no digit goes through the DOM) and does not count
 * when they come back: it appears finished.
 */

const MONEY = /^([-+−]?)R\$\s?(\d[\d.]*),(\d{2})$/;
const PERCENT = /^([-+−]?)(\d[\d.]*)(?:,(\d+))?%$/;
const NEGATIVE = /^[-−]/;

export interface Figure {
  digits: number;
  kind: "money" | "percent";
  signed: boolean;
  value: number;
}

function toNumber(sign: string, whole: string, fraction: string): number {
  const magnitude = Number(`${whole.replaceAll(".", "")}.${fraction || "0"}`);
  return NEGATIVE.test(sign) ? -magnitude : magnitude;
}

/** The amount or the percent as the app writes it ("-R$ 1.234,56", "+30,0%", "41,2%"), or null for any other text. */
export function parseFigure(text: string): Figure | null {
  const trimmed = text.trim();
  const money = MONEY.exec(trimmed);
  if (money) {
    return {
      digits: 2,
      kind: "money",
      signed: money[1] === "+",
      value: toNumber(money[1] ?? "", money[2] ?? "0", money[3] ?? ""),
    };
  }
  const percent = PERCENT.exec(trimmed);
  if (percent) {
    const fraction = percent[3] ?? "";
    return {
      digits: fraction.length,
      kind: "percent",
      signed: percent[1] === "+",
      value: toNumber(percent[1] ?? "", percent[2] ?? "0", fraction),
    };
  }
  return null;
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
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!wanted || module || failed) {
      return;
    }
    let current = true;
    loadCounter().then((found) => {
      if (!current) {
        return;
      }
      if (found) {
        setModule(found);
      } else {
        setFailed(true);
      }
    });
    return () => {
      current = false;
    };
  }, [wanted, module, failed]);
  return { failed, module };
}

/* the figure and its counter share the one cell of a grid, aligned by their baselines */
const WRAPPER =
  "inline-grid align-baseline *:col-start-1 *:row-start-1 *:self-baseline";
/* the static figure: it holds the width of the final text, no height (the counter sets the line), and is seen only by the reading tools */
const TWIN = "pointer-events-none h-0 select-none whitespace-nowrap opacity-0";
/* the same, before the counter's chunk arrives: with its height, so the line does not change when the counter takes over */
const WAITING = "pointer-events-none select-none whitespace-nowrap opacity-0";

export function AnimatedFigure({
  children,
  smallSign = false,
  text,
}: {
  /** The static figure: what the screen wrote before the counter, in the same DOM. */
  children: ReactNode;
  /** The percent sign a size smaller than the number (the margin), as "R$" is. */
  smallSign?: boolean;
  /** The figure as the app writes it: "R$ 1.234,56", "+30,0%", "41,2%". */
  text: string;
}) {
  const level = useMotionLevel();
  const [hidden] = useHiddenValues();
  const figure = parseFigure(text);
  const masked = hidden && figure?.kind === "money";
  const wanted = level === "full" && figure !== null && !masked;
  const { failed, module } = useCounterModule(wanted);
  const moves = wanted && !failed;
  const enter = useRef(true);
  useEffect(() => {
    if (!moves) {
      enter.current = false;
    }
  });
  if (!(moves && figure)) {
    return <>{children}</>;
  }
  if (!module) {
    return (
      <span className={WRAPPER}>
        <span className={WAITING}>{children}</span>
      </span>
    );
  }
  return (
    <span className={WRAPPER}>
      <span className={TWIN}>{children}</span>
      <module.Counter
        enter={enter.current}
        figure={figure}
        smallSign={smallSign}
      />
    </span>
  );
}
