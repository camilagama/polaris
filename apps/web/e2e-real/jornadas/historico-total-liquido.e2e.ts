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

interface Comparison {
  historyCount: number;
  historyNet: number;
  resultCount: number;
  resultNet: number;
  screenNet: number;
}

/** Reads one period on the Resultado and again on the Histórico footer the sales card links to. */
async function compare(
  page: Page,
  period: "Este mês" | "Mês passado",
  settled?: { count: number; net: number }
): Promise<Comparison> {
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
  if (settled) {
    await expect(
      link,
      `${period}: o Resultado se acerta no dia do servidor`
    ).toHaveAttribute(
      "aria-label",
      new RegExp(`^Ver as ${settled.count} vendas`)
    );
    await expect
      .poll(async () => cents(await chainValue(page, NET_SALES).innerText()), {
        message: `${period}: o líquido do Resultado se acerta no dia do servidor`,
      })
      .toBe(settled.net);
  }
  const resultNet = cents(await chainValue(page, NET_SALES).innerText());
  const resultCount = Number(
    SALES_LINK.exec((await link.getAttribute("aria-label")) ?? "")?.[1]
  );

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
  const count = SALES_COUNT.exec(
    (await footer.getByText(SALES_COUNT).innerText()).trim()
  );

  await openPeriodPicker(page);
  await page
    .getByRole("dialog", { name: "Período" })
    .getByRole("button", { name: "Limpar" })
    .click();
  await expect(footer).toContainText(SCREEN_LABEL);
  const screenNet = cents(footerMoney(await footer.innerText()));
  return {
    historyCount: Number(count?.[1]),
    historyNet,
    resultCount,
    resultNet,
    screenNet,
  };
}

/** The Histórico agrees with the Resultado on the figure and on the number of sales; returns the figure. */
async function agreedNet(
  page: Page,
  period: "Este mês" | "Mês passado"
): Promise<number> {
  const read = await compare(page, period);
  expect(read.historyNet, `${period}: o valor é o do Resultado`).toBe(
    read.resultNet
  );
  expect(
    read.historyCount,
    `${period}: o número de vendas é o do Resultado`
  ).toBe(read.resultCount);
  expect(
    read.screenNet,
    `${period}: a soma das linhas não é o líquido`
  ).not.toBe(read.historyNet);
  expect(read.resultCount, `${period}: vendas do Resultado`).toBeGreaterThan(1);
  return read.historyNet;
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

  const thisMonth = await agreedNet(page, "Este mês");
  const lastMonth = await agreedNet(page, "Mês passado");

  // a return made now, of a sale of last month: after that period it lowers the figure when it is read again, and it
  // does not enter this month's, where the sale is not
  await returnOne(lastMonthAdjusted);
  expect(
    await agreedNet(page, "Este mês"),
    "a devolução da venda de antes não entra"
  ).toBe(thisMonth);
  expect(
    await agreedNet(page, "Mês passado"),
    "a devolução depois do período reduz o total relido"
  ).toBeLessThan(lastMonth);
});

/** The UTC instant at which a time zone's wall clock reads `date` `time` (the zone's offset at that moment). */
function zonedInstant(
  date: string,
  time: string,
  timeZone: typeof ZONE
): number {
  const guess = Date.parse(`${date}T${time}Z`);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
      minute: "2-digit",
      month: "2-digit",
      second: "2-digit",
      timeZone,
      year: "numeric",
    })
      .formatToParts(new Date(guess))
      .map((part) => [part.type, part.value])
  );
  const wall = Date.parse(
    `${parts.year}-${parts.month}-${parts.day}T${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}:${parts.second}Z`
  );
  return guess - (wall - guess);
}

/** A sale is accepted up to 30 calendar days back: on the 31st the last day of last month is already out of reach. */
const SALE_WINDOW_DAYS = 30;

function lastDayOfLastMonthIsInReach(): boolean {
  const today = localDate(runT0(), ZONE);
  const lastEnd = addDays(monthStart(today), -1);
  return (
    (Date.parse(`${today}T12:00:00Z`) - Date.parse(`${lastEnd}T12:00:00Z`)) /
      86_400_000 <=
    SALE_WINDOW_DAYS
  );
}

