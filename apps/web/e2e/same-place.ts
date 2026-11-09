/// <reference lib="dom" />
import type { Locator } from "@playwright/test";
import { expect } from "@playwright/test";

/** The most a fixed part of a screen may move between two states of its list, in pixels. */
export const SAME_PLACE = 1;

export type Places = Record<string, { left: number; top: number }>;

/** Where each part sits on the page (not on the window, so a scroll does not count as a move). */
export async function placesOf(
  parts: Record<string, Locator>
): Promise<Places> {
  const found = await Promise.all(
    Object.entries(parts).map(async ([name, locator]) => {
      const place = await locator.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return { left: box.left + scrollX, top: box.top + scrollY };
      });
      return [name, place] as const;
    })
  );
  return Object.fromEntries(found);
}

/** The parts stayed where they were: the screen did not jump when the list changed state. */
export function expectSamePlaces(state: string, before: Places, after: Places) {
  for (const [name, place] of Object.entries(before)) {
    const now = after[name];
    expect(now, `${name} existe ${state}`).toBeDefined();
    expect(
      Math.abs((now?.top ?? Number.NaN) - place.top),
      `${name}, em cima, ${state}`
    ).toBeLessThanOrEqual(SAME_PLACE);
    expect(
      Math.abs((now?.left ?? Number.NaN) - place.left),
      `${name}, à esquerda, ${state}`
    ).toBeLessThanOrEqual(SAME_PLACE);
  }
}
