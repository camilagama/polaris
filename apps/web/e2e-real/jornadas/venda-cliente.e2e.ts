import { localDate } from "../calendar";
import { expect, openJourney, runT0, test } from "../fixtures";
import { cents, numericCents } from "../oracle";
import { openSaleAction } from "../pages/detalhe-da-venda";
import { choose, termValue } from "../pages/venda";
import { nextCommandId, seedCashSale, seedProduct, seedStock } from "../seed";

const ZONE = "America/Sao_Paulo";
const ASSIGNED = "Cliente associado à venda.";
const REASSIGNED = "Cliente trocado.";
const UNASSIGNED = "Cliente removido da venda.";
const NO_PURCHASES = "Ainda sem compras.";

type Journey = Awaited<ReturnType<typeof openJourney>>;
type Sql = Parameters<Parameters<typeof test>[2]>[0]["sql"];

interface LinkRow {
  action: string;
  created_at: string;
  customer_id: string | null;
  id: string;
  version: number;
}

/** The code and the `data.reason` of a refused call; fails if the call answers. */
async function refusal(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    const { code, data } = error as {
      code?: unknown;
      data?: { reason?: unknown } | null;
    };
    return { code: String(code), reason: data?.reason };
  }
  throw new Error("The call was expected to be refused, and it answered.");
}

async function linksOf(sql: Sql, saleId: string): Promise<LinkRow[]> {
  return (
    await sql.query<LinkRow>(
      `SELECT id, version, action, customer_id, created_at::text AS created_at
         FROM sale_customer_links WHERE sale_id = $1 ORDER BY version`,
      [saleId]
    )
  ).rows;
}

/**
 * Everything the sale confirmed and the stock it moved, whole rows: the link of a customer must leave every one of
 * them exactly as it was.
 */
async function economy(sql: Sql, saleId: string, variantId: string) {
  const [row] = (
    await sql.query<{ facts: string }>(
      `SELECT jsonb_build_object(
         'sale', (SELECT to_jsonb(s) FROM sales s WHERE s.id = $1),
         'items', (SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.position), '[]') FROM sale_items i WHERE i.sale_id = $1),
         'adjustments', (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.position), '[]') FROM sale_adjustments a WHERE a.sale_id = $1),
         'payments', (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.id), '[]') FROM sale_payments p WHERE p.sale_id = $1),
         'cancellations', (SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id), '[]') FROM sale_cancellations c WHERE c.sale_id = $1),
         'movements', (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.variant_sequence), '[]') FROM stock_movements m WHERE m.variant_id = $2),
         'balance', (SELECT to_jsonb(b) FROM inventory_balances b WHERE b.variant_id = $2)
       )::text AS facts`,
      [saleId, variantId]
    )
  ).rows;
  return JSON.parse((row as { facts: string }).facts) as unknown;
}

async function seeded(journey: Journey) {
  const organizationId = journey.organizationId as string;
  const { rpc } = journey.user;
  const product = await seedProduct(
    rpc,
    organizationId,
    `Agenda ${journey.name}`,
    "30.00"
  );
  await seedStock(
    rpc,
    organizationId,
    product.variantId,
    10,
    "11.00",
    localDate(runT0(), ZONE)
  );
  const sell = (price: string) =>
    seedCashSale(
      rpc,
      organizationId,
      [{ price, quantity: 1, variantId: product.variantId }],
      new Date(runT0()).toISOString()
    );
  const customer = async (label: string) =>
    rpc.customer.create({
      email: `${label}.${journey.name}@exemplo.com.br`,
      name: `${label} ${journey.name}`,
      notes: null,
      organizationId,
      phone: null,
    });
  return { customer, organizationId, product, sell };
}

/** The line of the sale detail that names its customer (a status region). */
function customerLine(page: Journey["page"], text: string) {
  return page.getByRole("status").filter({ hasText: text });
}

/** The summary the sale detail draws under the name of its customer: purchases and total spent, or none yet. */
function summaryOf(page: Journey["page"]) {
  const scope = page.locator("body");
  return {
    purchases: termValue(scope, "Compras"),
    totalSpent: termValue(scope, "Total gasto"),
  };
}

async function pickCustomer(
  page: Journey["page"],
  action: "Associar cliente" | "Trocar cliente",
  name: string
) {
  await openSaleAction(page, action);
  const dialog = page.getByRole("dialog", { name: action });
  await choose(page, dialog, "Cliente", name);
  await dialog.getByRole("button", { exact: true, name: action }).click();
  await expect(dialog).toBeHidden();
}

/**
 * Journey: the customer of a confirmed sale is associated, changed and removed on the sale detail. Each step is a new
 * row of an append-only history (the first row is never touched), the economy of the sale does not move, and the
 * summary of each customer follows the link. A request with an old version is a conflict, and repeating the current
 * customer writes nothing.
 */