const TURN_THIS_MONTH_NET = 31_500;
const TURN_LAST_MONTH_NET = 36_000;

/**
 * Sales glued to the turn of the month in the store's time zone (São Paulo is 3 h behind UTC, so 21:00 to 23:59 of
 * the last day are already the next day in UTC: a cut by the UTC date moves those two sales into this month):
 * - this month, 2 sales, 7 candles: 00:00:10 and 00:01:00 of the 1st;
 * - last month, 3 sales, 8 candles: 12:00, 21:00:00 (00:00 UTC of the 1st) and 23:59:50 of its last day.
 * The candle costs 45,00, so this month is 315,00 and last month 360,00. A sale is accepted up to 30 calendar days back,
 * which is why nothing is seeded before the last day of last month.
 */
async function seedTurnOfTheMonth(
  journey: Awaited<ReturnType<typeof openJourney>>
) {
  const organizationId = journey.organizationId as string;
  const { rpc } = journey.user;
  const today = localDate(runT0(), ZONE);
  const thisStart = monthStart(today);
  const lastEnd = addDays(thisStart, -1);
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
    addDays(lastEnd, -3)
  );
  const sell = (quantity: number, date: string, time: string) =>
    seedCashSale(
      rpc,
      organizationId,
      [{ price: "45.00", quantity, variantId: candle.variantId }],
      new Date(zonedInstant(date, time, ZONE)).toISOString()
    );
  await sell(5, lastEnd, "12:00:00");
  await sell(1, lastEnd, "21:00:00");
  await sell(2, lastEnd, "23:59:50");
  await sell(3, thisStart, "00:00:10");
  await sell(4, thisStart, "00:01:00");
  return { lastEnd, thisStart };
}

async function expectPeriod(
  page: Page,
  period: "Este mês" | "Mês passado",
  count: number,
  net: number
) {
  const read = await compare(page, period, { count, net });
  expect(
    { count: read.resultCount, net: read.resultNet },
    `${period}: o Resultado soma as vendas pela data da loja`
  ).toEqual({ count, net });
  expect(
    { count: read.historyCount, net: read.historyNet },
    `${period}: o Histórico soma as mesmas`
  ).toEqual({ count, net });
}

async function readTurn(page: Page) {
  await expectPeriod(page, "Este mês", 2, TURN_THIS_MONTH_NET);
  await expectPeriod(page, "Mês passado", 3, TURN_LAST_MONTH_NET);
}

/**
 * The server's clock is the real one and cannot be fixed, so these cases fix the device's: a device still in the last
 * month while the server is already in the next one is corrected by the server's day, and the periods are cut by the
 * store's date, not by the UTC one.
 */
test("o total do Histórico e o do Resultado na virada do mês: aparelho às 23:59 do último dia, vendas coladas na fronteira", async ({
  browser,
}, testInfo) => {
  test.skip(
    !lastDayOfLastMonthIsInReach(),
    "a venda do último dia do mês passado passou da janela retroativa de 30 dias"
  );
  const journey = await openJourney(
    browser,
    testInfo,
    "historico-total-virada-23h59",
    { organization: { timezone: ZONE } }
  );
  const { lastEnd } = await seedTurnOfTheMonth(journey);
  await journey.page.clock.setSystemTime(
    zonedInstant(lastEnd, "23:59:00", ZONE)
  );
  await readTurn(journey.page);
});

test("o total do Histórico e o do Resultado na virada do mês: aparelho logo depois da meia-noite do dia 1º", async ({
  browser,
}, testInfo) => {
  test.skip(
    !lastDayOfLastMonthIsInReach(),
    "a venda do último dia do mês passado passou da janela retroativa de 30 dias"
  );
  const journey = await openJourney(
    browser,
    testInfo,
    "historico-total-virada-00h01",
    { organization: { timezone: ZONE } }
  );
  const { thisStart } = await seedTurnOfTheMonth(journey);
  await journey.page.clock.setSystemTime(
    zonedInstant(thisStart, "00:01:00", ZONE)
  );
  await readTurn(journey.page);
});
