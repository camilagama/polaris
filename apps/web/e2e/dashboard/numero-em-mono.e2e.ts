/// <reference lib="dom" />

import { expect, test } from "@playwright/test";
import {
  expectGeist,
  expectMono,
  familiesOf,
  fontsLoaded,
  holdMonoFont,
  MONO,
  shiftsSoFar,
  watchShifts,
} from "../mono-face";
import {
  chain,
  chainRow,
  FakeReportServer,
  kpiCards,
  openDashboard,
  placeOf,
} from "./shared";

const REAIS = /R\$/;
const SIZES = [
  { height: 740, width: 360 },
  { height: 800, width: 1280 },
] as const;

test.describe("o visor em Geist Mono no Resultado (AC-1)", () => {
  for (const { height, width } of SIZES) {
    test(`o número dos quatro cartões e o percentual do chip ficam em Geist Mono, e a cadeia em Geist, a ${width} px`, async ({
      page,
    }) => {
      await page.setViewportSize({ height, width });
      await openDashboard(page, new FakeReportServer());
      await expect(kpiCards(page)).toHaveCount(4);
      const values = page.locator("[data-kpi-row] [data-kpi-value]");
      await expect(values).toHaveCount(4);
      expect(await familiesOf(values), "o número dos quatro cartões").toEqual([
        MONO,
        MONO,
        MONO,
        MONO,
      ]);
      await expectMono(
        page.locator("[data-kpi-row] [data-kpi-delta] [data-kpi-delta-text]"),
        "o percentual do chip"
      );
      await expectGeist(
        chainRow(page, "Vendas brutas").first(),
        "a linha da cadeia"
      );
      await expectGeist(chain(page), "o bloco da cadeia");
    });
  }
});

test.describe("a chegada tardia da Geist Mono no Resultado (AC-4)", () => {
  for (const { height, width } of SIZES) {
    test(`a troca da face de reserva para a Geist Mono muda o número em até 2% e não move o cartão a ${width} px`, async ({
      page,
    }) => {
      await page.setViewportSize({ height, width });
      const mono = await holdMonoFont(page);
      await openDashboard(page, new FakeReportServer());
      await expect(kpiCards(page)).toHaveCount(4);
      await expect(
        page.locator("[data-kpi-row] [data-kpi-value]").first()
      ).toHaveText(REAIS);
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
