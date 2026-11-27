import { localDate } from "../calendar";
import { expect, openJourney, runT0, test } from "../fixtures";
import { cents, numericCents } from "../oracle";
import { chainValue } from "../pages/resultado";
import {
  historyRows,
  monthToToday,
  salesCard,
  ZONE,
} from "../pages/resultado-historico";
import { choose, confirmSale, fillSale } from "../pages/venda";
import { seedProduct, seedStock } from "../seed";

const SHIRT = /Camiseta lisa/;
const MONEY = /-?R\$\s?[\d.]+,\d{2}/;
const NET_SALES = "(=) Vendas líquidas";
const GROSS_SALES = "Vendas brutas";
const PERIOD_LABEL = "Vendas líquidas do período";
const SCREEN_LABEL = "Total na tela";
const PART_PIX = /^Parte 1: Pix\s*R\$\s*100,00/;
const PART_CASH = /^Parte 2: Dinheiro\s*R\$\s*200,00/;
const TOTAL_CENTS = 30_000;

/** The first amount a piece of text says, in cents; refuses text with none. */
function amountIn(text: string): number {
  const amount = MONEY.exec(text)?.[0];
  if (amount === undefined) {
    throw new Error(`No amount in: ${text}`);
  }
  return cents(amount);
}

/**
 * The example of the owner, against the real server: a sale of R$ 300,00 paid in two parts, R$ 100,00 typed in part 1
 * and the rest (R$ 200,00) already in part 2. Confirming sends `payments` and the server records two payment rows, in
 * the order typed, with the header counting two.
 */
test("venda dividida: total 300, Parte 1 = 100, a Parte 2 vem com 200 e a venda grava duas linhas de pagamento", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "venda-dividida");
  const { page, user } = journey;
  const organizationId = journey.organizationId as string;
  const today = localDate(runT0(), "America/Sao_Paulo");
  const shirt = await seedProduct(
    user.rpc,
    organizationId,
    "Camiseta lisa",
    "300.00"
  );
  await seedStock(
    user.rpc,
    organizationId,
    shirt.variantId,
    3,
    "120.00",
    today
  );

  await page.goto("/sales");
  await fillSale(
    page,
    [{ charged: "300,00", option: SHIRT, quantity: 1, search: "Camiseta" }],
    []
  );
  await page
    .getByRole("button", { exact: true, name: "Dividir pagamento" })
    .click();
  const first = page.getByRole("group", { exact: true, name: "Parte 1" });
  const second = page.getByRole("group", { exact: true, name: "Parte 2" });
  await choose(page, first, "Método", "Pix");
  await first.getByLabel("Valor").fill("100,00");
  await expect(second.getByLabel("Valor")).toHaveValue("200,00");
  await expect(second.getByLabel("Valor")).toHaveAccessibleDescription(
    "O restante"
  );
  await choose(page, second, "Método", "Dinheiro");
  await choose(page, second, "Perfil de pagamento", "Sem perfil de pagamento");
  await expect(
    page.getByText("Fechou: R$ 300,00", { exact: true }).first()
  ).toBeVisible();
  await confirmSale(page);

  await expect
    .poll(
      async () =>
        (
          await sql.query<{ payment_count: number }>(
            "SELECT payment_count FROM sales WHERE organization_id = $1",
            [organizationId]
          )
        ).rows
    )
    .toEqual([{ payment_count: 2 }]);
  const payments = (
    await sql.query<{ amount: string; method: string; position: number }>(
      `SELECT p.position, p.method, p.amount::text AS amount
         FROM sale_payments p WHERE p.organization_id = $1 ORDER BY p.position`,
      [organizationId]
    )
  ).rows.map((row) => ({ ...row, amount: numericCents(row.amount) }));
  expect(payments).toEqual([
    { amount: 10_000, method: "pix", position: 0 },
    { amount: 20_000, method: "cash", position: 1 },
  ]);

  // a sale in parts is not "the last payment": nothing is remembered, and the next sale opens with one payment
  await expect(
    page.getByRole("radiogroup", { name: "Método de pagamento" })
  ).toBeVisible();
  await expect(first).toHaveCount(0);
  await expect(
    page.getByRole("button", { exact: true, name: "Dividir pagamento" })
  ).toBeVisible();
  const remembered = await page.evaluate(() =>
    Object.keys(localStorage).filter((key) =>
      key.startsWith("polaris.sale.lastPayment.v1:")
    )
  );
  expect(remembered).toEqual([]);
});

