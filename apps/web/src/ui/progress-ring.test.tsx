import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProgressRing, ringOffset } from "./progress-ring";

const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const DASH_OFFSET = /stroke-dashoffset:([\d.]+)/;
const MOTION_OUTSIDE_FULL =
  /(?<!motion-full:)(?:transition|duration-|animate-)/;

function arcShare(html: string): number {
  const offset = DASH_OFFSET.exec(html)?.[1];
  expect(offset).toBeDefined();
  return 1 - Number(offset) / CIRCUMFERENCE;
}

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
    const html = renderToStaticMarkup(<ProgressRing done={1} total={3} />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('viewBox="0 0 16 16"');
    expect(html).toContain("size-4");
    expect(html).toContain('stroke-width="2"');
    expect(html).toContain("stroke-primary/15");
    expect(html).not.toContain("stroke-muted");
    expect(html).toContain('class="stroke-primary motion-full:');
  });

  it("moves its arc only where the interface moves, once and in 300 ms", () => {
    const html = renderToStaticMarkup(<ProgressRing done={1} total={3} />);
    expect(html).toContain("motion-full:transition-[stroke-dashoffset]");
    expect(html).toContain("motion-full:duration-300");
    expect(html).toContain("motion-full:ease-out");
    expect(html).not.toMatch(MOTION_OUTSIDE_FULL);
  });
});
