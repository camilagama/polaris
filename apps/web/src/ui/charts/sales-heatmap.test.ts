import { describe, expect, it } from "vitest";
import { resolveTooltipTarget } from "../bklit/charts/tooltip/tooltip-box";
import {
  panelPlacement,
  READ_RING_WIDTH,
  ringOffset,
  ringGeometry,
  ringsOf,
  TODAY_RING_WIDTH,
  TOOLTIP_OFFSET,
} from "./sales-heatmap";

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

const SIZES = [
  { cell: 12, gap: 3 },
  { cell: 13, gap: 3 },
  { cell: 14, gap: 4 },
  { cell: 15, gap: 4 },
  { cell: 16, gap: 4 },
] as const;

const cellAt = (index: number, { cell, gap }: (typeof SIZES)[number]) => ({
  height: cell,
  width: cell,
  x: Math.floor(index / 7) * (cell + gap),
  y: (index % 7) * (cell + gap) + gap,
});

describe("ringsOf", () => {
  it("rests with one ring, today's, 1 px", () => {
    expect(ringsOf({ focus: null, today: 40 })).toEqual([
      { index: 40, kind: "today", strokeWidth: 1 },
    ]);
    expect(TODAY_RING_WIDTH).toBe(1);
  });

  it("reading another day adds a ring of 1.5 px for it and keeps today's", () => {
    expect(ringsOf({ focus: 12, today: 40 })).toEqual([
      { index: 40, kind: "today", strokeWidth: 1 },
      { index: 12, kind: "read", strokeWidth: 1.5 },
    ]);
    expect(READ_RING_WIDTH).toBe(1.5);
  });

  it("gives a square at most one ring: reading today leaves only the read one", () => {
    expect(ringsOf({ focus: 40, today: 40 })).toEqual([
      { index: 40, kind: "read", strokeWidth: 1.5 },
    ]);
    for (const focus of [null, 0, 39, 40, 41, 181]) {
      const indexes = ringsOf({ focus, today: 40 }).map((ring) => ring.index);
      expect(new Set(indexes).size).toBe(indexes.length);
    }
  });

  it("has no ring of 2 px or more for any state", () => {
    for (const focus of [null, 3, 40]) {
      for (const ring of ringsOf({ focus, today: 40 })) {
        expect(ring.strokeWidth).toBeLessThan(2);
      }
    }
  });
});

describe("ringGeometry", () => {
  it("is a rectangle half the gap out of the cell with a corner of 4, for every size of the map", () => {
    for (const size of SIZES) {
      const cell = cellAt(180, size);
      const offset = size.gap / 2;
      expect(ringOffset(size.gap)).toBe(offset);
      expect(ringGeometry(cell, 1, size.gap).rect).toEqual({
        height: size.cell + 2 * offset,
        rx: 4,
        width: size.cell + 2 * offset,
        x: cell.x - offset,
        y: cell.y - offset,
      });
    }
  });

  it("keeps the stroke 0.5 px or more from every neighboring cell, for each ring, every cell and every size", () => {
    const total = 26 * 7;
    for (const size of SIZES) {
      for (const strokeWidth of [TODAY_RING_WIDTH, READ_RING_WIDTH]) {
        for (let index = 0; index < total; index += 1) {
          const { outer } = ringGeometry(
            cellAt(index, size),
            strokeWidth,
            size.gap
          );
          for (const other of [index - 7, index + 7, index - 1, index + 1]) {
            const acrossColumns =
              Math.floor(other / 7) !== Math.floor(index / 7);
            const sideways = Math.abs(other - index) === 7;
            if (other < 0 || other >= total || (acrossColumns && !sideways)) {
              continue;
            }
            const next = cellAt(other, size);
            const dx = Math.max(
              next.x - outer.right,
              outer.left - (next.x + next.width)
            );
            const dy = Math.max(
              next.y - outer.bottom,
              outer.top - (next.y + next.height)
            );
            expect(
              Math.max(dx, dy),
              `célula ${index}, vizinha ${other}, traço ${strokeWidth}, célula de ${size.cell} px`
            ).toBeGreaterThanOrEqual(0.5);
          }
        }
      }
    }
  });

  it("covers at most 2.25 px outside the cell inside a gap of 3, and 2.75 px inside a gap of 4", () => {
    for (const [size, reach] of [
      [SIZES[0], 2.25],
      [SIZES[4], 2.75],
    ] as const) {
      const cell = cellAt(0, size);
      const { outer } = ringGeometry(cell, READ_RING_WIDTH, size.gap);
      expect(cell.x - outer.left).toBeCloseTo(reach);
      expect(outer.right - (cell.x + cell.width)).toBeCloseTo(reach);
      expect(cell.x - outer.left).toBeLessThan(size.gap);
    }
  });
});
