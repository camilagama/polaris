import { localDate } from "../calendar";
import { expect, openJourney, refusedWith, runT0, test } from "../fixtures";
import { nextCommandId, seedProduct } from "../seed";

// a refusal of the rule, not a lost session, a network error or a crash of the server
const BUSINESS_REFUSAL =
  /^(BAD_REQUEST|CONFLICT|UNPROCESSABLE_CONTENT|PRECONDITION_FAILED)$/;
const WRITE_OFF_ABOVE_BALANCE =
  /A baixa não pode ser maior que o saldo exibido \(10\)/;
const CLOSE_BUTTON = /^Fechar$/;
const UNIT_COST_12_50 = /^12\.50*$/;

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
      name: `Receber estoque de ${product.productName}, Variante padrão`,
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
  await page.getByLabel("Motivo da baixa").selectOption({ label: "Avariado" });
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
