/// <reference lib="dom" />

import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { FakeServer, openHome, region, SOLD } from "../home/shared";
import {
  chain,
  chartRegion,
  FakeReportServer,
  kpiCards,
  openDashboard,
  placeOf,
  settled,
} from "./shared";

const SIZES = [
  { height: 740, width: 360 },
  { height: 800, width: 1280 },
] as const;

const AREA = "[data-chart-area]";
const EXPENSES = /^Ver despesas/;

const heightOf = (locator: Locator) =>
  locator.evaluate((element) => element.getBoundingClientRect().height);

const rightEdges = (block: Locator) =>
  block.evaluate((card) =>
    [...card.querySelectorAll("tbody td")]
      .filter((cell) => cell.querySelector("[data-figure]"))
      .map((cell) => {
        const figure = cell.querySelector("[data-figure]");
        const range = document.createRange();
        range.selectNodeContents(figure as Element);
        return Math.round(range.getBoundingClientRect().right * 10) / 10;
      })
  );

const noSideScroll = (page: Page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth <=
      document.documentElement.clientWidth
  );

async function bothScreens(
  page: Page,
  context: import("@playwright/test").BrowserContext,
  size: (typeof SIZES)[number]
) {
  await page.setViewportSize(size);
  await openHome(page, new FakeServer(SOLD));
  const result = await context.newPage();
  await result.setViewportSize(size);
  await openDashboard(result, new FakeReportServer());
  await expect(kpiCards(result)).toHaveCount(4);
  await expect(chartRegion(result).getByRole("img")).toBeVisible();
  await expect(chain(result)).toBeVisible();
  await expect(region(page, "Vendas por dia").locator(AREA)).toBeVisible();
  await settled(page);
  await settled(result);
  return result;
}

test.describe("o Resultado no padrão do Início (AC-C3.1, AC-C3.3)", () => {
  for (const size of SIZES) {
    test(`${size.width} px: a área do gráfico tem a altura da do Início e a legenda mora no cabeçalho`, async ({
      context,
      page,
    }) => {
      const result = await bothScreens(page, context, size);
      const home = region(page, "Vendas por dia");
      const chart = chartRegion(result);
      const homeArea = await heightOf(home.locator(AREA));
      const resultArea = await heightOf(chart.locator(AREA));
      expect(resultArea, "a área do gráfico").toBeCloseTo(homeArea, 0);

      const legend = chart.locator(
        '[data-slot="block-header"] [data-chart-legend]'
      );
      await expect(legend).toBeVisible();
      await expect(legend).toContainText("Vendas líquidas");
      await expect(legend).toContainText("Custos (CMV, taxas e despesas)");
      await expect(
        chart.locator("[data-chart-legend]"),
        "a legenda existe uma vez só, no cabeçalho"
      ).toHaveCount(1);
      await expect(chart.locator("[data-chart-reading]")).toHaveCount(0);
      await expect(chart.locator("[data-chart-data-table]")).toHaveCount(1);
    });
  }
});

