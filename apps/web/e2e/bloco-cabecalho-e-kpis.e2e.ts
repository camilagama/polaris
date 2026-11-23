/// <reference lib="dom" />

import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  card,
  chartRegion,
  chain,
  FakeReportServer,
  kpiCards,
  openDashboard,
} from "./dashboard/shared";
import { FakeServer, openHome, region, SOLD, settled } from "./home/shared";

const SIZES = [
  { height: 740, width: 360 },
  { height: 800, width: 1280 },
] as const;

const ABOUT_BUTTON = /^Sobre /;
const SALES_LINK = /^Ver as \d+ vendas de /;

const HEADER = '[data-slot="block-header"]';

interface HeaderBox {
  height: number;
  rightAfterTitle: boolean | null;
  sameRow: boolean | null;
}

const headerOf = (block: Locator): Promise<HeaderBox> =>
  block
    .locator(HEADER)
    .first()
    .evaluate((header) => {
      const title = header.querySelector("h2")?.getBoundingClientRect();
      const right = header.children[1]?.getBoundingClientRect();
      return {
        height: header.getBoundingClientRect().height,
        rightAfterTitle: title && right ? right.left >= title.right - 1 : null,
        sameRow:
          title && right
            ? Math.abs(
                title.top + title.height / 2 - (right.top + right.height / 2)
              ) <= title.height
            : null,
      };
    });

const tileHeights = async (page: Page) => {
  await settled(page);
  return kpiCards(page).evaluateAll((cells) =>
    cells.map((cell) => cell.getBoundingClientRect().height)
  );
};

const homeTiles = async (page: Page) => {
  await settled(page);
  return page
    .locator("[data-kpi-row] [data-kpi]")
    .evaluateAll((cells) =>
      cells.map((cell) => cell.getBoundingClientRect().height)
    );
};

test.describe("cabeçalho de bloco e cartões de KPI: o Início e o Resultado têm a mesma altura e a mesma ordem (AC-B3.4, AC-B3.5)", () => {
  for (const size of SIZES) {
    test(`${size.width} px`, async ({ context, page }) => {
      await page.setViewportSize(size);
      await openHome(page, new FakeServer(SOLD));
      const result = await context.newPage();
      await result.setViewportSize(size);
      await openDashboard(result, new FakeReportServer());
      await expect(kpiCards(result)).toHaveCount(4);
      await expect(chartRegion(result).getByRole("img")).toBeVisible();
      await expect(chain(result)).toBeVisible();

      const home = await headerOf(region(page, "Vendas por dia"));
      const chart = await headerOf(chartRegion(result));
      const steps = await headerOf(chain(result));
      expect(chart.height, "o cabeçalho do gráfico do Resultado").toBeCloseTo(
        home.height,
        0
      );
      expect(steps.height, "o cabeçalho de Como chegamos").toBeCloseTo(
        home.height,
        0
      );
      if (size.width >= 760) {
        expect(home.height).toBeGreaterThanOrEqual(36);
        expect(home.height).toBeLessThan(37);
      }

      const rhythm = await headerOf(region(page, "Ritmo de vendas"));
      if (size.width >= 1280) {
        expect(rhythm.height).toBeCloseTo(home.height, 0);
        expect(rhythm.rightAfterTitle, "a legenda depois do título").toBe(true);
        expect(rhythm.sameRow, "a legenda na linha do título").toBe(true);
      }

      const best = await result
        .getByText("Melhor dia")
        .evaluate((line) => line.getBoundingClientRect().height);
      expect(best, "o melhor dia fica só para o leitor de tela").toBeLessThan(
        2
      );

      const homeCells = await homeTiles(page);
      const resultCells = await tileHeights(result);
      expect(resultCells).toHaveLength(4);
      for (const [index, height] of resultCells.entries()) {
        expect(
          height,
          `o cartão ${index} do Resultado tem a altura do primeiro do Início`
        ).toBeCloseTo(homeCells[0] ?? 0, 0);
      }
      await expect(
        card(result, 1).locator("[data-kpi-note-row]"),
        "uma linha de apoio só"
      ).toHaveCount(1);
      await expect(card(result, 1).locator("[data-kpi-notice]")).toHaveCount(0);
    });
  }

  test("o caminho para as vendas do período é o cartão de vendas e se alcança pelo teclado", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await openDashboard(page, new FakeReportServer());
    await expect(kpiCards(page)).toHaveCount(4);
    const sales = card(page, 1);
    const link = sales.getByRole("button", { name: SALES_LINK });
    await expect(link).toBeVisible();
    const hit = await sales.evaluate((tile) => {
      const box = tile.getBoundingClientRect();
      const button = tile.querySelector("[data-kpi-sales-link]");
      const at = (x: number, y: number) =>
        document.elementFromPoint(box.left + x, box.top + y) === button;
      return [
        at(6, box.height - 6),
        at(box.width / 2, box.height - 6),
        at(box.width - 6, box.height - 6),
      ];
    });
    expect(hit, "o botão cobre o cartão nas bordas de baixo").toEqual([
      true,
      true,
      true,
    ]);
    await sales.getByRole("button", { name: ABOUT_BUTTON }).focus();
    await page.keyboard.press("Tab");
    await expect(link).toBeFocused();
  });
});
