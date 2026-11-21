/// <reference lib="dom" />
import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";

function firstFamily(target: Locator): Promise<string> {
  return target.first().evaluate((element) => {
    const stack = getComputedStyle(element).fontFamily;
    return (stack.split(",")[0] ?? "").replaceAll('"', "").trim();
  });
}

export function familiesOf(target: Locator): Promise<string[]> {
  return target.evaluateAll((elements) =>
    elements.map((element) =>
      (getComputedStyle(element).fontFamily.split(",")[0] ?? "")
        .replaceAll('"', "")
        .trim()
    )
  );
}

export const MONO = "Geist Mono Variable";
const SANS = "Geist Variable";

export async function expectMono(target: Locator, what: string) {
  await expect(target.first(), `${what} existe`).toBeVisible();
  expect(await firstFamily(target), `${what} em Geist Mono`).toBe(MONO);
}

export async function expectGeist(target: Locator, what: string) {
  await expect(target.first(), `${what} existe`).toBeVisible();
  expect(await firstFamily(target), `${what} em Geist`).toBe(SANS);
}

export function fontsLoaded(page: Page) {
  return page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts]
      .filter((face) => face.family.includes("Geist Mono"))
      .map((face) => face.status);
  });
}

/** Not `buffered`: only shifts after the call are counted. */
export function watchShifts(page: Page) {
  return page.evaluate(() => {
    const shifts = { total: 0 };
    (window as unknown as { __shifts: typeof shifts }).__shifts = shifts;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & { value: number };
        shifts.total += shift.value;
      }
    }).observe({ type: "layout-shift" });
  });
}

export function shiftsSoFar(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as unknown as { __shifts?: { total: number } }).__shifts?.total ??
      Number.NaN
  );
}

/** The file is the hashed asset of the build, hence the glob. */
export async function holdMonoFont(page: Page) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = 0;
  await page.route("**/assets/geist-mono-*.woff2", async (route) => {
    held += 1;
    await gate;
    await route.continue();
  });
  return {
    get held() {
      return held;
    },
    release,
  };
}
