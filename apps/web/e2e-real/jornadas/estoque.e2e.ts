import type { Locator, Page } from "@playwright/test";
import { pickDate } from "../../e2e/date-pickers";
import { addDays, localDate } from "../calendar";
import { expect, openJourney, refusedWith, runT0, test } from "../fixtures";
import { fillSale } from "../pages/venda";
import { nextCommandId, seedCashSale, seedProduct, seedStock } from "../seed";

// a refusal of the rule, not a lost session, a network error or a crash of the server
const BUSINESS_REFUSAL =
  /^(BAD_REQUEST|CONFLICT|UNPROCESSABLE_CONTENT|PRECONDITION_FAILED)$/;
const WRITE_OFF_ABOVE_BALANCE =
  /A baixa não pode ser maior que o saldo exibido \(10\)/;
const CLOSE_BUTTON = /^Fechar$/;
const UNIT_COST_12_50 = /^12\.50*$/;
const SEM_CUSTO = /sem custo$/;
const CAMISETA_OPTION = /Camiseta básica/;

const OTHER_NEEDS_A_NOTE = "Descreva o motivo em “Outro”.";
const COUNT_WITH_DIFFERENCE =
  /Contagem registrada \(\+2 unidades\)\. Saldo atual: 7/;
const COUNT_WITHOUT_DIFFERENCE =
  /Contagem registrada, sem diferença\. Saldo atual: 7/;
const UNIT_COST_16_447368 = /^16\.447368$/;

const ZONE = "America/Sao_Paulo";

type Sql = Parameters<Parameters<typeof test>[2]>[0]["sql"];

interface Movement {
  delta: number;
  note: string | null;
  occurredOn: string;
  physical: number | null;
  reason: string | null;
  type: string;
  unitCost: string | null;
}

/** The ledger of one variant in the order the server confirmed it. */
async function ledger(sql: Sql, variantId: string): Promise<Movement[]> {
  return (
    await sql.query<{
      delta: number;
      note: string | null;
      occurred_on: string;
      physical: number | null;
      reason: string | null;
      type: string;
      unit_cost: string | null;
    }>(
      `SELECT movement_type AS type, quantity_delta AS delta, reason_code AS reason, reason_note AS note,
              physical_quantity AS physical, unit_cost::text AS unit_cost, occurred_on::text AS occurred_on
         FROM stock_movements WHERE variant_id = $1 ORDER BY variant_sequence`,
      [variantId]
    )
  ).rows.map((row) => ({
    delta: row.delta,
    note: row.note,
    occurredOn: row.occurred_on,
    physical: row.physical,
    reason: row.reason,
    type: row.type,
    unitCost: row.unit_cost,
  }));
}

async function balanceOf(sql: Sql, variantId: string) {
  return (
    await sql.query<{ cost: string | null; quantity: number }>(
      "SELECT quantity, moving_average_cost::text AS cost FROM inventory_balances WHERE variant_id = $1",
      [variantId]
    )
  ).rows[0];
}

async function expenseCount(sql: Sql, organizationId: string) {
  return (
    await sql.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM expenses WHERE organization_id = $1",
      [organizationId]
    )
  ).rows[0]?.count;
}

/** The movement panel of a row: the trigger is named by the verb, the product and the variant. */
async function openStockPanel(
  page: Page,
  verb: "Baixar" | "Contar" | "Receber",
  productName: string
): Promise<void> {
  await page
    .getByRole("button", {
      exact: true,
      name: `${verb} estoque de ${productName}, Variante padrão`,
    })
    .click();
}

async function chooseReason(page: Page, option: string): Promise<void> {
  await page
    .getByRole("combobox", { exact: true, name: "Motivo da baixa" })
    .click();
  await page.getByRole("option", { exact: true, name: option }).click();
}

async function reviewAndConfirm(page: Page, confirm: string): Promise<void> {
  await page.getByRole("button", { name: "Revisar" }).click();
  await page.getByRole("button", { name: confirm }).click();
}

const successMessage = (page: Page, text: string | RegExp): Locator =>
  page.getByRole("status").filter({ hasText: text });

/** Half-up to six places of (units × cost + added × addedCost) / (units + added), all in integer micro-reais. */
function averageCostText(
  held: { cents: number; units: number },
  added: { cents: number; units: number }
): string {
  const numerator =
    BigInt(held.units * held.cents + added.units * added.cents) * 10_000n;
  const denominator = BigInt(held.units + added.units);
  const micro = (numerator * 2n + denominator) / (denominator * 2n);
  const whole = micro / 1_000_000n;
  return `${whole}.${String(micro % 1_000_000n).padStart(6, "0")}`;
}

