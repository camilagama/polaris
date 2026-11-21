/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

/**
 * The geometry of the rows of the configuration lists (Aparelhos, Formas de receber, Clientes): where each row puts
 * its state badge against its name. `rowSelector` finds the rows. The badge is the first `[data-slot="badge"]` of a
 * row; the name is its first `.font-medium` that is not `aria-hidden`, which leaves out the initials circle of a
 * customer. A row without a badge is skipped.
 */
export interface RowGeometry {
  badge: { bottom: number; left: number; right: number; top: number };
  badgeText: string;
  name: { bottom: number; left: number; right: number; top: number };
  row: { left: number; right: number };
  tile: { height: number; width: number } | null;
}

export async function rowGeometries(
  page: Page,
  rowSelector: string
): Promise<RowGeometry[]> {
  return await page.evaluate((selector) => {
    const box = (element: Element) => {
      const { bottom, left, right, top } = element.getBoundingClientRect();
      return { bottom, left, right, top };
    };
    return [...document.querySelectorAll(selector)].flatMap((row) => {
      const badge = row.querySelector('[data-slot="badge"]');
      const name = row.querySelector(".font-medium:not([aria-hidden])");
      if (badge === null || name === null) {
        return [];
      }
      const tile = row.querySelector("[data-row-tile]");
      return [
        {
          badge: box(badge),
          badgeText: badge.textContent ?? "",
          name: box(name),
          row: {
            left: row.getBoundingClientRect().left,
            right: row.getBoundingClientRect().right,
          },
          tile:
            tile === null
              ? null
              : {
                  height: tile.getBoundingClientRect().height,
                  width: tile.getBoundingClientRect().width,
                },
        },
      ];
    });
  }, rowSelector);
}

/**
 * On a wide window every badge sits on the line of its name, to its right, and all of them end at the same x (AC-1.1,
 * at most 1 px apart).
 */
export function expectBadgesAtRight(rows: readonly RowGeometry[], least = 2) {
  expect(rows.length, "linhas com selo").toBeGreaterThanOrEqual(least);
  for (const { badge, badgeText, name } of rows) {
    expect(badge.left, `${badgeText} à direita do nome`).toBeGreaterThanOrEqual(
      name.right
    );
    expect(badge.top, `${badgeText} na linha do nome`).toBeLessThan(
      name.bottom
    );
  }
  const rights = rows.map(({ badge }) => badge.right);
  expect(
    Math.max(...rights) - Math.min(...rights),
    `o selo termina no mesmo x: ${rights.join(", ")}`
  ).toBeLessThanOrEqual(1);
}

/** On a phone or with a large letter the badge drops under the name, at the left edge of the text (AC-1.4). */
export function expectBadgesBelow(rows: readonly RowGeometry[], least = 1) {
  expect(rows.length, "linhas com selo").toBeGreaterThanOrEqual(least);
  for (const { badge, badgeText, name, row } of rows) {
    expect(badge.top, `${badgeText} sob o nome`).toBeGreaterThanOrEqual(
      name.bottom - 1
    );
    expect(
      Math.abs(badge.left - name.left),
      `${badgeText} alinhado à esquerda do texto`
    ).toBeLessThanOrEqual(1);
    expect(badge.right, `${badgeText} dentro da linha`).toBeLessThanOrEqual(
      row.right + 0.5
    );
  }
}

/** The square of the row is 2.25 rem (36 px with the font at 16) and its icon 1 rem (16 px), with a stroke of 2. */
export async function expectTiles(page: Page, rowSelector: string) {
  const rem = await page.evaluate(() =>
    Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
  );
  const tiles = await page.evaluate(
    (selector) =>
      [...document.querySelectorAll(`${selector} [data-row-tile]`)].map(
        (tile) => {
          const icon = tile.querySelector("svg");
          return {
            icon: icon
              ? {
                  stroke: Number.parseFloat(getComputedStyle(icon).strokeWidth),
                  width: icon.getBoundingClientRect().width,
                }
              : null,
            square: {
              height: tile.getBoundingClientRect().height,
              width: tile.getBoundingClientRect().width,
            },
          };
        }
      ),
    rowSelector
  );
  expect(tiles.length, "quadros desenhados").toBeGreaterThan(0);
  for (const { icon, square } of tiles) {
    expect(square).toEqual({ height: 2.25 * rem, width: 2.25 * rem });
    expect(icon).toEqual({ stroke: 2, width: rem });
  }
}
