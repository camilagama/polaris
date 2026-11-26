import type { Page } from "@playwright/test";
import { localDate } from "../calendar";
import { expect, openJourney, runT0, test } from "../fixtures";
import { stockRows } from "../pages/estoque-e-produto";
import { confirmSale, fillSale, termValue } from "../pages/venda";

const ZONE = "America/Sao_Paulo";
const PRODUCT = "Camiseta de duas variantes";
const PRICE = "40,00";
const TWO_VARIANTS = /^2 de \d+ variantes/;
const UNIT_COST_12_50 = /^12\.5(0+)?$/;
const SALE_OPTION_P = new RegExp(`${PRODUCT}.*\\bP\\b`);

type Sql = Parameters<Parameters<typeof test>[2]>[0]["sql"];

/** The balance and the movements of each variant of the product, by the value of its size. */
async function ledgerBySize(sql: Sql, organizationId: string) {
  const { rows } = await sql.query<{
    balance: number | null;
    movements: number;
    size: string;
    sold: number | null;
  }>(
    `SELECT ov.name AS size,
            (SELECT quantity FROM inventory_balances b WHERE b.variant_id = v.id) AS balance,
            (SELECT count(*)::int FROM stock_movements m WHERE m.variant_id = v.id) AS movements,
            (SELECT sum(-m.quantity_delta)::int FROM stock_movements m
              WHERE m.variant_id = v.id AND m.movement_type = 'sale') AS sold
       FROM products p
       JOIN product_variants v ON v.product_id = p.id
       JOIN variant_option_values vov ON vov.variant_id = v.id
       JOIN product_option_values ov ON ov.id = vov.option_value_id
      WHERE p.organization_id = $1 AND p.name = $2
      ORDER BY ov.name`,
    [organizationId, PRODUCT]
  );
  return rows;
}

async function receive(
  page: Page,
  size: string,
  quantity: string
): Promise<void> {
  await page
    .getByRole("button", {
      name: `Dar entrada no estoque de ${PRODUCT}, ${size}`,
    })
    .click();
  await page.getByLabel("Quantidade recebida").fill(quantity);
  await page.getByLabel("Custo unitário (R$)").fill("12,50");
  await page.getByRole("button", { name: "Revisar" }).click();
  await page.getByRole("button", { name: "Confirmar recebimento" }).click();
  await expect(
    page.getByText(`Saldo: ${quantity} unidades`, { exact: false })
  ).toBeVisible();
  await page.getByRole("button", { exact: true, name: "Fechar" }).click();
}

const stockRowOf = (page: Page, size: string) =>
  stockRows(page).filter({
    has: page.getByRole("link", {
      name: `${PRODUCT}, ${size}. Abrir o produto`,
    }),
  });

/**
 * A product with two variants (P and M) made on screen, each with its own opening stock, then one unit of P sold on
 * screen: the stock screen shows both with the right balance, the sale finds P with the list price the product was
 * created with, and it takes the unit from P only (screen and ledger), M untouched.
 */
test("produto com duas variantes: criar na tela, estoque de cada uma, vender uma baixa só ela", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "produto-variantes", {
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  const organizationId = journey.organizationId as string;

  await page.goto("/products");
  await page.getByRole("button", { name: "Novo produto" }).first().click();
  await page.getByLabel("Nome do produto").fill(PRODUCT);
  await page.getByLabel("Preço de tabela").fill(PRICE);
  await page.getByRole("button", { name: "Cadastrar produto" }).click();
  await expect(
    page.locator("[data-product-id]", { hasText: PRODUCT })
  ).toBeVisible();

  await page
    .getByRole("button", { name: `Mais ações para ${PRODUCT}` })
    .click();
  await page.getByRole("menuitem", { name: "Variantes" }).click();
  const dialog = page.getByRole("dialog", { name: PRODUCT });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("checkbox", { name: "Tamanho" }).click();
  await dialog.getByLabel("Valores de Tamanho").fill("P\nM");
  await dialog
    .getByRole("button", { name: "Adicionar todas as combinações (2)" })
    .click();
  await dialog.getByRole("button", { name: "Salvar variantes" }).click();
  await expect(dialog.getByText(TWO_VARIANTS)).toBeVisible();
  await dialog.getByRole("button", { name: "Fechar" }).first().click();

  await page.goto("/inventory");
  await receive(page, "P", "7");
  await receive(page, "M", "3");
  await expect(stockRows(page)).toHaveCount(2);
  await expect(termValue(stockRowOf(page, "P"), "Saldo")).toHaveText("7");
  await expect(termValue(stockRowOf(page, "M"), "Saldo")).toHaveText("3");
  expect(await ledgerBySize(sql, organizationId)).toEqual([
    { balance: 3, movements: 1, size: "M", sold: null },
    { balance: 7, movements: 1, size: "P", sold: null },
  ]);

  await page.goto("/sales");
  await fillSale(
    page,
    [
      {
        charged: PRICE,
        option: SALE_OPTION_P,
        quantity: 1,
        search: "Camiseta de",
      },
    ],
    []
  );
  await expect(
    page
      .getByRole("group", { exact: true, name: "Item 1" })
      .getByLabel("Preço de tabela")
  ).toHaveValue(PRICE);
  await confirmSale(page);

  await expect
    .poll(() => ledgerBySize(sql, organizationId))
    .toEqual([
      { balance: 3, movements: 1, size: "M", sold: null },
      { balance: 6, movements: 2, size: "P", sold: 1 },
    ]);
  const { rows: receipts } = await sql.query<{
    occurred_on: string;
    quantity_delta: number;
    size: string;
    unit_cost: string;
  }>(
    `SELECT ov.name AS size, m.quantity_delta, m.unit_cost::text AS unit_cost, m.occurred_on::text AS occurred_on
       FROM stock_movements m
       JOIN variant_option_values vov ON vov.variant_id = m.variant_id
       JOIN product_option_values ov ON ov.id = vov.option_value_id
      WHERE m.organization_id = $1 AND m.movement_type = 'receipt'
      ORDER BY ov.name`,
    [organizationId]
  );
  expect(
    receipts.map(({ quantity_delta, size }) => [size, quantity_delta])
  ).toEqual([
    ["M", 3],
    ["P", 7],
  ]);
  for (const receipt of receipts) {
    expect(receipt.unit_cost).toMatch(UNIT_COST_12_50);
    expect(receipt.occurred_on).toBe(localDate(runT0(), ZONE));
  }

  await page.goto("/inventory");
  await expect(stockRows(page)).toHaveCount(2);
  await expect(termValue(stockRowOf(page, "P"), "Saldo")).toHaveText("6");
  await expect(termValue(stockRowOf(page, "M"), "Saldo")).toHaveText("3");
});
