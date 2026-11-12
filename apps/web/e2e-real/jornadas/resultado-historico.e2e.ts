/// <reference lib="dom" />

import { expect, openJourney, test } from "../fixtures";
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
      const tile = rect("[data-kpi=sales]");
      const spark = rect("[data-kpi=sales] [data-kpi-spark]");
      const lineHeight = Number.parseFloat(
        getComputedStyle(document.documentElement).fontSize
      );
      return {
        inside: Boolean(
          box && tile && box.left >= tile.left && box.right <= tile.right
        ),
        oneLine: Boolean(box && box.height <= lineHeight * 1.3),
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
