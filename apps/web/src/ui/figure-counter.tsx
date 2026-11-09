import NumberFlow, { type Format, NumberFlowElement } from "@number-flow/react";
import { useCallback, useLayoutEffect, useState } from "react";
import { MOTION } from "@/lib/motion-level";
import { cn } from "@/lib/utils";
import type { Figure } from "./animated-figure";

/**
 * The count itself, `@number-flow/react` as Bklit UI's `ChartStatFlow` uses it, which only this file imports (the rule
 * is in `scripts/ui-source-rules.test.ts`). `animated-figure.tsx` loads this module with a dynamic `import()` and only
 * at the `full` level of motion, so the package is a chunk of its own that a phone, or a window under
 * `prefers-reduced-motion`, never asks for, and no other chunk carries it (`counterPlacementProblems` in
 * `pwa/precache-budget.ts`). Nothing else may import this file statically, or the package comes back into that chunk.
 */

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
export const COUNTER_READY =
  typeof Element !== "undefined" && closeShadowRoot();

/* the "R$" and the percent sign are a size smaller than the number, and the cents one step under it, as `Money` writes them */
const SYMBOL_PARTS =
  "[&::part(currency)]:font-medium [&::part(currency)]:text-[0.56em] [&::part(currency)]:tracking-normal [&::part(literal)]:text-[0.56em] [&::part(literal)]:tracking-normal [&::part(fraction)]:text-[0.72em]";
const SMALL_PERCENT =
  "[&::part(right)]:font-medium [&::part(right)]:text-[0.56em] [&::part(right)]:tracking-normal";
/* the fade of the digits spills half an em past each side of the number: clipped sideways, so the card that holds it never
   scrolls or looks cut, and left open vertically, where the digits roll. Only the counter is inside the clip: the text of
   the figure is outside it, so the box that cuts holds no text to be cut */
const CLIP = "overflow-x-clip";
/* the host takes room above and below the digits for the fade of their mask: pulled back so the line keeps its height */
const HOST_BOX = "-my-[0.25em] align-baseline";

function partsClass(figure: Figure, smallSign: boolean): string {
  if (figure.kind === "money") {
    return SYMBOL_PARTS;
  }
  return smallSign ? SMALL_PERCENT : "";
}

export function Counter({
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
      className={CLIP}
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
