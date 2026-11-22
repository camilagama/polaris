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

/** Every element the locator finds is in Geist Mono: each number of a list, not only the first. */
export async function expectAllMono(target: Locator, what: string) {
  await expect(target.first(), `${what} existe`).toBeVisible();
  const families = await familiesOf(target);
  expect(
    families.filter((family) => family !== MONO),
    `${what}: ${families.length} em Geist Mono`
  ).toEqual([]);
}

export async function expectGeist(target: Locator, what: string) {
  await expect(target.first(), `${what} existe`).toBeVisible();
  expect(await firstFamily(target), `${what} em Geist`).toBe(SANS);
}

const MONO_FACE = "Geist Mono Variable";

export function monoFaceStatus(page: Page) {
  return page.evaluate(
    (family) =>
      [...document.fonts]
        .filter((face) => face.family.replaceAll('"', "") === family)
        .map((face) => face.status),
    MONO_FACE
  );
}

export function fontsLoaded(page: Page) {
  return page.evaluate(async (family) => {
    await document.fonts.ready;
    return [...document.fonts]
      .filter((face) => face.family.replaceAll('"', "") === family)
      .map((face) => face.status);
  }, MONO_FACE);
}

/** Not `buffered`: only shifts after the call are counted. */
export function watchShifts(page: Page) {
  return page.evaluate(() => {
    const shifts = { total: 0 };
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        shifts.total += (entry as PerformanceEntry & { value: number }).value;
      }
    });
    observer.observe({ type: "layout-shift" });
    Object.assign(window, { __shiftObserver: observer, __shifts: shifts });
  });
}

/** The shifts since `watchShifts`, after two frames and the records the observer still holds. */
export function shiftsSoFar(page: Page): Promise<number> {
  return page.evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );
    const held = window as unknown as {
      __shiftObserver?: PerformanceObserver;
      __shifts?: { total: number };
    };
    for (const entry of held.__shiftObserver?.takeRecords() ?? []) {
      if (held.__shifts) {
        held.__shifts.total += (
          entry as PerformanceEntry & { value: number }
        ).value;
      }
    }
    return held.__shifts?.total ?? Number.NaN;
  });
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
