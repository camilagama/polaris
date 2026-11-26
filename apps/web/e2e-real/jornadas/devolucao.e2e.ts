import type { Page } from "@playwright/test";
import { localDate } from "../calendar";
import { expect, openJourney, refusedWith, runT0, test } from "../fixtures";
import { cents } from "../oracle";
import { openSaleAction } from "../pages/detalhe-da-venda";
import { chainValue } from "../pages/resultado";
import {
  nextCommandId,
  type SaleAdjustments,
  seedCashSale,
  seedProduct,
  seedStock,
} from "../seed";

// a refusal of the rule, not a lost session, a network error or a crash of the server
const BUSINESS_REFUSAL =
  /^(BAD_REQUEST|CONFLICT|UNPROCESSABLE_CONTENT|PRECONDITION_FAILED)$/;
const BRL_VALUE = /R\$/;
const RETURN_REGISTERED =
  /^Devolução registrada: 1 unidade no total; 1 voltaram ao estoque/;
const RETURNED_BOTTLE = /^Devolvido: Garrafa térmica/;
const RESTOCKED_BOTTLE = /^Volta ao estoque: Garrafa térmica/;
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
      restocked: number | null;
      records: number;
      movements: number;
      cancelled: number;
    }>(
      `SELECT (SELECT json_agg(json_build_object('q', quantity, 'p', charged_unit_price::text, 'v', variant_id) ORDER BY position)::text FROM sale_items WHERE sale_id = $1) AS items,
              (SELECT quantity FROM inventory_balances WHERE variant_id = $2) AS bottle,
              (SELECT quantity FROM inventory_balances WHERE variant_id = $3) AS mug,
              (SELECT sum(returned_quantity)::int FROM sale_return_items WHERE sale_id = $1) AS returned,
              (SELECT sum(restocked_quantity)::int FROM sale_return_items WHERE sale_id = $1) AS restocked,
              (SELECT count(*)::int FROM sale_returns WHERE sale_id = $1) AS records,
              (SELECT count(*)::int FROM stock_movements WHERE movement_type = 'sale_return' AND variant_id IN ($2, $3)) AS movements,
              (SELECT count(*)::int FROM sale_cancellations WHERE sale_id = $1) AS cancelled`,
      [saleId, bottleId, mugId]
    )
  ).rows;
  return row;
}

interface Refusal {
  code: string;
  reason: unknown;
}

