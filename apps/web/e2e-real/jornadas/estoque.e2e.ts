import { localDate } from "../calendar";
import { expect, openJourney, refusedWith, runT0, test } from "../fixtures";
import { nextCommandId, seedCashSale, seedProduct } from "../seed";

// a refusal of the rule, not a lost session, a network error or a crash of the server
const BUSINESS_REFUSAL =
  /^(BAD_REQUEST|CONFLICT|UNPROCESSABLE_CONTENT|PRECONDITION_FAILED)$/;
const WRITE_OFF_ABOVE_BALANCE =
  /A baixa não pode ser maior que o saldo exibido \(10\)/;
const CLOSE_BUTTON = /^Fechar$/;
const UNIT_COST_12_50 = /^12\.50*$/;
const SEM_CUSTO = /sem custo$/;

const ZONE = "America/Sao_Paulo";

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
    name: `Informar custo de ${candle.productName} · Variante padrão`,
  });
  await expect(informCandle).toBeVisible();
  await expect(
    page.getByRole("button", {
      exact: true,
      name: `Informar custo de ${soap.productName} · Variante padrão`,
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