/** Journey 3: a receipt with cost raises the balance; a write-off above it is refused and the balance stays. */
test("estoque: entrada com custo, saída maior que o saldo recusada e saldo intacto", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "estoque", {
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  const organizationId = journey.organizationId as string;
  const product = await seedProduct(
    journey.user.rpc,
    organizationId,
    "Caneca esmaltada",
    "35.00"
  );
  const balance = async () =>
    (
      await sql.query<{
        balance: number | null;
        movements: number | null;
        count: number;
      }>(
        `SELECT (SELECT quantity FROM inventory_balances WHERE variant_id = $1) AS balance,
                (SELECT sum(quantity_delta)::int FROM stock_movements WHERE variant_id = $1) AS movements,
                (SELECT count(*)::int FROM stock_movements WHERE variant_id = $1) AS count`,
        [product.variantId]
      )
    ).rows[0];

  await page.goto("/inventory");
  await page
    .getByRole("button", {
      name: `Dar entrada no estoque de ${product.productName}, Variante padrão`,
    })
    .click();
  await page.getByLabel("Quantidade recebida").fill("10");
  await page.getByLabel("Custo unitário (R$)").fill("12,50");
  await page.getByRole("button", { name: "Revisar" }).click();
  await page.getByRole("button", { name: "Confirmar recebimento" }).click();
  await expect.poll(balance).toEqual({ balance: 10, count: 1, movements: 10 });
  const [receipt] = (
    await sql.query<{ unit_cost: string; occurred_on: string }>(
      "SELECT unit_cost::text, occurred_on::text FROM stock_movements WHERE variant_id = $1",
      [product.variantId]
    )
  ).rows;
  expect(receipt?.unit_cost).toMatch(UNIT_COST_12_50);
  expect(receipt?.occurred_on).toBe(localDate(runT0(), ZONE));

  // on screen: a write-off above the balance is refused before it leaves
  await expect(
    page.getByText("Saldo: 10 unidades", { exact: false })
  ).toBeVisible();
  await page.getByRole("button", { name: CLOSE_BUTTON }).click();
  await page
    .getByRole("button", {
      name: `Baixar estoque de ${product.productName}, Variante padrão`,
    })
    .click();
  await page.getByLabel("Quantidade a baixar").fill("11");
  await page
    .getByRole("combobox", { exact: true, name: "Motivo da baixa" })
    .click();
  await page.getByRole("option", { exact: true, name: "Avariado" }).click();
  await page.getByRole("button", { name: "Revisar" }).click();
  await expect(page.getByText(WRITE_OFF_ABOVE_BALANCE)).toBeVisible();

  // and by the server, if a client sends it anyway
  expect(
    await refusedWith(
      journey.user.rpc.inventory.writeOffStock({
        commandId: nextCommandId(),
        commandVersion: 1,
        occurredOn: localDate(runT0(), ZONE),
        organizationId,
        quantity: 11,
        reasonCode: "damaged",
        variantId: product.variantId,
      })
    )
  ).toMatch(BUSINESS_REFUSAL);
  expect(await balance()).toEqual({ balance: 10, count: 1, movements: 10 });
});

/**
 * Informing the cost of units on hand (corte informar-custo-do-item-com-saldo, AC-1, AC-2, AC-3): two variants with
 * units and no cost, one sold today, and one with no units. The cost informed on one of them shows on its row, the
 * quantity stays, and "sem custo" goes down by one on the stock screen and on the Início.
 */
