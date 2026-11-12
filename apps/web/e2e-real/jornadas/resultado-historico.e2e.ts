/// <reference lib="dom" />

import { addDays, localDate } from "../calendar";
import { expect, openJourney, runT0, test } from "../fixtures";
import { seedCashSale, seedProduct, seedStock } from "../seed";
import {
  historyRows,
  monthToToday,
  openHistoryFromMenu,
  openResultadoFromMenu,
  periodPill,
  salesCard,
  seedSales,
  ZONE,
} from "../pages/resultado-historico";

const ANY_PERIOD_BUTTON = /^Período: .+, editar$/;
const HISTORY_URL = /\/sales\/history$/;
const DASHBOARD_URL = /\/dashboard$/;
const ANY_PERIOD_PILL = /^Período: /;
const ONE_SALE_LINK = /^Ver a venda de /;
const RESULT_LINK = /^Ver o resultado/;
const SALES_LINK =
  /^Ver as \d+ vendas de \d\d\/\d\d a \d\d\/\d\d no Histórico$/;

test("o cartão de vendas leva ao Histórico com o período do cartão, e o menu abre o Histórico sem ele", async ({
  browser,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "resultado-historico", {
    organization: { timezone: ZONE },
  });
  await seedSales(journey, 3);
  const { page } = journey;
  const { label } = monthToToday();

  await page.goto("/dashboard");
  const card = salesCard(page);
  const link = card.getByRole("button", { name: SALES_LINK });
  await expect(link).toHaveText("Ver as 3 vendas");
  await expect(link).toHaveAccessibleName(
    `Ver as 3 vendas de ${label} no Histórico`
  );

  await link.click();
  await expect(page).toHaveURL(HISTORY_URL);
  await expect(periodPill(page, label)).toBeVisible();
  await expect(historyRows(page), "o N do cartão é o do Histórico").toHaveCount(
    3
  );

  await openResultadoFromMenu(page);
  await openHistoryFromMenu(page);
  await expect(page.getByRole("button", { name: ANY_PERIOD_PILL })).toHaveCount(
    0
  );
  await expect(historyRows(page)).toHaveCount(4);
});

test("o link cabe na linha de apoio, sem quebrar nem ficar sob o minigráfico, a 1280 px e a 320 px com letra de 20 px", async ({
  browser,
}, testInfo) => {
  const journey = await openJourney(
    browser,
    testInfo,
    "resultado-historico-caixa",
    { organization: { timezone: ZONE } }
  );
  await seedSales(journey, 3);
  const { page } = journey;
  const session = await page.context().newCDPSession(page);
  const geometry = async () => {
    await expect(
      salesCard(page).getByRole("button", { name: SALES_LINK })
    ).toBeVisible();
    return await page.evaluate(() => {
      const rect = (selector: string) =>
        document.querySelector(selector)?.getBoundingClientRect();
      const box = rect("[data-kpi=sales] [data-kpi-sales-link]");
      const row = rect("[data-kpi=sales] [data-kpi-note-row]");
      const tile = rect("[data-kpi=sales]");
      const spark = rect("[data-kpi=sales] [data-kpi-spark]");
      const lineHeight = Number.parseFloat(
        getComputedStyle(document.documentElement).fontSize
      );
      return {
        inside: Boolean(
          box && tile && box.left >= tile.left && box.right <= tile.right
        ),
        oneLine: Boolean(row && row.height <= lineHeight * 1.3),
        apart: Boolean(
          box &&
            spark &&
            (box.right <= spark.left ||
              box.left >= spark.right ||
              box.bottom <= spark.top ||
              box.top >= spark.bottom)
        ),
      };
    });
  };

  for (const [width, font] of [
    [1280, 16],
    [320, 20],
  ] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: one viewport after the other, on the same page
    await session.send("Page.setFontSizes", {
      fontSizes: { fixed: font, standard: font },
    });
    await page.setViewportSize({ height: 740, width });
    await page.goto("/dashboard");
    expect(await geometry(), `${width} px, letra de ${font} px`).toEqual({
      apart: true,
      inside: true,
      oneLine: true,
    });
  }
});

