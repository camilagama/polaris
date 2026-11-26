import type { Page } from "@playwright/test";
import { addDays, localDate, monthStart } from "../calendar";
import { expect, openJourney, runT0, test } from "../fixtures";
import { cents } from "../oracle";
import { chainValue } from "../pages/resultado";
import { periodPill, salesCard, ZONE } from "../pages/resultado-historico";
import { seedCashSale, seedProduct, seedStock } from "../seed";

const NET_SALES = "(=) Vendas líquidas";
const EXPENSES_OF_PERIOD = "(−) Despesas do período (sem venda)";
const PERIOD_BUTTON = /^Período: .+, editar$/;
const SALES_LINK =
  /^Ver as (\d+) vendas de (\d\d\/\d\d) a (\d\d\/\d\d) no Histórico$/;
const HISTORY_URL = /\/sales\/history$/;
const SALE_WINDOW_DAYS = 30;
const READ_TIMEOUT_MS = 15_000;

const shortDate = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;

/** A sale is accepted up to 30 calendar days back: on the 31st the last day of last month is out of reach. */
function lastDayOfLastMonthIsInReach(): boolean {
  const today = localDate(runT0(), ZONE);
  const lastEnd = addDays(monthStart(today), -1);
  return (
    (Date.parse(`${today}T12:00:00Z`) - Date.parse(`${lastEnd}T12:00:00Z`)) /
      86_400_000 <=
    SALE_WINDOW_DAYS
  );
}

async function pickPeriod(page: Page, period: "Este mês" | "Mês passado") {
  await page.getByRole("button", { name: PERIOD_BUTTON }).click();
  await page
    .getByRole("group", { name: "Atalhos do período" })
    .getByRole("button", { exact: true, name: period })
    .click();
}

interface Reading {
  count: number;
  expenses: number;
  net: number;
}

interface Period {
  link: string;
  pill: string;
}

/** The Resultado as it stands for the period on screen: the button of the period, the sales card and the chain. */
async function readResultado(page: Page, period: Period): Promise<Reading> {
  await expect(periodPill(page, period.pill)).toBeVisible({
    timeout: READ_TIMEOUT_MS,
  });
  const link = salesCard(page).getByRole("button", { name: SALES_LINK });
  await expect(link).toHaveAttribute(
    "aria-label",
    new RegExp(`de ${period.link} no Histórico$`)
  );
  const match = SALES_LINK.exec((await link.getAttribute("aria-label")) ?? "");
  return {
    count: Number(match?.[1]),
    expenses: cents(await chainValue(page, EXPENSES_OF_PERIOD).innerText()),
    net: cents(await chainValue(page, NET_SALES).innerText()),
  };
}

/**
 * The Resultado changes period against the real database: with two sales and one expense in each of two months (dates
 * computed from T0 in the organization's zone), "Este mês" adds up only this month's, "Mês passado" only last
 * month's, and coming back reads the first figures again with nothing left over from the other period. The Histórico
 * period itself is proven by `historico-total-liquido.e2e.ts`; the link of the card by `resultado-historico.e2e.ts`.
 */
test("o Resultado troca de período: este mês e o mês passado somam só o que é de cada um, em centavos, e ao voltar não sobra nada", async ({
  browser,
}, testInfo) => {
  test.skip(
    !lastDayOfLastMonthIsInReach(),
    "a venda do último dia do mês passado passou da janela retroativa de 30 dias"
  );
  const journey = await openJourney(browser, testInfo, "resultado-periodo", {
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  const organizationId = journey.organizationId as string;
  const { rpc } = journey.user;
  const today = localDate(runT0(), ZONE);
  const thisStart = monthStart(today);
  const lastEnd = addDays(thisStart, -1);
  const lastStart = monthStart(today, -1);
  const last: Period = {
    link: `${shortDate(lastStart)} a ${shortDate(lastEnd)}`,
    pill: `${shortDate(lastStart)} a ${shortDate(lastEnd)}`,
  };
  const current: Period = {
    link: `${shortDate(thisStart)} a \\d\\d/\\d\\d`,
    pill: `${shortDate(thisStart)} a ${shortDate(addDays(monthStart(today, 1), -1))}`,
  };

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
  const sell = (quantity: number, occurredAt: string) =>
    seedCashSale(
      rpc,
      organizationId,
      [{ price: "45.00", quantity, variantId: candle.variantId }],
      occurredAt
    );
  const now = new Date(runT0()).toISOString();
  await sell(1, `${lastEnd}T14:00:00.000Z`);
  await sell(1, `${lastEnd}T14:30:00.000Z`);
  await sell(2, `${lastEnd}T15:00:00.000Z`);
  await sell(1, now);
  await sell(2, now);

  const category = await rpc.expense.createCategory({
    group: "operational",
    name: "Aluguel da loja",
    organizationId,
  });
  const expense = (amount: string, competenceOn: string) =>
    rpc.expense.create({
      amount,
      categoryId: category.id,
      competenceOn,
      description: `Aluguel de ${competenceOn}`,
      organizationId,
    });
  await expense("20.00", today);
  await expense("50.00", lastEnd);

  await page.goto("/dashboard");
  const thisMonth = await readResultado(page, current);
  expect(thisMonth).toEqual({ count: 2, expenses: 2000, net: 13_500 });

  await pickPeriod(page, "Mês passado");
  expect(await readResultado(page, last)).toEqual({
    count: 3,
    expenses: 5000,
    net: 18_000,
  });

  // the period on the button is the one the card hands to the Histórico
  await salesCard(page).getByRole("button", { name: SALES_LINK }).click();
  await expect(page).toHaveURL(HISTORY_URL);
  await expect(periodPill(page, last.pill)).toBeVisible();

  await page.goto("/dashboard");
  await pickPeriod(page, "Mês passado");
  await readResultado(page, last);
  await pickPeriod(page, "Este mês");
  expect(
    await readResultado(page, current),
    "ao voltar a Este mês, o primeiro valor, sem sobra do mês passado"
  ).toEqual(thisMonth);
});
