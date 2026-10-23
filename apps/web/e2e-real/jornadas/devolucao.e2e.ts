import { localDate } from "../calendar";
import { expect, openJourney, refusedWith, runT0, test } from "../fixtures";
import { cents } from "../oracle";
import { chainValue } from "../pages/resultado";
import { nextCommandId, seedCashSale, seedProduct, seedStock } from "../seed";

// a refusal of the rule, not a lost session, a network error or a crash of the server
const BUSINESS_REFUSAL =
  /^(BAD_REQUEST|CONFLICT|UNPROCESSABLE_CONTENT|PRECONDITION_FAILED)$/;
const BRL_VALUE = /R\$/;
const RETURN_REGISTERED =
  /^Devolução registrada: 1 unidade no total; 1 voltaram ao estoque/;
const RETURNED_BOTTLE = /^Devolvido: Garrafa térmica/;
const RESTOCKED_MUG = /^Volta ao estoque: Caneca/;
const RETURNED_MUG = /^Devolvido: Caneca/;

/**
 * Journey 6: a confirmed sale (made by the real command) is corrected by a partial return or by a cancellation, never
 * by editing it. The amounts are compared in cents with the Resultado of the month. The sale has two lines (two
 * variants) and the return is of the SECOND line: a restock that only walks the first line fails here.
 */
const ZONE = "America/Sao_Paulo";
type Sql = Parameters<Parameters<typeof test>[2]>[0]["sql"];

async function snapshot(
  sql: Sql,
  saleId: string,
  bottleId: string,
  mugId: string
) {
  const [row] = (
    await sql.query<{
      items: string;
      bottle: number;
      mug: number;
      returned: number | null;
      cancelled: number;
    }>(
      `SELECT (SELECT json_agg(json_build_object('q', quantity, 'p', charged_unit_price::text, 'v', variant_id) ORDER BY position)::text FROM sale_items WHERE sale_id = $1) AS items,
              (SELECT quantity FROM inventory_balances WHERE variant_id = $2) AS bottle,
              (SELECT quantity FROM inventory_balances WHERE variant_id = $3) AS mug,
              (SELECT sum(returned_quantity)::int FROM sale_return_items WHERE sale_id = $1) AS returned,
              (SELECT count(*)::int FROM sale_cancellations WHERE sale_id = $1) AS cancelled`,
      [saleId, bottleId, mugId]
    )
  ).rows;
  return row;
}

async function seeded(
  journey: Awaited<ReturnType<typeof openJourney>>,
  sql: Sql
) {
  const organizationId = journey.organizationId as string;
  const { rpc } = journey.user;
  const today = localDate(runT0(), ZONE);
  const bottle = await seedProduct(
    rpc,
    organizationId,
    "Garrafa térmica",
    "45.90"
  );
  const mug = await seedProduct(rpc, organizationId, "Caneca", "19.90");
  await seedStock(rpc, organizationId, bottle.variantId, 10, "20.00", today);
  await seedStock(rpc, organizationId, mug.variantId, 10, "8.00", today);
  const saleId = await seedCashSale(
    rpc,
    organizationId,
    [
      { price: "45.90", quantity: 3, variantId: bottle.variantId },
      { price: "19.90", quantity: 2, variantId: mug.variantId },
    ],
    new Date(runT0()).toISOString()
  );
  const read = () => snapshot(sql, saleId, bottle.variantId, mug.variantId);
  return { organizationId, read, saleId };
}

test("devolução parcial da 2ª linha pelo detalhe: o estoque dela volta, venda original inalterada, devolver a mais é recusado", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "devolucao", {
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  const { organizationId, read, saleId } = await seeded(journey, sql);
  const before = await read();
  expect(before).toMatchObject({
    bottle: 7,
    cancelled: 0,
    mug: 8,
    returned: null,
  });

  await page.goto(`/sales/detail?saleId=${saleId}`);
  await page
    .getByRole("region", { name: "Devolução" })
    .getByRole("button", { name: "Registrar devolução" })
    .click();
  const panel = page.getByRole("region", { name: "Registrar devolução" });
  // more than was sold: refused on screen
  await panel.getByLabel(RETURNED_BOTTLE).fill("4");
  await panel.getByRole("button", { name: "Revisar devolução" }).click();
  await expect(panel.getByRole("alert").first()).toHaveText(
    "Use um número inteiro de 1 a 3."
  );
  // and by the server
  expect(
    await refusedWith(
      journey.user.rpc.sale.return({
        commandId: nextCommandId(),
        commandVersion: 1,
        items: [{ position: 0, restockedQuantity: 0, returnedQuantity: 4 }],
        organizationId,
        saleId,
      })
    )
  ).toMatch(BUSINESS_REFUSAL);

  // one unit of the second line only; the first line is left blank (not returned)
  await panel.getByLabel(RETURNED_BOTTLE).fill("");
  await panel.getByLabel(RETURNED_MUG).fill("1");
  await panel.getByLabel(RESTOCKED_MUG).fill("1");
  await panel.getByRole("button", { name: "Revisar devolução" }).click();
  await panel.getByRole("button", { name: "Confirmar devolução" }).click();
  await expect(page.getByText(RETURN_REGISTERED)).toBeVisible();

  await expect.poll(read).toMatchObject({ bottle: 7, mug: 9, returned: 1 });
  // the confirmed facts of the sale are as they were
  expect((await read())?.items).toBe(before?.items);

  await page.goto("/dashboard");
  await expect(chainValue(page, "Vendas brutas")).toHaveText(BRL_VALUE);
  expect(cents(await chainValue(page, "Vendas brutas").innerText())).toBe(
    3 * 4590 + 2 * 1990
  );
  expect(cents(await chainValue(page, "(−) Devoluções").innerText())).toBe(
    1990
  );
  expect(cents(await chainValue(page, "(=) Vendas líquidas").innerText())).toBe(
    3 * 4590 + 1990
  );
});

test("cancelamento: o estoque das duas linhas volta inteiro e a venda sai do Resultado do mês", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "cancelamento", {
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  const { read, saleId } = await seeded(journey, sql);
  const before = await read();
  expect(before).toMatchObject({ bottle: 7, cancelled: 0, mug: 8 });

  await page.goto("/dashboard");
  expect(cents(await chainValue(page, "Vendas brutas").innerText())).toBe(
    3 * 4590 + 2 * 1990
  );

  await page.goto(`/sales/detail?saleId=${saleId}`);
  await page
    .getByRole("region", { name: "Cancelar venda" })
    .getByRole("button", { name: "Cancelar venda" })
    .click();
  const panel = page.getByRole("region", { name: "Cancelar venda" });
  await panel.getByRole("button", { name: "Revisar cancelamento" }).click();
  await panel.getByRole("button", { name: "Confirmar cancelamento" }).click();
  // both lines back in full
  await expect.poll(read).toMatchObject({ bottle: 10, cancelled: 1, mug: 10 });
  expect((await read())?.items).toBe(before?.items);

  // the month of the organization, written by the test from T0 in its zone
  const month = new Intl.DateTimeFormat("pt-BR", {
    month: "long",
    timeZone: ZONE,
    year: "numeric",
  }).format(runT0());
  await page.goto("/dashboard");
  await expect(
    page.getByText(`Sem vendas nem despesas em ${month}`, { exact: false })
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Como chegamos a este resultado" })
  ).toHaveCount(0);
});
