import NumberFlow, { type Format, NumberFlowElement } from "@number-flow/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useHiddenValues } from "@/lib/hidden-values";
import { MOTION, useMotionLevel } from "@/lib/motion-level";
import { cn } from "@/lib/utils";

/**
 * The counter of the main numbers of the cards (the value of a KPI, the change in percent, the percent of the goal and
 * of the margin): Bklit UI's `ChartStatFlow` counter, `@number-flow/react`, which only this file imports (the rule is in
 * `scripts/ui-source-rules.test.ts`). Nothing else on a screen counts: the rest appears finished.
 *
 * The figure is written twice on purpose. The static one (`children`, the same DOM the screen had before the counter)
 * stays in the tree for a screen reader, a search and the tests, with the final text from the first frame, and is out of
 * sight while the counter shows; the counter is `aria-hidden`, so no step of the count is ever announced.
 *
 * The counter runs only at the `full` level of motion: on a phone and under `prefers-reduced-motion` the static figure
 * is all there is, final at the first frame. It also never runs while the values are hidden (the amount is written
 * "R$ ••••" and no digit goes through the DOM) and does not count when they come back: it appears finished.
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

const formats = new Map<string, Format>();

function formatOf({ digits, kind, signed }: Figure): Format {
  const key = `${kind}:${digits}:${signed}`;
  let format = formats.get(key);
  if (!format) {
    const signDisplay = signed ? "always" : "auto";
    format =
      kind === "money"
        ? { currency: "BRL", signDisplay, style: "currency" }
        : {
            maximumFractionDigits: digits,
            minimumFractionDigits: digits,
            signDisplay,
            useGrouping: true,
          };
    formats.set(key, format);
  }
  return format;
}

const styleSheets = new Map<string, CSSStyleSheet>();
const roots = new WeakMap<Element, ShadowRoot>();
/** How many calls into the counter's own code are running: only then does `shadowRoot` answer. */
let inside = 0;

function within<T>(run: () => T): T {
  inside += 1;
  try {
    return run();
  } finally {
    inside -= 1;
  }
}

/** The root as the counter makes it, with its style element swapped for a constructed sheet. */
function adopt(root: ShadowRoot): ShadowRoot {
  const append = root.appendChild;
  root.appendChild = function <T extends Node>(this: ShadowRoot, node: T): T {
    if (!(node instanceof HTMLStyleElement)) {
      return append.call(this, node) as T;
    }
    const css = node.textContent ?? "";
    let sheet = styleSheets.get(css);
    if (!sheet) {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      styleSheets.set(css, sheet);
    }
    this.adoptedStyleSheets = [...this.adoptedStyleSheets, sheet];
    return node;
  } as typeof root.appendChild;
  return root;
}

/**
 * Two changes to how the counter builds its shadow root, both relying on its code, hence the exact version:
 *
 * - It writes its styles in a style element inside the root, which the policy of the page (`style-src 'self'`, no
 *   nonce) refuses, leaving the digits stacked and unstyled. A constructed style sheet is not a style element and is
 *   not refused, so the root adopts the sheet and the element is never put in the tree.
 * - The root is closed and only the counter's own calls see it. An open root puts the digits of every column (0 to 9,
 *   stacked) in the text that a test, a search or a screen reader's virtual cursor reads from the card; the static
 *   figure beside it is the text of the card.
 */