test("estoque: informar custo do item com saldo muda a linha, a faixa e o Início", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "estoque-custo", {
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  const organizationId = journey.organizationId as string;
  const { rpc } = journey.user;
  const today = localDate(runT0(), ZONE);
  const withUnits = async (name: string, quantity: number) => {
    const seeded = await seedProduct(rpc, organizationId, name, "30.00");
    await rpc.inventory.inventoryCount({
      commandId: nextCommandId(),
      commandVersion: 1,
      expectedVersion: 0,
      occurredOn: today,
      organizationId,
      physicalQuantity: quantity,
      variantId: seeded.variantId,
    });
    return seeded;
  };
  const candle = await withUnits("Vela de soja", 5);
  const soap = await withUnits("Sabonete de argila", 3);
  const towel = await seedProduct(rpc, organizationId, "Toalha de linho");
  await seedCashSale(
    rpc,
    organizationId,
    [{ price: "30.00", quantity: 1, variantId: candle.variantId }],
    new Date(runT0()).toISOString()
  );
  const candleBalance = async () =>
    (
      await sql.query<{
        cost: string | null;
        count: number;
        quantity: number | null;
      }>(
        `SELECT (SELECT quantity FROM inventory_balances WHERE variant_id = $1) AS quantity,
                (SELECT moving_average_cost::text FROM inventory_balances WHERE variant_id = $1) AS cost,
                (SELECT count(*)::int FROM stock_movements WHERE variant_id = $1) AS count`,
        [candle.variantId]
      )
    ).rows[0];
  expect(await candleBalance()).toEqual({ cost: null, count: 2, quantity: 4 });

  const attention = page.getByRole("region", { name: "Precisa de ação" });
  await page.goto("/");
  await expect(attention).toContainText("3 variantes sem custo");

  await page.goto("/inventory?filtro=sem-custo");
  const strip = page.getByRole("link", { name: SEM_CUSTO });
  await expect(strip).toHaveText("3 sem custo");
  const informCandle = page.getByRole("button", {
    exact: true,
    name: `Informar custo de ${candle.productName}, Variante padrão`,
  });
  await expect(informCandle).toBeVisible();
  await expect(
    page.getByRole("button", {
      exact: true,
      name: `Informar custo de ${soap.productName}, Variante padrão`,
    })
  ).toBeVisible();
  // no units: the way to a cost is the entry, which asks for it
  await expect(
    page.getByRole("button", {
      exact: true,
      name: `Dar entrada no estoque de ${towel.productName}, Variante padrão`,
    })
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: `Informar custo de ${towel.productName}`,
    })
  ).toHaveCount(0);

  await informCandle.click();
  const costField = page.getByLabel("Custo de cada unidade (R$)");
  await expect(costField).toBeFocused();
  await expect(
    page.getByText("Para as 4 unidades que você tem agora.")
  ).toBeVisible();
  await costField.fill("12,50");
  await page.getByRole("button", { name: "Revisar" }).click();
  await expect(
    page.getByText(
      "R$ 12,50 por unidade, para 4 unidades. Depois de confirmar, o custo não pode ser editado."
    )
  ).toBeVisible();
  await page.getByRole("button", { name: "Confirmar custo" }).click();
  await expect(
    page.getByRole("status").filter({
      hasText: "Custo informado: R$ 12,50 por unidade.",
    })
  ).toBeVisible();
  await expect
    .poll(candleBalance)
    .toEqual({ cost: "12.500000", count: 3, quantity: 4 });

  await page.getByRole("button", { name: CLOSE_BUTTON }).click();
  const candleRow = page
    .getByRole("listitem")
    .filter({ hasText: candle.productName });
  await expect(candleRow).toContainText("R$ 12,50");
  await expect(candleRow).not.toContainText("Custo desconhecido");
  await expect(
    candleRow.getByRole("button", {
      exact: true,
      name: `Contar estoque de ${candle.productName}, Variante padrão`,
    })
  ).toBeVisible();
  await expect(strip).toHaveText("2 sem custo");

  await page.goto("/");
  await expect(attention).toContainText("2 variantes sem custo");
});

/**
 * The average cost on screen is to the cent, half-up, while the balance keeps six decimals (ADR 0008): 18 units at
 * R$ 22,00 plus a receipt of 5 at R$ 10,00 make 19.391304, shown as "R$ 19,39" in the receipt message, on the
 * stock row and on the item line of the sale. The store is new on every run.
 */