/**
 * The owner's expectation is that this is one sale of 300, paid in two parts, and that the Resultado adds 300 once. The
 * sale is made on the screen, then read on the three screens that count it: the Resultado of the month (not 600, not
 * the 100 of the first part), the Histórico the sales card links to (one row, the net figure of the period) and the
 * Detalhe (the two parts in the order typed, the total once).
 */
test("venda dividida: o Resultado soma 300 uma vez, o Histórico lista uma venda e o Detalhe mostra as duas partes na ordem", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "venda-dividida-telas", {
    organization: { timezone: ZONE },
  });
  const { page, user } = journey;
  const organizationId = journey.organizationId as string;
  const today = localDate(runT0(), ZONE);
  const shirt = await seedProduct(
    user.rpc,
    organizationId,
    "Camiseta lisa",
    "300.00"
  );
  await seedStock(
    user.rpc,
    organizationId,
    shirt.variantId,
    3,
    "120.00",
    today
  );

  await page.goto("/sales");
  await fillSale(
    page,
    [{ charged: "300,00", option: SHIRT, quantity: 1, search: "Camiseta" }],
    []
  );
  await page
    .getByRole("button", { exact: true, name: "Dividir pagamento" })
    .click();
  const first = page.getByRole("group", { exact: true, name: "Parte 1" });
  const second = page.getByRole("group", { exact: true, name: "Parte 2" });
  await choose(page, first, "Método", "Pix");
  await first.getByLabel("Valor").fill("100,00");
  await expect(second.getByLabel("Valor")).toHaveValue("200,00");
  await choose(page, second, "Método", "Dinheiro");
  await choose(page, second, "Perfil de pagamento", "Sem perfil de pagamento");
  await confirmSale(page);
  await expect
    .poll(async () =>
      (
        await sql.query<{ sales: number }>(
          "SELECT count(*)::int AS sales FROM sales WHERE organization_id = $1",
          [organizationId]
        )
      ).rows.map((row) => row.sales)
    )
    .toEqual([1]);

  // Resultado: the chain of the month adds the sale once
  await page.goto("/dashboard");
  await expect
    .poll(async () => cents(await chainValue(page, GROSS_SALES).innerText()))
    .toBe(TOTAL_CENTS);
  await expect
    .poll(async () => cents(await chainValue(page, NET_SALES).innerText()))
    .toBe(TOTAL_CENTS);

  // Histórico: from the sales card, with the period; one row and the net figure of the period
  await salesCard(page)
    .getByRole("button", {
      exact: true,
      name: `Ver a venda de ${monthToToday().label} no Histórico`,
    })
    .click();
  await expect(historyRows(page)).toHaveCount(1);
  await expect
    .poll(async () => amountIn(await historyRows(page).innerText()))
    .toBe(TOTAL_CENTS);
  await page
    .getByRole("button", { exact: true, name: "Tirar o filtro Situação" })
    .click();
  const footer = page.locator("[data-list-total]");
  await expect(footer).toContainText(PERIOD_LABEL);
  await expect(footer).not.toContainText(SCREEN_LABEL);
  await expect(footer.locator("[data-list-total-skeleton]")).toHaveCount(0);
  await expect
    .poll(async () => amountIn(await footer.innerText()))
    .toBe(TOTAL_CENTS);

  // Detalhe: the two parts in the order typed and the total once
  await historyRows(page).getByRole("link").first().click();
  await page.waitForURL("**/sales/detail?saleId=*");
  const parts = page
    .getByRole("list", { exact: true, name: "Pagamento em 2 partes" })
    .getByRole("listitem");
  await expect(parts).toHaveText([PART_PIX, PART_CASH]);
  await expect(
    page.getByRole("list", { exact: true, name: "Pagamento em 2 partes" })
  ).not.toContainText("300,00");
  const totals = page.locator("[data-receipt-totals]");
  await expect(totals.getByText(MONEY)).toHaveCount(1);
  await expect
    .poll(async () => amountIn(await totals.getByText(MONEY).innerText()))
    .toBe(TOTAL_CENTS);
});
