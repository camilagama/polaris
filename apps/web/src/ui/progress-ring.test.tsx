// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { ProgressRing, ringOffset } from "./progress-ring";

const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const DASH_OFFSET = /stroke-dashoffset:([\d.]+)/;
const MOTION_OUTSIDE_FULL =
  /(?<!motion-full:)(?:transition|duration-|animate-)/;

const ARC_MOTION_CLASSES = [
  "motion-full:transition-[stroke-dashoffset]",
  "motion-full:duration-300",
  "motion-full:ease-out",
];

const mounted: (() => void)[] = [];

function renderRing() {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => {
    root.render(<ProgressRing done={1} total={3} />);
  });
  mounted.push(() => act(() => root.unmount()));
  const svg = host.querySelector("svg");
  const arc = host.querySelector("circle[data-progress-arc]");
  const track = host.querySelector("circle:not([data-progress-arc])");
  if (!(svg && arc && track)) {
    throw new Error("the ring did not draw its svg, arc and track");
  }
  return { arc, svg, track };
}

function arcShare(html: string): number {
  const offset = DASH_OFFSET.exec(html)?.[1];
  expect(offset).toBeDefined();
  return 1 - Number(offset) / CIRCUMFERENCE;
}

afterEach(() => {
  for (const unmount of mounted.splice(0)) {
    unmount();
  }
});

describe("ProgressRing", () => {
  it("draws a third of the circle with 1 of 3 and two thirds with 2 of 3", () => {
    expect(
      arcShare(renderToStaticMarkup(<ProgressRing done={1} total={3} />))
    ).toBeCloseTo(1 / 3, 5);
    expect(
      arcShare(renderToStaticMarkup(<ProgressRing done={2} total={3} />))
    ).toBeCloseTo(2 / 3, 5);
  });

  it("keeps the arc between nothing and the whole circle", () => {
    expect(ringOffset(0, 3)).toBeCloseTo(CIRCUMFERENCE, 5);
    expect(ringOffset(3, 3)).toBeCloseTo(0, 5);
    expect(ringOffset(5, 3)).toBeCloseTo(0, 5);
    expect(ringOffset(-1, 3)).toBeCloseTo(CIRCUMFERENCE, 5);
    expect(ringOffset(1, 0)).toBeCloseTo(CIRCUMFERENCE, 5);
  });

  it("is a 16 px drawing with a stroke of 2, hidden from the reader, on the colors of the tokens", () => {
    const { arc, svg, track } = renderRing();
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("viewBox")).toBe("0 0 16 16");
    expect(svg.classList.contains("size-4")).toBe(true);
    expect(arc.getAttribute("stroke-width")).toBe("2");
    expect(track.getAttribute("stroke-width")).toBe("2");
    expect(track.classList.contains("stroke-primary/15")).toBe(true);
    expect(track.classList.contains("stroke-primary")).toBe(false);
    expect(arc.classList.contains("stroke-primary")).toBe(true);
    expect(arc.classList.contains("stroke-primary/15")).toBe(false);
    const everyClass = [...svg.querySelectorAll("*"), svg].flatMap((node) => [
      ...node.classList,
    ]);
    expect(everyClass.some((name) => name.includes("stroke-muted"))).toBe(
      false
    );
  });

  it("moves its arc only where the interface moves, once and in 300 ms", () => {
    const { arc, svg, track } = renderRing();
    for (const name of ARC_MOTION_CLASSES) {
      expect(arc.classList.contains(name)).toBe(true);
    }
    const everyClass = [...svg.classList, ...arc.classList, ...track.classList];
    const outsideFull = everyClass.filter(
      (name) =>
        !name.startsWith("motion-full:") && MOTION_OUTSIDE_FULL.test(name)
    );
    expect(outsideFull).toEqual([]);
    expect(
      [...track.classList].some((name) => name.includes("motion-full:"))
    ).toBe(false);
  });
});
