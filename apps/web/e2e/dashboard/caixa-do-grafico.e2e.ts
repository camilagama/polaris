/// <reference lib="dom" />
import { expect, test } from "@playwright/test";
import {
  COMPLETE_MONTH,
  openDashboard,
  chartRegion,
  periodButton,
  YEAR_NAME,
  choosePreset,
  expectPreset,
  chooseRange,
  SIZES,
  chartPlaces,
  type ChartPlaces,
  expectSamePlaces,
  MonthlyReportServer,
  DRAWN_CHART,
  NOVEMBER_5,
  YEAR_AGO_TO_TODAY,
  CHART_BOX_FIXTURES,
} from "./shared";

const YEAR_TO_TODAY_NAME = /05\/11\/2025 a 05\/11\/2026/;

const JULY_NAME = /01\/01 a 06\/07/;

/**
 * The box of the chart's card and where its totals and what follows its drawing sit inside it: what the card itself
 * reserves, whatever the cards above it do.
 */
function insideTheCard(places: ChartPlaces) {
  return {
    height: places.card.height,
    after: places.after.top - places.card.top,
    totals: places.totals.top - places.card.top,
  };
}

const ONE_ROW_AND_ITS_GAP = 28;

function expectSameBox(after: ChartPlaces, before: ChartPlaces) {
  expect(
    after.rowStep,
    "linha vazia entre os pedaços da leitura ou da legenda"
  ).toBeLessThanOrEqual(ONE_ROW_AND_ITS_GAP);
  const now = insideTheCard(after);
  const was = insideTheCard(before);
  for (const key of ["height", "after", "totals"] as const) {
    expect(
      Math.abs(now[key] - was[key]),
      `${key} dentro do cartão do gráfico: ${was[key]} px antes, ${now[key]} px agora`
    ).toBeLessThanOrEqual(1);
  }
}

/** The server of a store whose copy of the year has no cost per day (the line of the costs is not drawn). */
class NoCostsOfTheYearServer extends MonthlyReportServer {
  override async handle(procedure: string, input: Record<string, unknown>) {
    const answer = await super.handle(procedure, input);
    const { json } = answer.body as {
      json?: { daily?: Record<string, unknown>[] };
    };
    if (
      procedure === "report/periodSummary" &&
      answer.status === 200 &&
      input.from === "2026-01-01" &&
      json?.daily
    ) {
      for (const day of json.daily) {
        day.costs = undefined;
        day.operatingResult = undefined;
      }
    }
    return answer;
  }
}

test.describe("a caixa inteira do cartão do gráfico não muda de altura entre o mês, 30 dias, Este ano e um período de 366 dias", () => {
  for (const size of SIZES) {
    for (const hidden of [false, true]) {
      for (const [name, fixture] of Object.entries(CHART_BOX_FIXTURES)) {
        test(`${name}, ${hidden ? "com" : "sem"} Esconder valores (${size.width} px)`, async ({
          page,
        }) => {
          await page.setViewportSize(size);
          if (hidden) {
            await page.addInitScript(() =>
              localStorage.setItem("polaris-valores", "escondidos")
            );
          }
          const server =
            name === "ano sem os custos por dia"
              ? new NoCostsOfTheYearServer()
              : new MonthlyReportServer();
          server.now = NOVEMBER_5;
          server.fixture = fixture;
          await openDashboard(page, server);
          const drawn = () =>
            chartRegion(page).getByRole("img", { name: DRAWN_CHART });
          await expect(drawn()).toBeVisible();
          const month = await chartPlaces(page);

          await choosePreset(page, "Este ano");
          await expect(chartRegion(page)).toContainText("Melhor mês");
          await expect(drawn()).toBeVisible();
          await expect(periodButton(page)).toHaveAccessibleName(YEAR_NAME);
          expectSameBox(await chartPlaces(page), month);

          await choosePreset(page, "Últimos 30 dias");
          await expect(chartRegion(page)).toContainText("Melhor dia");
          await expect(drawn()).toBeVisible();
          expectSameBox(await chartPlaces(page), month);

          await choosePreset(page, "Este ano");
          await expect(chartRegion(page)).toContainText("Melhor mês");
          await expect(drawn()).toBeVisible();
          expectSameBox(await chartPlaces(page), month);

          await chooseRange(page, ...YEAR_AGO_TO_TODAY);
          await expectPreset(page, "Período");
          await expect(chartRegion(page)).toContainText("Melhor mês");
          await expect(drawn()).toBeVisible();
          await expect(periodButton(page)).toHaveAccessibleName(
            YEAR_TO_TODAY_NAME
          );
          expectSameBox(await chartPlaces(page), month);
        });
      }
    }
  }
});

test.describe("a caixa do cartão do gráfico no carregamento do pedaço é a mesma de depois do desenho", () => {
  for (const size of SIZES) {
    for (const name of ["completo", "valores de seis dígitos"] as const) {
      test(`${name} (${size.width} px)`, async ({ page }) => {
        await page.setViewportSize(size);
        let release: () => void = () => undefined;
        const arrives = new Promise<void>((resolve) => {
          release = resolve;
        });
        await page.route("**/assets/charts-*.js", async (route) => {
          await arrives;
          await route.continue();
        });
        const server = new MonthlyReportServer();
        server.now = NOVEMBER_5;
        server.fixture = CHART_BOX_FIXTURES[name];
        await openDashboard(page, server);
        await expect(
          chartRegion(page).locator("[data-chart-loading]")
        ).toBeAttached();
        await expect(
          chartRegion(page).getByRole("img", { name: DRAWN_CHART })
        ).toHaveCount(0);
        const loading = await chartPlaces(page);

        release();
        await expect(
          chartRegion(page).getByRole("img", { name: DRAWN_CHART })
        ).toBeVisible();
        await expect(
          chartRegion(page).locator("[data-chart-loading]")
        ).toHaveCount(0);
        expectSamePlaces(await chartPlaces(page), loading);
      });
    }
  }
});

const JULY_6 = "2026-07-06T12:00:00.000Z";

test.describe("Este ano até julho, sem custo por dia, e o mês na primeira semana têm a caixa dos 30 dias", () => {
  for (const size of SIZES) {
    test(`sete linhas sem custos (${size.width} px)`, async ({ page }) => {
      await page.setViewportSize(size);
      const server = new NoCostsOfTheYearServer();
      server.now = JULY_6;
      server.fixture = {
        "2026-01": COMPLETE_MONTH,
        "2026-06": COMPLETE_MONTH,
        "2026-07": COMPLETE_MONTH,
      };
      await openDashboard(page, server);
      const drawn = () =>
        chartRegion(page).getByRole("img", { name: DRAWN_CHART });
      await expect(drawn()).toBeVisible();
      const month = await chartPlaces(page);

      await choosePreset(page, "Este ano");
      await expect(chartRegion(page)).toContainText("Melhor mês");
      await expect(drawn()).toBeVisible();
      await expect(periodButton(page)).toHaveAccessibleName(JULY_NAME);
      expectSameBox(await chartPlaces(page), month);

      await choosePreset(page, "Últimos 30 dias");
      await expect(chartRegion(page)).toContainText("Melhor dia");
      await expect(drawn()).toBeVisible();
      expectSameBox(await chartPlaces(page), month);
    });
  }
});
