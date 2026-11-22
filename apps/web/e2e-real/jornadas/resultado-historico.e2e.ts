/// <reference lib="dom" />

import { addDays, localDate } from "../calendar";
import { expect, openJourney, runT0, test } from "../fixtures";
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
import { nextCommandId, seedCashSale, seedProduct, seedStock } from "../seed";

const ANY_PERIOD_BUTTON = /^Período: .+, editar$/;
const HISTORY_URL = /\/sales\/history$/;
const ANY_PERIOD_PILL = /^Período: /;
const ONE_SALE_LINK = /^Ver a venda de /;
const STATUS_PILL = "Situação: Confirmadas, editar";
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
  await expect(card).toContainText("3 vendas");
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

test("com uma venda cancelada no período, o link do cartão abre o Histórico com as pílulas Período e Situação e exatamente N linhas", async ({
  browser,
}, testInfo) => {
  const journey = await openJourney(
    browser,
    testInfo,
    "resultado-historico-canceladas",
    { organization: { timezone: ZONE } }
  );
  const { sell } = await seedSales(journey, 3);
  const cancelledId = await sell(new Date(runT0()).toISOString());
  await journey.user.rpc.sale.cancel({
    commandId: nextCommandId(),
    commandVersion: 1,
    organizationId: journey.organizationId as string,
    saleId: cancelledId,
  });
  const { page } = journey;
  const { label } = monthToToday();

  await page.goto("/dashboard");
  const link = salesCard(page).getByRole("button", { name: SALES_LINK });
  await expect(salesCard(page)).toContainText("3 vendas");

  await link.click();
  await expect(page).toHaveURL(HISTORY_URL);
  await expect(periodPill(page, label)).toBeVisible();
  await expect(
    page.getByRole("button", { exact: true, name: STATUS_PILL })
  ).toBeVisible();
  await expect(
    historyRows(page),
    "a cancelada do período não entra: o N do cartão é o das confirmadas"
  ).toHaveCount(3);

  await page
    .getByRole("button", { exact: true, name: "Tirar o filtro Situação" })
    .click();
  await expect(
    page.getByRole("button", { exact: true, name: STATUS_PILL })
  ).toHaveCount(0);
  await expect(periodPill(page, label)).toBeVisible();
  await expect(
    historyRows(page),
    "sem a Situação volta a cancelada"
  ).toHaveCount(4);

  await page.reload();
  await expect(
    page.getByRole("button", { exact: true, name: STATUS_PILL })
  ).toHaveCount(0);
  await expect(periodPill(page, label)).toHaveCount(0);
});

test("o cartão inteiro é o link, a linha de apoio é uma só e o minigráfico fica por cima, a 1280 px e a 320 px com letra de 20 px", async ({
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
      const spark = document.querySelector("[data-kpi=sales] [data-kpi-spark]");
      const sparkBox = spark?.getBoundingClientRect();
      const hit = sparkBox
        ? document.elementFromPoint(
            sparkBox.left + sparkBox.width / 2,
            sparkBox.top + sparkBox.height / 2
          )
        : null;
      const lineHeight = Number.parseFloat(
        getComputedStyle(document.documentElement).fontSize
      );
      return {
        covers: Boolean(
          box &&
            tile &&
            Math.abs(box.left - tile.left) <= 1 &&
            Math.abs(box.right - tile.right) <= 1 &&
            Math.abs(box.top - tile.top) <= 1 &&
            Math.abs(box.bottom - tile.bottom) <= 1
        ),
        oneLine: Boolean(row && row.height <= lineHeight * 1.3),
        sparkOnTop: Boolean(spark && hit && spark.contains(hit)),
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
      covers: true,
      oneLine: true,
      sparkOnTop: true,
    });
  }
});

test("com o chip de comparação o cartão não cresce: chip e contagem na mesma linha de apoio, e o botão cobre o cartão, a 360, 1024 e 1280 px", async ({
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
    await expect(card).toContainText("1 venda");
    await expect
      .poll(
        async () =>
          await page.evaluate(() => {
            const rect = (selector: string) =>
              document.querySelector(selector)?.getBoundingClientRect();
            const box = rect("[data-kpi=sales] [data-kpi-sales-link]");
            const row = rect("[data-kpi=sales] [data-kpi-note-row]");
            const tile = rect("[data-kpi=sales]");
            const rem = Number.parseFloat(
              getComputedStyle(document.documentElement).fontSize
            );
            return {
              covers: Boolean(
                box &&
                  tile &&
                  box.left <= tile.left + 1 &&
                  box.right >= tile.right - 1 &&
                  box.top <= tile.top + 1 &&
                  box.bottom >= tile.bottom - 1
              ),
              oneLine: Boolean(row && row.height <= rem * 1.3),
            };
          }),
        { message: `${width} px` }
      )
      .toEqual({ covers: true, oneLine: true });
  }

  const height = async () => (await card.boundingBox())?.height ?? 0;
  const resting = await height();
  await card.getByRole("slider").press("ArrowLeft");
  await expect(card.locator("[data-kpi-date]")).toBeVisible();
  await expect(link, "um dia lido volta ao texto").toHaveCount(0);
  await expect
    .poll(height, { message: "ler um dia não muda a altura do cartão" })
    .toBeCloseTo(resting, 0);
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
  await expect(salesCard(page)).toContainText("1 venda");
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
  const { from, label, to } = monthToToday();

  await page.goto("/dashboard");
  await salesCard(page).getByRole("button", { name: SALES_LINK }).click();
  await expect(periodPill(page, label)).toBeVisible();

  const back = page.getByRole("button", {
    exact: true,
    name: `Ver o resultado deste período, de ${label}`,
  });
  await expect(back).toHaveText("Ver o resultado deste período");
  await back.click();
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === "/dashboard" &&
      url.searchParams.get("de") === from &&
      url.searchParams.get("ate") === to
  );
  await expect(
    page.getByRole("button", { exact: true, name: `Período: ${label}, editar` })
  ).toBeVisible();
  await expect(
    salesCard(page).getByRole("button", { name: SALES_LINK })
  ).toBeVisible();
  await expect(salesCard(page)).toContainText("3 vendas");

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
