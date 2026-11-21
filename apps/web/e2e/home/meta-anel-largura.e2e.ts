/// <reference lib="dom" />

import type { Locator } from "@playwright/test";
import { expect } from "@playwright/test";
import {
  assertNoPageScroll,
  assertNothingClipped,
  expectReflowFont,
  openReflowViewport,
  reflowTest,
  skipOutsideChromium,
} from "../reflow";
import { FakeServer, goal, openHome, region, SOLD } from "./shared";

skipOutsideChromium();

const HOLE_SHARE = 4.75 / 7;
const SIDE_ROOM = 2;

const PERCENTS = [
  ["100.0", "100,0%"],
  ["1250.0", "1250,0%"],
  ["12500.0", "12500,0%"],
] as const;

const SIZES = [
  { fontPixels: 16, width: 320 },
  { fontPixels: 16, width: 360 },
  { fontPixels: 20, width: 320 },
  { fontPixels: 20, width: 360 },
] as const;

const withPercent = (percent: string) =>
  new FakeServer({
    ...SOLD,
    goals: [
      goal({
        progress: {
          percent,
          periodEnded: false,
          reached: false,
          value: "2670.60",
        },
      }),
    ],
  });

async function readRing(meta: Locator) {
  return await meta.locator("[data-goal-ring]").evaluate((ring) => {
    const text = ring.querySelector("span[aria-hidden=true] > span");
    if (!text?.firstChild) {
      throw new Error("the percent of the ring is not there");
    }
    const range = document.createRange();
    range.selectNodeContents(text);
    const written = range.getBoundingClientRect();
    const box = ring.getBoundingClientRect();
    return {
      fontPixels: Number.parseFloat(getComputedStyle(text).fontSize),
      ringHeight: box.height,
      ringLeft: box.left,
      ringWidth: box.width,
      textLeft: written.left,
      textRight: written.right,
    };
  });
}

for (const { fontPixels, width } of SIZES) {
  for (const [percent, written] of PERCENTS) {
    reflowTest(
      `${written} fica dentro do furo do anel da Meta a ${width} px com a letra em ${fontPixels} px`,
      async ({ page }) => {
        await openReflowViewport(page, { fontPixels, width });
        await openHome(page, withPercent(percent));
        await expectReflowFont(page, fontPixels);
        const meta = region(page, "Meta");
        const ring = meta.locator("[data-goal-ring]");
        await expect(ring).toContainText(written);
        await expect
          .poll(async () => (await readRing(meta)).ringWidth, {
            message: "the ring takes 7 rem",
          })
          .toBeCloseTo(7 * fontPixels, 0);
        const read = await readRing(meta);
        const hole = read.ringWidth * HOLE_SHARE;
        const holeLeft = read.ringLeft + (read.ringWidth - hole) / 2;
        expect(
          read.textLeft - holeLeft,
          `${written}: room on the left of the hole`
        ).toBeGreaterThanOrEqual(SIDE_ROOM);
        expect(
          holeLeft + hole - read.textRight,
          `${written}: room on the right of the hole`
        ).toBeGreaterThanOrEqual(SIDE_ROOM);
        await assertNothingClipped(meta);
        await assertNoPageScroll(page);
      }
    );
  }
}

reflowTest(
  "o anel mede 112 px com a letra em 16 px e o percentual segue em text-xl até 100,0%",
  async ({ page }) => {
    await openReflowViewport(page, { fontPixels: 16, width: 360 });
    await openHome(page, withPercent("100.0"));
    const meta = region(page, "Meta");
    await expect(meta.locator("[data-goal-ring]")).toContainText("100,0%");
    const read = await readRing(meta);
    expect(Math.abs(read.ringWidth - 112)).toBeLessThanOrEqual(1);
    expect(Math.abs(read.ringHeight - 112)).toBeLessThanOrEqual(1);
    expect(read.fontPixels).toBeCloseTo(20, 1);
  }
);

const HEIGHTS_AT_16 = [
  { expected: 220, height: 740, width: 360 },
  { expected: 236, height: 800, width: 760 },
  { expected: 368, height: 800, width: 1280 },
] as const;

for (const { expected, height, width } of HEIGHTS_AT_16) {
  reflowTest(
    `o bloco da Meta mede ${expected} px a ${width} px com a letra em 16 px, a altura de antes do anel em rem`,
    async ({ page }) => {
      await openReflowViewport(page, { fontPixels: 16, height, width });
      await openHome(page, withPercent("53.4"));
      const meta = region(page, "Meta");
      await expect(meta.locator("[data-goal-ring]")).toContainText("53,4%");
      const box = await meta.boundingBox();
      expect(Math.abs((box?.height ?? 0) - expected)).toBeLessThanOrEqual(1);
    },
    { coarse: width < 760 }
  );
}

async function ringAndText(meta: Locator) {
  return await meta.locator("[data-goal-ring]").evaluate((ring) => {
    const text = ring.nextElementSibling;
    if (!text) {
      throw new Error("the text beside the ring is not there");
    }
    const ringBox = ring.getBoundingClientRect();
    const textBox = text.getBoundingClientRect();
    return {
      ringBottom: ringBox.bottom,
      ringRight: ringBox.right,
      textLeft: textBox.left,
      textTop: textBox.top,
    };
  });
}

reflowTest(
  "a 360 px com a letra em 16 px o anel fica ao lado do texto",
  async ({ page }) => {
    await openReflowViewport(page, { fontPixels: 16, width: 360 });
    await openHome(page, withPercent("53.4"));
    const meta = region(page, "Meta");
    await expect(meta.locator("[data-goal-ring]")).toContainText("53,4%");
    const read = await ringAndText(meta);
    expect(read.textLeft).toBeGreaterThanOrEqual(read.ringRight - 1);
    expect(read.textTop).toBeLessThan(read.ringBottom);
  }
);

reflowTest(
  "a 320 px com a letra em 20 px o anel de 140 px vai para cima do texto e nada rola de lado",
  async ({ page }) => {
    await openReflowViewport(page, { fontPixels: 20, width: 320 });
    await openHome(page, withPercent("53.4"));
    await expectReflowFont(page, 20);
    const meta = region(page, "Meta");
    await expect(meta.locator("[data-goal-ring]")).toContainText("53,4%");
    const read = await ringAndText(meta);
    expect(read.textTop).toBeGreaterThanOrEqual(read.ringBottom - 1);
    await assertNothingClipped(meta);
    await assertNoPageScroll(page);
  }
);