function closeShadowRoot(): boolean {
  const proto = NumberFlowElement.prototype;
  const base = Object.getPrototypeOf(proto) as Record<string, unknown>;
  const setters = (["data", "animated"] as const).map((name) => ({
    name,
    original: Object.getOwnPropertyDescriptor(base, name),
  }));
  const hooks = (["willUpdate", "didUpdate"] as const).map((name) => ({
    name,
    original: base[name],
  }));
  // a browser without constructed sheets, or a package that no longer has these entry points, gets the static figure
  const known =
    typeof CSSStyleSheet !== "undefined" &&
    "adoptedStyleSheets" in ShadowRoot.prototype &&
    setters.every(({ original }) => typeof original?.set === "function") &&
    hooks.every(({ original }) => typeof original === "function");
  if (!known) {
    return false;
  }
  proto.attachShadow = function (this: Element, init: ShadowRootInit) {
    const root = Element.prototype.attachShadow.call(this, {
      ...init,
      mode: "closed",
    });
    roots.set(this, root);
    return adopt(root);
  };
  Object.defineProperty(proto, "shadowRoot", {
    configurable: true,
    get(this: Element) {
      return inside > 0 ? (roots.get(this) ?? null) : null;
    },
  });
  for (const { name, original } of setters) {
    const set = original?.set;
    if (original && set) {
      Object.defineProperty(proto, name, {
        ...original,
        set(this: Element, value: unknown) {
          within(() => set.call(this, value));
        },
      });
    }
  }
  for (const { name, original } of hooks) {
    if (typeof original === "function") {
      Object.defineProperty(proto, name, {
        configurable: true,
        value(this: Element) {
          within(() => original.call(this));
        },
        writable: true,
      });
    }
  }
  return true;
}

/** Whether the counter could be set up in this browser: without it every figure stays static. */
const COUNTER_READY = typeof Element !== "undefined" && closeShadowRoot();

/* the "R$" and the percent sign are a size smaller than the number, and the cents one step under it, as `Money` writes them */
const SYMBOL_PARTS =
  "[&::part(currency)]:font-medium [&::part(currency)]:text-[0.56em] [&::part(currency)]:tracking-normal [&::part(literal)]:text-[0.56em] [&::part(literal)]:tracking-normal [&::part(fraction)]:text-[0.72em]";
const SMALL_PERCENT =
  "[&::part(right)]:font-medium [&::part(right)]:text-[0.56em] [&::part(right)]:tracking-normal";
/* the fade of the digits spills half an em past each side of the number: clipped sideways, so the card that holds it never
   scrolls or looks cut, and left open vertically, where the digits roll */
const WRAPPER = "inline-block overflow-x-clip align-baseline";
/* the host takes room above and below the digits for the fade of their mask: pulled back so the line keeps its height */
const HOST_BOX = "-my-[0.25em] align-baseline";

function partsClass(figure: Figure, smallSign: boolean): string {
  if (figure.kind === "money") {
    return SYMBOL_PARTS;
  }
  return smallSign ? SMALL_PERCENT : "";
}

function Counter({
  enter,
  figure,
  smallSign,
}: {
  enter: boolean;
  figure: Figure;
  smallSign: boolean;
}) {
  const [shown, setShown] = useState(enter ? 0 : figure.value);
  useLayoutEffect(() => {
    setShown(figure.value);
  }, [figure.value]);
  const [counting, setCounting] = useState(false);
  const start = useCallback(() => setCounting(true), []);
  const finish = useCallback(() => setCounting(false), []);
  const money = figure.kind === "money";
  return (
    <span
      aria-hidden="true"
      className={WRAPPER}
      data-figure-counting={counting ? "" : undefined}
    >
      <NumberFlow
        className={cn(HOST_BOX, partsClass(figure, smallSign))}
        data-animated-figure=""
        format={formatOf(figure)}
        locales="pt-BR"
        onAnimationsFinish={finish}
        onAnimationsStart={start}
        opacityTiming={MOTION.number}
        spinTiming={MOTION.number}
        transformTiming={MOTION.number}
        value={shown}
        {...(money ? {} : { suffix: "%" })}
      />
    </span>
  );
}

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
  const moves = COUNTER_READY && level === "full" && figure !== null && !masked;
  const enter = useRef(true);
  useEffect(() => {
    if (!moves) {
      enter.current = false;
    }
  });
  if (!(moves && figure)) {
    return <>{children}</>;
  }
  return (
    <>
      <span className="sr-only">{children}</span>
      <Counter enter={enter.current} figure={figure} smallSign={smallSign} />
    </>
  );
}
