import { localDate } from "../calendar";
import { expect, openJourney, runT0, test } from "../fixtures";
import { numericCents } from "../oracle";
import { choose, confirmSale, fillSale } from "../pages/venda";
import { seedProduct, seedStock } from "../seed";

const SHIRT = /Camiseta lisa/;

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