test("com o chip de comparação o link desce para uma linha própria sob o chip, à esquerda e fora do minigráfico, a 360, 1024 e 1280 px", async ({
  browser,
}, testInfo) => {
  const journey = await openJourney(
    browser,
    testInfo,
    "resultado-historico-chip",
    { organization: { timezone: ZONE } }
  );
  const organizationId = journey.organizationId as string;
  const { rpc } = journey.user;
  const today = localDate(runT0(), ZONE);
  const candle = await seedProduct(rpc, organizationId, "Vela", "45.00");
  await seedStock(
    rpc,
    organizationId,
    candle.variantId,
    10,
    "12.00",
    addDays(today, -31)
  );
  const sell = (occurredAt: string) =>
    seedCashSale(
      rpc,
      organizationId,
      [{ price: "45.00", quantity: 1, variantId: candle.variantId }],
      occurredAt
    );
  await sell(`${addDays(today, -30)}T15:00:00.000Z`);
  await sell(new Date(runT0()).toISOString());
  const { page } = journey;
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto("/dashboard");
  await page.getByRole("button", { name: ANY_PERIOD_BUTTON }).click();
  await page
    .getByRole("group", { name: "Atalhos do período" })
    .getByRole("button", { exact: true, name: "Últimos 30 dias" })
    .click();
  const card = salesCard(page);
  await expect(card.locator("[data-kpi-chip-row]")).toBeVisible();
  const link = card.locator("[data-kpi-sales-link]");

  for (const width of [1280, 1024, 360]) {
    // biome-ignore lint/performance/noAwaitInLoops: one viewport after the other, on the same page
    await page.setViewportSize({ height: 800, width });
    await expect(link, `${width} px`).toBeVisible();
    await expect(link).toHaveText("Ver a venda");
    await expect
      .poll(
        async () =>
          await page.evaluate(() => {
            const rect = (selector: string) =>
              document.querySelector(selector)?.getBoundingClientRect();
            const box = rect("[data-kpi=sales] [data-kpi-sales-link]");
            const chip = rect("[data-kpi=sales] [data-kpi-chip-row]");
            const tile = rect("[data-kpi=sales]");
            const spark = rect("[data-kpi=sales] [data-kpi-spark]");
            return {
              apart: Boolean(
                box &&
                  spark &&
                  (box.right <= spark.left ||
                    box.left >= spark.right ||
                    box.bottom <= spark.top ||
                    box.top >= spark.bottom)
              ),
              inside: Boolean(
                box && tile && box.left >= tile.left && box.right <= tile.right
              ),
              leftOfChip: Boolean(box && chip && box.left <= chip.left + 1),
              underChip: Boolean(
                box && chip && box.top + box.height / 2 >= chip.bottom
              ),
            };
          }),
        { message: `${width} px` }
      )
      .toEqual({
        apart: true,
        inside: true,
        leftOfChip: true,
        underChip: true,
      });
  }
});

test("com uma venda o link diz Ver a venda", async ({ browser }, testInfo) => {
  const journey = await openJourney(
    browser,
    testInfo,
    "resultado-historico-uma",
    { organization: { timezone: ZONE } }
  );
  await seedSales(journey, 1, false);
  const { page } = journey;
  const { label } = monthToToday();

  await page.goto("/dashboard");
  const link = salesCard(page).getByRole("button", {
    name: ONE_SALE_LINK,
  });
  await expect(link).toHaveText("Ver a venda");
  await expect(link).toHaveAccessibleName(
    `Ver a venda de ${label} no Histórico`
  );
});

test("o Histórico com o período leva ao Resultado no mesmo período, e recarregar o perde sem erro", async ({
  browser,
}, testInfo) => {
  const journey = await openJourney(
    browser,
    testInfo,
    "resultado-historico-volta",
    { organization: { timezone: ZONE } }
  );
  await seedSales(journey, 3);
  const { page } = journey;
  const { label } = monthToToday();

  await page.goto("/dashboard");
  await salesCard(page).getByRole("button", { name: SALES_LINK }).click();
  await expect(periodPill(page, label)).toBeVisible();

  const back = page.getByRole("button", {
    exact: true,
    name: `Ver o resultado deste período, de ${label}`,
  });
  await expect(back).toHaveText("Ver o resultado deste período");
  await back.click();
  await expect(page).toHaveURL(DASHBOARD_URL);
  await expect(
    page.getByRole("button", { exact: true, name: `Período: ${label}, editar` })
  ).toBeVisible();
  await expect(
    salesCard(page).getByRole("button", { name: SALES_LINK })
  ).toHaveText("Ver as 3 vendas");

  await page.goBack();
  await expect(periodPill(page, label)).toHaveCount(0);

  await page.goto("/dashboard");
  await salesCard(page).getByRole("button", { name: SALES_LINK }).click();
  await expect(periodPill(page, label)).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { exact: true, name: "Histórico de vendas" })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: ANY_PERIOD_PILL })).toHaveCount(
    0
  );
  await expect(historyRows(page)).toHaveCount(4);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: RESULT_LINK })).toHaveCount(0);
});