test("venda e cliente: associar, trocar e remover só acrescentam histórico, a economia fica igual e o resumo acompanha", async ({
  browser,
  sql,
}, testInfo) => {
  test.setTimeout(180_000);
  const journey = await openJourney(browser, testInfo, "venda-cliente", {
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  const { rpc } = journey.user;
  const { customer, organizationId, product, sell } = await seeded(journey);
  const first = await customer("Ana");
  const second = await customer("Bia");
  const thirtySale = await sell("30.00");
  const fiftySale = await sell("50.00");
  await rpc.sale.assignCustomer({
    customerId: first.id,
    expectedVersion: 0,
    organizationId,
    saleId: fiftySale,
  });
  const read = () => economy(sql, thirtySale, product.variantId);
  const before = await read();
  expect(before).toMatchObject({
    balance: { quantity: 8 },
    cancellations: [],
    items: [expect.objectContaining({ quantity: 1 })],
  });
  expect(await linksOf(sql, thirtySale)).toEqual([]);

  await page.goto(`/sales/detail?saleId=${thirtySale}`);
  await expect(customerLine(page, "Sem cliente")).toBeVisible();

  await pickCustomer(page, "Associar cliente", first.name);
  await expect(page.getByText(ASSIGNED, { exact: true })).toBeVisible();
  await expect(customerLine(page, first.name)).toBeVisible();
  await expect
    .poll(() => linksOf(sql, thirtySale))
    .toEqual([
      expect.objectContaining({
        action: "assign",
        customer_id: first.id,
        version: 1,
      }),
    ]);
  const afterAssign = await linksOf(sql, thirtySale);
  expect(await read()).toEqual(before);
  // the customer has both sales: 2 purchases, 80,00 spent
  const summary = summaryOf(page);
  await expect(summary.purchases).toHaveText("2");
  await expect
    .poll(async () => cents((await summary.totalSpent.textContent()) ?? ""))
    .toBe(cents("80,00"));

  await pickCustomer(page, "Trocar cliente", second.name);
  await expect(page.getByText(REASSIGNED, { exact: true })).toBeVisible();
  await expect(customerLine(page, second.name)).toBeVisible();
  await expect(
    page.getByText(`v2 · Cliente trocado: ${second.name}`)
  ).toBeVisible();
  await expect
    .poll(() => linksOf(sql, thirtySale))
    .toEqual([
      afterAssign[0],
      expect.objectContaining({
        action: "reassign",
        customer_id: second.id,
        version: 2,
      }),
    ]);
  const afterChange = await linksOf(sql, thirtySale);
  expect(await read()).toEqual(before);

  // the summary follows: the sale of 30,00 is now Bia's only purchase, the sale of 50,00 is Ana's only one
  await expect(summary.purchases).toHaveText("1");
  await expect
    .poll(async () => cents((await summary.totalSpent.textContent()) ?? ""))
    .toBe(cents("30,00"));
  await page.goto(`/sales/detail?saleId=${fiftySale}`);
  await expect(customerLine(page, first.name)).toBeVisible();
  await expect(summary.purchases).toHaveText("1");
  await expect
    .poll(async () => cents((await summary.totalSpent.textContent()) ?? ""))
    .toBe(cents("50,00"));

  // an old version is a conflict that changes nothing; the same customer again writes no version
  expect(
    await refusal(
      rpc.sale.reassignCustomer({
        customerId: first.id,
        expectedVersion: 1,
        organizationId,
        saleId: thirtySale,
      })
    )
  ).toEqual({
    code: "CONFLICT",
    reason: "sale_customer_link_version_conflict",
  });
  const sameCustomer = await rpc.sale.reassignCustomer({
    customerId: second.id,
    expectedVersion: 2,
    organizationId,
    saleId: thirtySale,
  });
  expect(sameCustomer.changed).toBe(false);
  expect(await linksOf(sql, thirtySale)).toEqual(afterChange);
  expect(await read()).toEqual(before);

  await page.goto(`/sales/detail?saleId=${thirtySale}`);
  await expect(customerLine(page, second.name)).toBeVisible();
  await openSaleAction(page, "Remover cliente");
  await page
    .getByRole("dialog", { name: "Remover o cliente desta venda?" })
    .getByRole("button", { exact: true, name: "Remover cliente" })
    .click();
  await expect(page.getByText(UNASSIGNED, { exact: true })).toBeVisible();
  await expect(customerLine(page, "Sem cliente")).toBeVisible();
  await expect(page.getByText("v3 · Cliente removido")).toBeVisible();
  await expect
    .poll(() => linksOf(sql, thirtySale))
    .toEqual([
      afterAssign[0],
      afterChange[1],
      expect.objectContaining({
        action: "unassign",
        customer_id: null,
        version: 3,
      }),
    ]);
  expect(await read()).toEqual(before);

  // Bia has no purchase left, as the server tells it
  await expect
    .poll(async () => {
      const bia = await rpc.customer.get({ id: second.id, organizationId });
      return {
        count: bia.summary?.purchaseCount,
        spent: numericCents(bia.summary?.totalSpent ?? "x"),
      };
    })
    .toEqual({ count: 0, spent: 0 });
});

/**
 * An archived customer that was already linked stays the customer of the sale and can be changed or removed, but it
 * is not offered when a customer is chosen.
 */
test("venda e cliente: o cliente arquivado continua na venda, pode ser trocado e não aparece na escolha", async ({
  browser,
  sql,
}, testInfo) => {
  test.setTimeout(180_000);
  const journey = await openJourney(browser, testInfo, "venda-cliente-arq", {
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  const { rpc } = journey.user;
  const { customer, organizationId, sell } = await seeded(journey);
  const linked = await customer("Carla");
  const archivedOther = await customer("Davi");
  const active = await customer("Eva");
  const saleId = await sell("30.00");
  await rpc.sale.assignCustomer({
    customerId: linked.id,
    expectedVersion: 0,
    organizationId,
    saleId,
  });
  await rpc.customer.archive({
    expectedVersion: linked.version,
    id: linked.id,
    organizationId,
  });
  await rpc.customer.archive({
    expectedVersion: archivedOther.version,
    id: archivedOther.id,
    organizationId,
  });

  await page.goto(`/sales/detail?saleId=${saleId}`);
  await expect(customerLine(page, `${linked.name} (arquivado)`)).toBeVisible();
  await page.getByRole("button", { exact: true, name: "Ações" }).click();
  await expect(
    page.getByRole("menuitem", { exact: true, name: "Remover cliente" })
  ).toBeEnabled();
  await expect(
    page.getByRole("menuitem", { exact: true, name: "Trocar cliente" })
  ).toBeEnabled();
  await page
    .getByRole("menuitem", { exact: true, name: "Trocar cliente" })
    .click();

  // the choice lists active customers only: not the archived one, not the archived one of the sale
  const dialog = page.getByRole("dialog", { name: "Trocar cliente" });
  await dialog.getByRole("combobox", { exact: true, name: "Cliente" }).click();
  await expect(
    page.getByRole("option", { exact: true, name: active.name })
  ).toBeVisible();
  await expect(
    page.getByRole("option", { exact: true, name: archivedOther.name })
  ).toHaveCount(0);
  await expect(
    page.getByRole("option", { exact: true, name: linked.name })
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("option")).toHaveCount(0);
  await expect(dialog).toBeVisible();

  await choose(page, dialog, "Cliente", active.name);
  await dialog
    .getByRole("button", { exact: true, name: "Trocar cliente" })
    .click();
  await expect(page.getByText(REASSIGNED, { exact: true })).toBeVisible();
  await expect(customerLine(page, active.name)).toBeVisible();
  await expect
    .poll(async () =>
      (await linksOf(sql, saleId)).map((row) => [
        row.version,
        row.action,
        row.customer_id,
      ])
    )
    .toEqual([
      [1, "assign", linked.id],
      [2, "reassign", active.id],
    ]);
});

/**
 * A cancelled sale still takes a customer: it stays cancelled, its cancellation movements are as they were, and it is
 * no purchase of that customer.
 */
test("venda e cliente: a venda cancelada aceita associar cliente e continua cancelada", async ({
  browser,
  sql,
}, testInfo) => {
  test.setTimeout(180_000);
  const journey = await openJourney(browser, testInfo, "venda-cliente-canc", {
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  const { rpc } = journey.user;
  const { customer, organizationId, product, sell } = await seeded(journey);
  const buyer = await customer("Fabio");
  const saleId = await sell("30.00");
  await rpc.sale.cancel({
    commandId: nextCommandId(),
    commandVersion: 1,
    organizationId,
    saleId,
  });
  const read = () => economy(sql, saleId, product.variantId);
  const before = await read();
  expect(before).toMatchObject({
    cancellations: [expect.anything()],
    movements: expect.arrayContaining([
      expect.objectContaining({ movement_type: "sale_cancellation" }),
    ]),
  });

  await page.goto(`/sales/detail?saleId=${saleId}`);
  await pickCustomer(page, "Associar cliente", buyer.name);
  await expect(page.getByText(ASSIGNED, { exact: true })).toBeVisible();
  await expect(customerLine(page, buyer.name)).toBeVisible();
  await expect(page.getByText(NO_PURCHASES)).toBeVisible();
  await expect
    .poll(async () => (await linksOf(sql, saleId)).map((row) => row.action))
    .toEqual(["assign"]);
  expect(await read()).toEqual(before);
});
