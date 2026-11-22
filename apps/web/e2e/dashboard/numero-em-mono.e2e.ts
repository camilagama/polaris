/// <reference lib="dom" />

import { expect, test } from "@playwright/test";
import {
  expectAllMono,
  expectGeist,
  expectMono,
  familiesOf,
  MONO,
} from "../mono-face";
import {
  chain,
  chainRow,
  chartRegion,
  FakeReportServer,
  kpiCards,
  openDashboard,
} from "./shared";

const SIZES = [
  { height: 740, width: 360 },
  { height: 800, width: 1280 },
] as const;

test.describe("todo valor e toda quantidade do Resultado em Geist Mono (AC-B1.1)", () => {
  for (const { height, width } of SIZES) {
    test(`os totais do gráfico, os valores da cadeia e as partes dos custos ficam em Geist Mono, e os nomes em Geist, a ${width} px`, async ({
      page,
    }) => {
      await page.setViewportSize({ height, width });
      await openDashboard(page, new FakeReportServer());
      await expectAllMono(
        chartRegion(page).locator("dd > span"),
        "os totais do gráfico"
      );
      await expectGeist(
        chartRegion(page).locator("dt").first(),
        "o nome do total"
      );
      await expectAllMono(
        chain(page).locator("tbody td > span:not(.sr-only)"),
        "os valores da cadeia"
      );
      await expectGeist(
        chainRow(page, "Vendas brutas").locator("th"),
        "o nome da linha"
      );
      await expectAllMono(
        chain(page).locator("li [data-figure]"),
        "o percentual de cada parte dos custos"
      );
    });
  }
});

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