test.describe("a cor das vendas e dos custos (AC-C3.3)", () => {
  for (const scheme of ["light", "dark"] as const) {
    test(`tema ${scheme}`, async ({ context, page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const size = { height: 800, width: 1280 } as const;
      const result = await bothScreens(page, context, size);
      await result.emulateMedia({ colorScheme: scheme });
      const stroke = (block: Locator) =>
        block.evaluate((card) => {
          const sales = document.createElement("i");
          sales.style.color = "var(--chart-sales)";
          card.append(sales);
          const token = getComputedStyle(sales).color;
          sales.remove();
          const paths = [
            ...card.querySelectorAll(`${"[data-chart-area]"} path`),
          ]
            .map((path) => getComputedStyle(path))
            .flatMap((style) => [style.stroke, style.fill]);
          return { paths, token };
        });
      const home = await stroke(region(page, "Vendas por dia"));
      const chart = await stroke(chartRegion(result));
      expect(home.token).toBe(chart.token);
      expect(
        chart.paths.some((paint) => paint === home.token),
        "alguma linha do gráfico do Resultado usa a cor das vendas"
      ).toBe(true);
      expect(
        home.paths.some((paint) => paint === home.token),
        "alguma linha do gráfico do Início usa a cor das vendas"
      ).toBe(true);
      const swatches = await chartRegion(result)
        .locator("[data-chart-legend] line")
        .evaluateAll((lines) =>
          lines.map((line) => getComputedStyle(line).stroke)
        );
      expect(swatches[0]).toBe(home.token);
      expect(swatches[1], "custos em --chart-context").not.toBe(home.token);
    });
  }
});

test.describe("o espaço entre os blocos (item 4)", () => {
  test("1280 px: o mesmo intervalo entre um bloco e o seguinte nas duas telas", async ({
    context,
    page,
  }) => {
    const result = await bothScreens(page, context, SIZES[1]);
    const gaps = (screen: Page) =>
      screen
        .locator("[data-kpi-row]")
        .first()
        .evaluate((row) => {
          const visible = (parent: Element | null) =>
            [...(parent?.children ?? [])].filter(
              (block) => block.getBoundingClientRect().height > 0
            );
          let at: Element = row;
          while (at.parentElement && visible(at.parentElement).length < 2) {
            at = at.parentElement;
          }
          const blocks = visible(at.parentElement);
          return blocks
            .slice(1)
            .map((block, index) =>
              Math.round(
                block.getBoundingClientRect().top -
                  (blocks[index] as Element).getBoundingClientRect().bottom
              )
            );
        });
    const home = await gaps(page);
    const shown = await gaps(result);
    expect(home[0], "o Início: da faixa de KPI ao bloco seguinte").toBe(16);
    expect(shown.length).toBeGreaterThanOrEqual(3);
    expect(new Set(shown), "o Resultado: todo intervalo entre blocos").toEqual(
      new Set([home[0]])
    );
  });
});

test.describe("Como chegamos: todo valor termina no mesmo x (AC-C3.4)", () => {
  for (const width of [320, 360, 1280]) {
    test(`${width} px`, async ({ page }) => {
      await page.setViewportSize({ height: 800, width });
      await openDashboard(page, new FakeReportServer());
      await expect(chain(page)).toBeVisible();
      await settled(page);
      const edges = await rightEdges(chain(page));
      expect(edges.length).toBeGreaterThan(5);
      expect(new Set(edges).size, `bordas: ${edges.join(", ")}`).toBe(1);
      expect(await noSideScroll(page)).toBe(true);
      await expect(
        chain(page).getByRole("link", { name: EXPENSES })
      ).toBeVisible();
      const row = await chain(page)
        .locator("tbody tr")
        .evaluateAll((rows) =>
          rows.map((tr) => tr.getBoundingClientRect().height)
        );
      if (width >= 360) {
        for (const height of row) {
          expect(height).toBeGreaterThanOrEqual(44);
        }
      }
    });
  }
});

test.describe("o esqueleto tem a altura do pronto (AC-C3.5)", () => {
  for (const size of SIZES) {
    test(`${size.width} px`, async ({ page }) => {
      await page.setViewportSize(size);
      const server = new FakeReportServer();
      const release = server.hold("2026-10");
      await openDashboard(page, server);
      await expect(page.getByText("Carregando o resultado…")).toBeAttached();
      await settled(page);
      const skeleton = {
        chain: await placeOf(
          page.locator('[data-slot="card"][aria-hidden="true"]').last()
        ),
        chart: await placeOf(page.locator('[data-slot="card-frame"]').first()),
        kpi: await placeOf(page.locator("[data-kpi-row]").first()),
      };
      release();
      await expect(kpiCards(page)).toHaveCount(4);
      await expect(chartRegion(page).getByRole("img")).toBeVisible();
      await settled(page);
      const ready = {
        chain: await placeOf(chain(page)),
        chart: await placeOf(chartRegion(page)),
        kpi: await placeOf(page.locator("[data-kpi-row]").first()),
      };
      for (const key of ["kpi", "chart", "chain"] as const) {
        expect(
          Math.abs(ready[key].height - skeleton[key].height),
          `${key}: ${skeleton[key].height} px no esqueleto, ${ready[key].height} px pronto`
        ).toBeLessThanOrEqual(1);
        expect(
          Math.abs(ready[key].top - skeleton[key].top),
          `${key}: o topo`
        ).toBeLessThanOrEqual(1);
      }
    });
  }
});

test.describe("320 e 360 px, sem rolagem lateral; com letra de 20 px a legenda desce inteira (AC-C3.6)", () => {
  for (const width of [320, 360]) {
    test(`${width} px`, async ({ page }) => {
      await page.setViewportSize({ height: 740, width });
      await openDashboard(page, new FakeReportServer());
      await expect(chartRegion(page).getByRole("img")).toBeVisible();
      await settled(page);
      expect(await noSideScroll(page)).toBe(true);
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "20px";
      });
      await settled(page);
      expect(await noSideScroll(page)).toBe(true);
      const items = chartRegion(page).locator(
        "[data-chart-legend] li:not([aria-hidden])"
      );
      await expect(items).toHaveCount(2);
      const card = await chartRegion(page).evaluate((block) => {
        const box = block.getBoundingClientRect();
        return { left: box.left, right: box.right };
      });
      const boxes = await items.evaluateAll((list) =>
        list.map((li) => {
          const box = li.getBoundingClientRect();
          return {
            clipped: li.scrollWidth > li.clientWidth + 1,
            left: box.left,
            right: box.right,
          };
        })
      );
      for (const text of boxes) {
        expect(text.clipped).toBe(false);
        expect(text.left).toBeGreaterThanOrEqual(card.left);
        expect(text.right).toBeLessThanOrEqual(card.right);
      }
    });
  }
});
