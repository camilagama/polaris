/// <reference lib="dom" />

import { expect, test } from "@playwright/test";
import {
  FakeReportServer,
  kpiCards,
  openDashboard,
  placeOf,
} from "./dashboard/shared";
import { alone, FakeServer, openHome, region, settled } from "./home/shared";
import {
  fontsLoaded,
  holdMonoFont,
  monoFaceStatus,
  shiftsSoFar,
  watchShifts,
} from "./mono-face";

/**
 * The first visit with Geist Mono late (UX-refs corte 06, AC-4): the page is drawn in "Geist Mono Fallback" and the
 * swap moves nothing. Without hinting the advance of each glyph is fractional, as on Mac, Windows and Android: the proof
 * is the metric of the font, not the integer rounding of the Chromium of Linux, which flips by a pixel per glyph
 * when the size lands near a half pixel.
 */
test.use({ launchOptions: { args: ["--font-render-hinting=none"] } });

const REAIS_RE = /R\$/;
const LATE_SIZES = [
  { height: 740, width: 360 },
  { height: 800, width: 1280 },
] as const;

test.describe("a chegada tardia da Geist Mono no Início (AC-4)", () => {
  for (const { height, width } of [
    { height: 740, width: 360 },
    { height: 800, width: 1280 },
  ]) {
    test(`a troca da face de reserva para a Geist Mono muda o número em até 2% e o CLS fica em 0,01, a ${width} px`, async ({
      page,
    }) => {
      await page.setViewportSize({ height, width });
      const mono = await holdMonoFont(page);
      await openHome(page, new FakeServer(alone(9_964_035)));
      const principal = region(page, "Vendas hoje");
      await expect(principal.locator("[data-kpi-value]")).toHaveText(
        "R$ 99.640,35",
        { timeout: 20_000 }
      );
      await settled(page);
      expect(mono.held, "a fonte foi retida").toBeGreaterThan(0);
      const measure = () =>
        page.locator("[data-kpi-value]").evaluateAll((nodes) =>
          nodes.map((node) => ({
            height: node.getBoundingClientRect().height,
            top: node.getBoundingClientRect().top + window.scrollY,
            width: (node.firstElementChild ?? node).getBoundingClientRect()
              .width,
          }))
        );
      const before = await measure();
      await watchShifts(page);
      expect(
        await monoFaceStatus(page),
        "a Geist Mono ainda não chegou: a página está na face de reserva"
      ).not.toContain("loaded");
      mono.release();
      await expect
        .poll(async () =>
          (await fontsLoaded(page)).every((s) => s === "loaded")
        )
        .toBe(true);
      await settled(page);
      const after = await measure();
      expect(await shiftsSoFar(page)).toBeLessThanOrEqual(0.01);
      expect(after.length).toBe(before.length);
      for (const [index, then] of before.entries()) {
        const now = after[index];
        expect(
          Math.abs((now?.width ?? 0) - then.width) / then.width,
          `a largura do número ${index + 1} mudou mais de 2%: ${then.width} para ${now?.width}`
        ).toBeLessThanOrEqual(0.02);
        expect(Math.abs((now?.top ?? 0) - then.top)).toBeLessThanOrEqual(1);
        expect(Math.abs((now?.height ?? 0) - then.height)).toBeLessThanOrEqual(
          1
        );
      }
    });
  }
});

test.describe("a chegada tardia da Geist Mono no Resultado (AC-4)", () => {
  for (const { height, width } of LATE_SIZES) {
    test(`a troca da face de reserva para a Geist Mono muda o número em até 2% e não move o cartão a ${width} px`, async ({
      page,
    }) => {
      await page.setViewportSize({ height, width });
      const mono = await holdMonoFont(page);
      await openDashboard(page, new FakeReportServer());
      await expect(kpiCards(page)).toHaveCount(4);
      await expect(
        page.locator("[data-kpi-row] [data-kpi-value]").first()
      ).toHaveText(REAIS_RE);
      expect(mono.held, "a fonte foi retida").toBeGreaterThan(0);
      const widths = () =>
        page
          .locator("[data-kpi-row] [data-kpi-value]")
          .evaluateAll((nodes) =>
            nodes.map(
              (node) =>
                (node.firstElementChild ?? node).getBoundingClientRect().width
            )
          );
      const before = await widths();
      const cardBefore = await placeOf(kpiCards(page).first());
      await watchShifts(page);
      expect(
        await monoFaceStatus(page),
        "a Geist Mono ainda não chegou: a página está na face de reserva"
      ).not.toContain("loaded");
      mono.release();
      await expect
        .poll(async () =>
          (await fontsLoaded(page)).every((s) => s === "loaded")
        )
        .toBe(true);
      const after = await widths();
      const cardAfter = await placeOf(kpiCards(page).first());
      expect(await shiftsSoFar(page)).toBeLessThanOrEqual(0.01);
      expect(
        Math.abs(cardAfter.height - cardBefore.height)
      ).toBeLessThanOrEqual(1);
      expect(Math.abs(cardAfter.top - cardBefore.top)).toBeLessThanOrEqual(1);
      for (const [index, then] of before.entries()) {
        expect(
          Math.abs((after[index] ?? 0) - then) / then,
          `a largura do número ${index + 1} mudou mais de 2%`
        ).toBeLessThanOrEqual(0.02);
      }
    });
  }
});
