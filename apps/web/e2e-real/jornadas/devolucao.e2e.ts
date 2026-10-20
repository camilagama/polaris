import { randomUUID } from "node:crypto";
import { localDate } from "../calendar";
import { expect, openJourney, refusedWith, runT0, test } from "../fixtures";
import { cents } from "../oracle";
import { chainValue } from "../pages/resultado";
import { seedCashSale, seedProduct, seedStock } from "../seed";

// a refusal of the rule, not a lost session, a network error or a crash of the server
const BUSINESS_REFUSAL =
  /^(BAD_REQUEST|CONFLICT|UNPROCESSABLE_CONTENT|PRECONDITION_FAILED)$/;
const BRL_VALUE = /R\$/;
const RETURN_REGISTERED =
  /^Devolução registrada: 1 unidade no total; 1 voltaram ao estoque/;
const RESTOCKED_INPUT = /^Volta ao estoque: Garrafa térmica/;
const RETURNED_INPUT = /^Devolvido: Garrafa térmica/;

/**
 * Journey 6: a confirmed sale (made by the real command) is corrected by a partial return or by a cancellation, never
 * by editing it. The amounts are compared in cents with the Resultado of the month.
 */
const ZONE = "America/Sao_Paulo";
type Sql = Parameters<Parameters<typeof test>[2]>[0]["sql"];

async function snapshot(sql: Sql, saleId: string, variantId: string) {
  const [row] = (
    await sql.query<{
      items: string;
      balance: number;
      returned: number | null;
      cancelled: number;
    }>(
      `SELECT (SELECT json_agg(json_build_object('q', quantity, 'p', charged_unit_price::text) ORDER BY position)::text FROM sale_items WHERE sale_id = $1) AS items,
              (SELECT quantity FROM inventory_balances WHERE variant_id = $2) AS balance,
              (SELECT sum(returned_quantity)::int FROM sale_return_items WHERE sale_id = $1) AS returned,
              (SELECT count(*)::int FROM sale_cancellations WHERE sale_id = $1) AS cancelled`,
      [saleId, variantId]
    )
  ).rows;
  return row;
}

async function seeded(journey: Awaited<ReturnType<typeof openJourney>>) {
  const organizationId = journey.organizationId as string;
  const product = await seedProduct(
    journey.user.rpc,
    organizationId,
    "Garrafa térmica",
    "45.90"
  );
  await seedStock(
    journey.user.rpc,
    organizationId,
    product.variantId,
    10,
    "20.00",
    localDate(runT0(), ZONE)
  );
  const saleId = await seedCashSale(
    journey.user.rpc,
    organizationId,
    [{ price: "45.90", quantity: 3, variantId: product.variantId }],
    new Date(runT0()).toISOString()
  );
  return { organizationId, product, saleId };
}

test("devolução parcial pelo detalhe: estoque volta, venda original inalterada, devolver a mais é recusado", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "devolucao", {
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  const { organizationId, product, saleId } = await seeded(journey);
  const before = await snapshot(sql, saleId, product.variantId);
  expect(before).toMatchObject({ balance: 7, cancelled: 0, returned: null });

  await page.goto(`/sales/detail?saleId=${saleId}`);
  await page
    .getByRole("region", { name: "Devolução" })
    .getByRole("button", { name: "Registrar devolução" })
    .click();
  const panel = page.getByRole("region", { name: "Registrar devolução" });
  // more than was sold: refused on screen
  await panel.getByLabel(RETURNED_INPUT).fill("4");
  await panel.getByRole("button", { name: "Revisar devolução" }).click();
  await expect(panel.getByRole("alert").first()).toHaveText(
    "Use um número inteiro de 1 a 3."
  );
  // and by the server
  expect(
    await refusedWith(
      journey.user.rpc.sale.return({
        commandId: randomUUID(),
        commandVersion: 1,
        items: [{ position: 0, restockedQuantity: 0, returnedQuantity: 4 }],
        organizationId,
        saleId,
      })
    )
  ).toMatch(BUSINESS_REFUSAL);

  await panel.getByLabel(RETURNED_INPUT).fill("1");
  await panel.getByLabel(RESTOCKED_INPUT).fill("1");
  await panel.getByRole("button", { name: "Revisar devolução" }).click();
  await panel.getByRole("button", { name: "Confirmar devolução" }).click();
  await expect(page.getByText(RETURN_REGISTERED)).toBeVisible();

  await expect
    .poll(() => snapshot(sql, saleId, product.variantId))
    .toMatchObject({ balance: 8, returned: 1 });
  // the confirmed facts of the sale are as they were
  expect((await snapshot(sql, saleId, product.variantId))?.items).toBe(
    before?.items
  );

  await page.goto("/dashboard");
  await expect(chainValue(page, "Vendas brutas")).toHaveText(BRL_VALUE);
  expect(cents(await chainValue(page, "Vendas brutas").innerText())).toBe(
    3 * 4590
  );
  expect(cents(await chainValue(page, "(−) Devoluções").innerText())).toBe(
    4590
  );
  expect(cents(await chainValue(page, "(=) Vendas líquidas").innerText())).toBe(
    2 * 4590
  );
});

test("cancelamento: o estoque volta inteiro e a venda sai do Resultado do mês", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "cancelamento", {
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  const { product, saleId } = await seeded(journey);
  const before = await snapshot(sql, saleId, product.variantId);

  await page.goto("/dashboard");
  expect(cents(await chainValue(page, "Vendas brutas").innerText())).toBe(
    3 * 4590
  );

  await page.goto(`/sales/detail?saleId=${saleId}`);
  await page
    .getByRole("region", { name: "Cancelar venda" })
    .getByRole("button", { name: "Cancelar venda" })
    .click();
  const panel = page.getByRole("region", { name: "Cancelar venda" });
  await panel.getByRole("button", { name: "Revisar cancelamento" }).click();
  await panel.getByRole("button", { name: "Confirmar cancelamento" }).click();
  await expect
    .poll(() => snapshot(sql, saleId, product.variantId))
    .toMatchObject({ balance: 10, cancelled: 1 });
  expect((await snapshot(sql, saleId, product.variantId))?.items).toBe(
    before?.items
  );

  // the month of the organization, written by the test from T0 in its zone
  const month = new Intl.DateTimeFormat("pt-BR", {
    month: "long",
    timeZone: ZONE,
    year: "numeric",
  }).format(runT0());
  await page.goto("/dashboard");
  await expect(
    page.getByText(`Não há vendas nem despesas em ${month}.`, { exact: false })
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Como chegamos a este resultado" })
  ).toHaveCount(0);
});
