/// <reference lib="dom" />

import type { Page } from "@playwright/test";
import { addDays, localDate, monthStart } from "../calendar";
import { expect, openJourney, runT0, test } from "../fixtures";
import { cents } from "../oracle";
import { chainValue } from "../pages/resultado";
import { salesCard, ZONE } from "../pages/resultado-historico";
import {
  nextCommandId,
  type SaleAdjustments,
  seedCashSale,
  seedProduct,
  seedStock,
} from "../seed";

const SALES_LINK =
  /^Ver as (\d+) vendas de \d\d\/\d\d a \d\d\/\d\d no Histórico$/;
const SALES_COUNT = /^(\d+) vendas$/;
const PERIOD_BUTTON = /^Período: .+, editar$/;
const MONEY = /-?R\$\s?[\d.]+,\d{2}/;
const NET_SALES = "(=) Vendas líquidas";
const PERIOD_LABEL = "Vendas líquidas do período";
const SCREEN_LABEL = "Total na tela";

const fixed = (kind: "discount" | "freight" | "surcharge", amount: string) =>
  ({ kind, value: { amount, type: "fixed" } }) as const;
const percent = (kind: "discount", percentage: string) =>
  ({ kind, value: { percentage, type: "percentage" } }) as const;

function footerMoney(text: string): string {
  const amount = MONEY.exec(text)?.[0];
  if (amount === undefined) {
    throw new Error(`No amount in the foot: ${text}`);
  }
  return amount;
}

async function openPeriodPicker(page: Page) {
  await page.getByRole("button", { name: PERIOD_BUTTON }).click();
}

/**
 * A return counts on the date of its sale: for last month's period a return made today lowers the figure when it is
 * read again, and for this month (where that sale is not) it does not enter.
 */
test("o total do Histórico com o período é o netSales do Resultado no mesmo período, este mês e o mês passado", async ({
  browser,
}, testInfo) => {
  const journey = await openJourney(
    browser,
    testInfo,
    "historico-total-liquido",
    { organization: { timezone: ZONE } }
  );
  const organizationId = journey.organizationId as string;
  const { rpc } = journey.user;
  const today = localDate(runT0(), ZONE);
  const lastMonthEnd = addDays(monthStart(today), -1);
  const lastMonthMid = addDays(monthStart(today), -2);
  const candle = await seedProduct(
    rpc,
    organizationId,
    "Vela aromática",
    "45.00"
  );
  await seedStock(
    rpc,
    organizationId,
    candle.variantId,
    40,
    "12.00",
    addDays(monthStart(today), -4)
  );
  const now = new Date(runT0()).toISOString();
  const sell = (
    quantity: number,
    occurredAt: string,
    adjustments: SaleAdjustments = []
  ) =>
    seedCashSale(
      rpc,
      organizationId,
      [{ price: "45.00", quantity, variantId: candle.variantId }],
      occurredAt,
      adjustments
    );
  const returnOne = (saleId: string) =>
    rpc.sale.return({
      commandId: nextCommandId(),
      commandVersion: 1,
      items: [{ position: 0, restockedQuantity: 1, returnedQuantity: 1 }],
      organizationId,
      saleId,
    });

  const lastMonthAdjusted = await sell(2, `${lastMonthEnd}T15:00:00.000Z`, [
    fixed("discount", "10.00"),
    fixed("surcharge", "5.00"),
    fixed("freight", "7.00"),
  ]);
  await sell(1, `${lastMonthMid}T15:00:00.000Z`);
  const lastMonthCancelled = await sell(1, `${lastMonthMid}T16:00:00.000Z`);
  await rpc.sale.cancel({
    commandId: nextCommandId(),
    commandVersion: 1,
    organizationId,
    saleId: lastMonthCancelled,
  });
  await sell(2, now, [percent("discount", "10")]);
  const thisMonthFreight = await sell(2, now, [fixed("freight", "8.00")]);
  await sell(3, now);
  await returnOne(thisMonthFreight);

  const { page } = journey;

  async function compare(period: "Este mês" | "Mês passado") {
    await page.goto("/dashboard");
    if (period !== "Este mês") {
      await openPeriodPicker(page);
      await page
        .getByRole("group", { name: "Atalhos do período" })
        .getByRole("button", { exact: true, name: period })
        .click();
    }
    const link = salesCard(page).getByRole("button", { name: SALES_LINK });
    await expect(link, period).toBeVisible();
    const resultNet = cents(await chainValue(page, NET_SALES).innerText());
    const resultCount = Number(
      SALES_LINK.exec((await link.getAttribute("aria-label")) ?? "")?.[1]
    );
    expect(resultCount, `${period}: vendas do Resultado`).toBeGreaterThan(1);

    await link.click();
    await page
      .getByRole("button", { exact: true, name: "Tirar o filtro Situação" })
      .click();
    const footer = page.locator("[data-list-total]");
    await expect(footer, period).toContainText(PERIOD_LABEL);
    await expect(footer).not.toContainText(SCREEN_LABEL);
    await expect(footer).not.toContainText("há mais");
    await expect(footer.locator("[data-list-total-skeleton]")).toHaveCount(0);
    const historyNet = cents(footerMoney(await footer.innerText()));
    expect(historyNet, `${period}: o valor é o do Resultado`).toBe(resultNet);
    const count = SALES_COUNT.exec(
      (await footer.getByText(SALES_COUNT).innerText()).trim()
    );
    expect(
      Number(count?.[1]),
      `${period}: o número de vendas é o do Resultado`
    ).toBe(resultCount);

    await page
      .getByRole("button", { exact: true, name: "Tirar o filtro Período" })
      .click();
    await expect(footer).toContainText(SCREEN_LABEL);
    expect(
      cents(footerMoney(await footer.innerText())),
      `${period}: a soma das linhas não é o líquido`
    ).not.toBe(historyNet);
    return historyNet;
  }

  const thisMonth = await compare("Este mês");
  const lastMonth = await compare("Mês passado");

  // a return made now, of a sale of last month: after that period it lowers the figure when it is read again, and it
  // does not enter this month's, where the sale is not
  await returnOne(lastMonthAdjusted);
  expect(
    await compare("Este mês"),
    "a devolução da venda de antes não entra"
  ).toBe(thisMonth);
  expect(
    await compare("Mês passado"),
    "a devolução depois do período reduz o total relido"
  ).toBeLessThan(lastMonth);
});