/** The code and the `data.reason` of a refused call; fails if the call answers. */
async function refusal(call: Promise<unknown>): Promise<Refusal> {
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

const NO_DISCOUNT: SaleAdjustments = [];
const TEN_REAIS_OFF: SaleAdjustments = [
  { kind: "discount", value: { amount: "10.00", type: "fixed" } },
];

/** One sale of the journey: 3 bottles at 45,90 and 2 mugs at 19,90, the mug being the SECOND line (position 1). */
async function seeded(
  journey: Awaited<ReturnType<typeof openJourney>>,
  sql: Sql,
  adjustments: SaleAdjustments = NO_DISCOUNT
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
  const sell = () =>
    seedCashSale(
      rpc,
      organizationId,
      [
        { price: "45.90", quantity: 3, variantId: bottle.variantId },
        { price: "19.90", quantity: 2, variantId: mug.variantId },
      ],
      new Date(runT0()).toISOString(),
      adjustments
    );
  const saleId = await sell();
  const readSale = (id: string) =>
    snapshot(sql, id, bottle.variantId, mug.variantId);
  const read = () => readSale(saleId);
  return { organizationId, read, readSale, saleId, sell };
}

interface ReturnLine {
  bottle?: { returned: string; restocked: string };
  mug?: { returned: string; restocked: string };
}

/** The return of the detail on screen: what is not given stays blank (not returned). */
async function returnThroughDetail(
  page: Page,
  saleId: string,
  line: ReturnLine,
  restockedTotal: number
) {
  await page.goto(`/sales/detail?saleId=${saleId}`);
  await openSaleAction(page, "Registrar devolução");
  const panel = page.getByRole("dialog", { name: "Registrar devolução" });
  if (line.bottle) {
    await panel.getByLabel(RETURNED_BOTTLE).fill(line.bottle.returned);
    await panel.getByLabel(RESTOCKED_BOTTLE).fill(line.bottle.restocked);
  }
  if (line.mug) {
    await panel.getByLabel(RETURNED_MUG).fill(line.mug.returned);
    await panel.getByLabel(RESTOCKED_MUG).fill(line.mug.restocked);
  }
  await panel.getByRole("button", { name: "Revisar devolução" }).click();
  await panel.getByRole("button", { name: "Confirmar devolução" }).click();
  await expect(
    page.getByText(
      new RegExp(
        `^Devolução registrada: .+ no total; ${restockedTotal} voltaram ao estoque`
      )
    )
  ).toBeVisible();
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
  await openSaleAction(page, "Registrar devolução");
  const panel = page.getByRole("dialog", { name: "Registrar devolução" });
  // more than was sold: refused on screen
  await panel.getByLabel(RETURNED_BOTTLE).fill("4");
  await panel.getByRole("button", { name: "Revisar devolução" }).click();
  await expect(panel.getByRole("alert").first()).toHaveText(
    "Informe de 1 a 3, sem vírgula."
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
  await openSaleAction(page, "Cancelar venda");
  const panel = page.getByRole("dialog", { name: "Cancelar venda" });
  await panel.getByRole("button", { name: "Revisar cancelamento" }).click();
  await panel.getByRole("button", { name: "Confirmar cancelamento" }).click();
  // both lines back in full
  await expect.poll(read).toMatchObject({ bottle: 10, cancelled: 1, mug: 10 });
  expect((await read())?.items).toBe(before?.items);

  // the month of the organization, written by the test from T0 in its zone: the screen says the dates of the
  // period it read ("1 a 31 de outubro"), the whole month this one is
  const month = new Intl.DateTimeFormat("pt-BR", {
    month: "long",
    timeZone: ZONE,
  }).format(runT0());
  await page.goto("/dashboard");
  await expect(
    page.getByText(
      new RegExp(`Sem vendas nem despesas em 1 a \\d+ de ${month}`)
    )
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Como chegamos a este resultado" })
  ).toHaveCount(0);
});

/** A row of the result chain read in cents once the screen shows it: the value may still be the old one or a skeleton. */
async function expectChain(page: Page, label: string, expected: number) {
  await expect
    .poll(async () => cents(await chainValue(page, label).innerText()))
    .toBe(expected);
}

const CMV = "(−) Custo das mercadorias vendidas (CMV)";
// 3 bottles at 20,00 and 2 mugs at 8,00
const CMV_OF_SALE = 3 * 2000 + 2 * 800;
const BRUTAS = 3 * 4590 + 2 * 1990;
const DESCONTO = 1000;

test("desconto rateado: devolver 1 garrafa e 1 caneca devolve o preço menos a parte do desconto; devolver o resto fecha em vendas brutas menos descontos", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "devolucao-rateio", {
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  const { read, saleId } = await seeded(journey, sql, TEN_REAIS_OFF);

  await page.goto("/dashboard");
  await expectChain(page, "Vendas brutas", BRUTAS);
  await expectChain(page, "(−) Descontos", DESCONTO);

  // the discount of 10,00 is shared by the value of the lines: bottle 776 and mug 224 (the leftover cent goes to
  // the bigger remainder); 1 bottle gives back 4590 - 259 and 1 mug 1990 - 112
  await returnThroughDetail(
    page,
    saleId,
    {
      bottle: { restocked: "1", returned: "1" },
      mug: { restocked: "1", returned: "1" },
    },
    2
  );
  await expect
    .poll(read)
    .toMatchObject({ bottle: 8, mug: 9, records: 1, returned: 2 });

  await page.goto("/dashboard");
  await expectChain(page, "(−) Devoluções", 4331 + 1878);
  await expectChain(page, "(=) Vendas líquidas", 10_541);

  // the rest in another return: the total is the whole share (776 + 224), not 3 times the first rounding
  await returnThroughDetail(
    page,
    saleId,
    {
      bottle: { restocked: "2", returned: "2" },
      mug: { restocked: "1", returned: "1" },
    },
    3
  );
  await expect
    .poll(read)
    .toMatchObject({ bottle: 10, mug: 10, records: 2, returned: 5 });

  await page.goto("/dashboard");
  await expectChain(page, "(−) Devoluções", BRUTAS - DESCONTO);
  await expectChain(page, "(=) Vendas líquidas", 0);
});

test("devolução sem reposição: o banco guarda a devolução sem movimento nem saldo e o CMV não cai", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "devolucao-avariada", {
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  const { read, saleId } = await seeded(journey, sql);

  await page.goto("/dashboard");
  await expectChain(page, CMV, CMV_OF_SALE);

  await returnThroughDetail(
    page,
    saleId,
    { mug: { restocked: "0", returned: "1" } },
    0
  );
  // the record of the return exists; no return movement, and the balances are the ones after the sale
  await expect.poll(read).toMatchObject({
    bottle: 7,
    mug: 8,
    movements: 0,
    records: 1,
    restocked: 0,
    returned: 1,
  });

  await page.goto("/dashboard");
  await expectChain(page, "(−) Devoluções", 1990);
  await expectChain(page, CMV, CMV_OF_SALE);
});

test("devolução com reposição: a unidade que volta ao estoque sai do CMV", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "devolucao-reposta", {
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  const { read, saleId } = await seeded(journey, sql);

  await returnThroughDetail(
    page,
    saleId,
    { mug: { restocked: "1", returned: "1" } },
    1
  );
  await expect.poll(read).toMatchObject({
    bottle: 7,
    mug: 9,
    movements: 1,
    records: 1,
    restocked: 1,
    returned: 1,
  });

  await page.goto("/dashboard");
  await expectChain(page, CMV, CMV_OF_SALE - 800);
});

test("devolver e cancelar se excluem: venda com devolução não se cancela por inteiro e venda cancelada não recebe devolução", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "devolucao-exclusao", {
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  const { rpc } = journey.user;
  const { organizationId, read, readSale, saleId, sell } = await seeded(
    journey,
    sql
  );

  const returned = await rpc.sale.return({
    commandId: nextCommandId(),
    commandVersion: 1,
    items: [{ position: 1, restockedQuantity: 1, returnedQuantity: 1 }],
    organizationId,
    saleId,
  });
  expect(returned.replayed).toBe(false);
  const afterReturn = await read();
  expect(afterReturn).toMatchObject({
    bottle: 7,
    cancelled: 0,
    mug: 9,
    movements: 1,
    records: 1,
  });

  // on screen the detail offers the return and no longer offers the cancellation
  await page.goto(`/sales/detail?saleId=${saleId}`);
  await page.getByRole("button", { exact: true, name: "Ações" }).click();
  await expect(
    page.getByRole("menuitem", { exact: true, name: "Registrar devolução" })
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { exact: true, name: "Cancelar venda" })
  ).toHaveCount(0);

  // and the server refuses it, the sale stays as it is
  const cancelRefused = await refusal(
    rpc.sale.cancel({
      commandId: nextCommandId(),
      commandVersion: 1,
      organizationId,
      saleId,
    })
  );
  expect(cancelRefused.code).toMatch(BUSINESS_REFUSAL);
  expect(cancelRefused.reason).toBe("sale_has_returns");
  expect(await read()).toEqual(afterReturn);

  // a second sale, cancelled: the stock of its lines is back and a return of it is refused
  const cancelledId = await sell();
  await rpc.sale.cancel({
    commandId: nextCommandId(),
    commandVersion: 1,
    organizationId,
    saleId: cancelledId,
  });
  const afterCancel = await readSale(cancelledId);
  expect(afterCancel).toMatchObject({
    bottle: 7,
    cancelled: 1,
    mug: 9,
    movements: 1,
    records: 0,
  });
  const returnRefused = await refusal(
    rpc.sale.return({
      commandId: nextCommandId(),
      commandVersion: 1,
      items: [{ position: 0, restockedQuantity: 1, returnedQuantity: 1 }],
      organizationId,
      saleId: cancelledId,
    })
  );
  expect(returnRefused.code).toMatch(BUSINESS_REFUSAL);
  expect(returnRefused.reason).toBe("sale_not_returnable");
  expect(await readSale(cancelledId)).toEqual(afterCancel);

  await page.goto(`/sales/detail?saleId=${cancelledId}`);
  await expect(
    page.getByText("Venda cancelada", { exact: true })
  ).toBeVisible();
  await page.getByRole("button", { exact: true, name: "Ações" }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(
    page.getByRole("menuitem", { exact: true, name: "Registrar devolução" })
  ).toHaveCount(0);
  await expect(
    page.getByRole("menuitem", { exact: true, name: "Cancelar venda" })
  ).toHaveCount(0);
});