test("estoque: o custo médio aparece ao centavo na mensagem, na linha e na Venda", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "estoque-centavos", {
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  const organizationId = journey.organizationId as string;
  const product = await seedProduct(
    journey.user.rpc,
    organizationId,
    "Camiseta básica",
    "30.00"
  );
  await seedStock(
    journey.user.rpc,
    organizationId,
    product.variantId,
    18,
    "22.00",
    localDate(runT0(), ZONE)
  );

  await page.goto("/inventory");
  await page
    .getByRole("button", {
      name: `Receber estoque de ${product.productName}, Variante padrão`,
    })
    .click();
  await page.getByLabel("Quantidade recebida").fill("5");
  await page.getByLabel("Custo unitário (R$)").fill("10,00");
  await page.getByRole("button", { name: "Revisar" }).click();
  await page.getByRole("button", { name: "Confirmar recebimento" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Custo médio: R$ 19,39." })
  ).toBeVisible();
  await expect
    .poll(
      async () =>
        (
          await sql.query<{ cost: string }>(
            "SELECT moving_average_cost::text AS cost FROM inventory_balances WHERE variant_id = $1",
            [product.variantId]
          )
        ).rows[0]?.cost
    )
    .toBe("19.391304");

  await page.getByRole("button", { name: CLOSE_BUTTON }).click();
  const row = page
    .getByRole("listitem")
    .filter({ hasText: product.productName });
  await expect(row).toContainText("R$ 19,39");
  await expect(row).not.toContainText("19,391304");

  await page.goto("/sales");
  await fillSale(
    page,
    [
      {
        charged: "30,00",
        option: CAMISETA_OPTION,
        quantity: 1,
        search: "Camiseta",
      },
    ],
    []
  );
  await expect(page.getByText("Custo médio: R$ 19,39.")).toBeVisible();
});

/**
 * A write-off that goes through (docs/business-rules/inventory.md, Baixa): 4 of 10 units at an average cost of
 * R$ 12,50, reason "Avariado". One movement of −4 with the reason, the cost snapshot is the average at the time and
 * the average itself does not move; no expense is created.
 */
test("estoque: baixa com motivo grava o movimento, mantém o custo médio e não cria despesa", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "estoque-baixa", {
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  const organizationId = journey.organizationId as string;
  const product = await seedProduct(
    journey.user.rpc,
    organizationId,
    "Caneca esmaltada",
    "35.00"
  );
  await seedStock(
    journey.user.rpc,
    organizationId,
    product.variantId,
    10,
    "12.50",
    localDate(runT0(), ZONE)
  );
  expect(await expenseCount(sql, organizationId)).toBe(0);

  await page.goto("/inventory");
  await openStockPanel(page, "Baixar", product.productName);
  await page.getByLabel("Quantidade a baixar").fill("4");
  await chooseReason(page, "Avariado");
  await reviewAndConfirm(page, "Confirmar baixa");
  await expect(
    successMessage(page, "Baixa registrada. Saldo atual: 6")
  ).toBeVisible();

  await expect
    .poll(() => balanceOf(sql, product.variantId))
    .toMatchObject({
      quantity: 6,
    });
  const balance = await balanceOf(sql, product.variantId);
  expect(balance?.cost).toMatch(UNIT_COST_12_50);
  const movements = await ledger(sql, product.variantId);
  expect(movements).toHaveLength(2);
  expect(movements[1]).toMatchObject({
    delta: -4,
    note: null,
    occurredOn: localDate(runT0(), ZONE),
    reason: "damaged",
    type: "write_off",
  });
  expect(movements[1]?.unitCost).toMatch(UNIT_COST_12_50);
  expect(await expenseCount(sql, organizationId)).toBe(0);
});

/**
 * "Outro (descreva)" asks for a note: without it the panel refuses on screen and nothing is written; with it, typed
 * with spaces at both ends, the note is stored trimmed.
 */
test("estoque: baixa por Outro exige a observação e grava a nota aparada", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "estoque-outro", {
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  const organizationId = journey.organizationId as string;
  const product = await seedProduct(
    journey.user.rpc,
    organizationId,
    "Vaso de cerâmica",
    "80.00"
  );
  await seedStock(
    journey.user.rpc,
    organizationId,
    product.variantId,
    10,
    "12.50",
    localDate(runT0(), ZONE)
  );

  await page.goto("/inventory");
  await openStockPanel(page, "Baixar", product.productName);
  await page.getByLabel("Quantidade a baixar").fill("2");
  await chooseReason(page, "Outro (descreva)");
  await page.getByRole("button", { name: "Revisar" }).click();
  await expect(page.getByText(OTHER_NEEDS_A_NOTE)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirmar baixa" })
  ).toHaveCount(0);
  expect(await ledger(sql, product.variantId)).toHaveLength(1);
  expect(await balanceOf(sql, product.variantId)).toMatchObject({
    quantity: 10,
  });

  await page
    .getByLabel("Observação (obrigatória para “Outro”)")
    .fill("   Caixa molhada no depósito   ");
  await reviewAndConfirm(page, "Confirmar baixa");
  await expect(
    successMessage(page, "Baixa registrada. Saldo atual: 8")
  ).toBeVisible();
  await expect.poll(() => ledger(sql, product.variantId)).toHaveLength(2);
  const movements = await ledger(sql, product.variantId);
  expect(movements[1]).toMatchObject({
    delta: -2,
    note: "Caixa molhada no depósito",
    reason: "other",
    type: "write_off",
  });
  expect(await balanceOf(sql, product.variantId)).toMatchObject({
    quantity: 8,
  });
});

/**
 * The count replaces the balance and stays in the history even with no difference: 5 counted as 7 is an adjustment
 * of +2; counting 7 again writes a movement of delta 0.
 */
test("estoque: contagem substitui o saldo e a sem diferença fica no histórico", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "estoque-contagem", {
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  const organizationId = journey.organizationId as string;
  const product = await seedProduct(
    journey.user.rpc,
    organizationId,
    "Pote de vidro",
    "20.00"
  );
  await seedStock(
    journey.user.rpc,
    organizationId,
    product.variantId,
    5,
    "12.50",
    localDate(runT0(), ZONE)
  );

  await page.goto("/inventory");
  await openStockPanel(page, "Contar", product.productName);
  await page.getByLabel("Quantidade contada").fill("7");
  await reviewAndConfirm(page, "Confirmar contagem");
  await expect(successMessage(page, COUNT_WITH_DIFFERENCE)).toBeVisible();
  await expect.poll(() => ledger(sql, product.variantId)).toHaveLength(2);
  expect(await balanceOf(sql, product.variantId)).toMatchObject({
    quantity: 7,
  });
  expect((await ledger(sql, product.variantId))[1]).toMatchObject({
    delta: 2,
    physical: 7,
    type: "inventory_count",
  });

  await page.getByRole("button", { name: CLOSE_BUTTON }).click();
  await openStockPanel(page, "Contar", product.productName);
  await page.getByLabel("Quantidade contada").fill("7");
  await reviewAndConfirm(page, "Confirmar contagem");
  await expect(successMessage(page, COUNT_WITHOUT_DIFFERENCE)).toBeVisible();
  await expect.poll(() => ledger(sql, product.variantId)).toHaveLength(3);
  expect(await balanceOf(sql, product.variantId)).toMatchObject({
    quantity: 7,
  });
  expect((await ledger(sql, product.variantId))[2]).toMatchObject({
    delta: 0,
    physical: 7,
    type: "inventory_count",
  });
});

/**
 * A receipt dated yesterday does not rewrite the cost snapshot of a sale already made: 10 units at R$ 12,50, one sold
 * (snapshot 12,50), then 10 at R$ 20,00 with yesterday's date. The snapshot stays and the new average is
 * (9 × 1250 + 10 × 2000) / 19 half-up to six places, computed here in integers.
 */
test("estoque: recebimento com data de ontem não reescreve o custo da venda anterior", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "estoque-retroativo", {
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  const organizationId = journey.organizationId as string;
  const today = localDate(runT0(), ZONE);
  const yesterday = addDays(today, -1);
  const product = await seedProduct(
    journey.user.rpc,
    organizationId,
    "Camiseta básica",
    "30.00"
  );
  await seedStock(
    journey.user.rpc,
    organizationId,
    product.variantId,
    10,
    "12.50",
    today
  );
  const saleId = await seedCashSale(
    journey.user.rpc,
    organizationId,
    [{ price: "30.00", quantity: 1, variantId: product.variantId }],
    new Date(runT0()).toISOString()
  );
  const snapshot = async () =>
    (
      await sql.query<{ unit_cost: string }>(
        "SELECT unit_cost::text FROM sale_items WHERE sale_id = $1",
        [saleId]
      )
    ).rows[0]?.unit_cost;
  expect(await snapshot()).toMatch(UNIT_COST_12_50);

  await page.goto("/inventory");
  await openStockPanel(page, "Receber", product.productName);
  await page.getByLabel("Quantidade recebida").fill("10");
  await page.getByLabel("Custo unitário (R$)").fill("20,00");
  await pickDate(page, "Data", yesterday);
  await reviewAndConfirm(page, "Confirmar recebimento");
  await expect(
    successMessage(page, "Recebimento registrado. Saldo atual: 19")
  ).toBeVisible();

  const expectedAverage = averageCostText(
    { cents: 1250, units: 9 },
    { cents: 2000, units: 10 }
  );
  expect(expectedAverage).toMatch(UNIT_COST_16_447368);
  await expect
    .poll(() => balanceOf(sql, product.variantId))
    .toEqual({ cost: expectedAverage, quantity: 19 });
  expect(await snapshot()).toMatch(UNIT_COST_12_50);
  const movements = await ledger(sql, product.variantId);
  expect(movements.map((movement) => movement.type)).toEqual([
    "receipt",
    "sale",
    "receipt",
  ]);
  expect(movements[1]?.unitCost).toMatch(UNIT_COST_12_50);
  expect(movements[2]).toMatchObject({ delta: 10, occurredOn: yesterday });
});
