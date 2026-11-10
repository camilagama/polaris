import { describe, expect, it } from "vitest";
import { resolveTooltipTarget } from "../bklit/charts/tooltip/tooltip-box";
import { panelPlacement, TOOLTIP_OFFSET } from "./sales-heatmap";

const WIDTH = 292;
const PANEL = 164;
const OFFSET = TOOLTIP_OFFSET;

/** Where `TooltipBox` puts the panel for the `x` and `flipX` it is given: its own rule, not a copy of it. */
function panelLeft(
  placed: { flipX?: number; x: number },
  panelWidth: number,
  containerWidth: number
) {
  return resolveTooltipTarget({
    containerHeight: 1000,
    containerWidth,
    flipX: placed.flipX,
    height: 80,
    offset: OFFSET,
    width: panelWidth,
    x: placed.x,
    y: 40,
  }).left;
}

describe("panelPlacement", () => {
  it("leaves the cell's own x when a side has room", () => {
    expect(
      panelPlacement({ containerWidth: WIDTH, panelWidth: PANEL, x: 30 })
    ).toEqual({ x: 30 });
    expect(
      panelPlacement({ containerWidth: WIDTH, panelWidth: PANEL, x: 280 })
    ).toEqual({ x: 280 });
  });

  it("puts the panel inside the map for a cell in any column", () => {
    for (const panelWidth of [120, PANEL, 200, WIDTH - 1]) {
      for (let x = 0; x <= WIDTH; x += 1) {
        const placed = panelPlacement({
          containerWidth: WIDTH,
          panelWidth,
          x,
        });
        const left = panelLeft(placed, panelWidth, WIDTH);
        expect(left, `x ${x}, painel ${panelWidth}`).toBeGreaterThanOrEqual(0);
        expect(
          left + panelWidth,
          `x ${x}, painel ${panelWidth}`
        ).toBeLessThanOrEqual(WIDTH);
      }
    }
  });

  it("centers on the cell when it can and rests on an edge when it cannot", () => {
    const middle = panelPlacement({
      containerWidth: WIDTH,
      panelWidth: PANEL,
      x: 146,
    });
    expect(panelLeft(middle, PANEL, WIDTH)).toBe(146 - PANEL / 2);
    const wide = 250;
    const nearLeft = panelPlacement({
      containerWidth: WIDTH,
      panelWidth: wide,
      x: 100,
    });
    expect(panelLeft(nearLeft, wide, WIDTH)).toBe(0);
    const nearRight = panelPlacement({
      containerWidth: WIDTH,
      panelWidth: wide,
      x: 200,
    });
    expect(panelLeft(nearRight, wide, WIDTH)).toBe(WIDTH - wide);
  });

  it("keeps the left edge of a panel wider than the map on the map's", () => {
    const placed = panelPlacement({
      containerWidth: 200,
      panelWidth: 260,
      x: 100,
    });
    expect(panelLeft(placed, 260, 200)).toBe(0);
  });
});
