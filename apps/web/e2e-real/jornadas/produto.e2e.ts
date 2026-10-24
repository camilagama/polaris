import { localDate } from "../calendar";
import { expect, openJourney, runT0, test } from "../fixtures";
import { cents, numericCents } from "../oracle";

const ZONE = "America/Sao_Paulo";
const UNIT_COST_12_50 = /^12\.50*$/;

/**
 * Journey 2: category and product with its default variant, a list price and the opening stock, on screen and in
 * ONE step of the form (AC-24): the price, the stock and its cost are what the database holds afterwards.
 */
test("produto: categoria, produto, preço e estoque de abertura num passo aparecem na lista e na venda", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "produto", {
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  const categoryName = "Camisetas";
  const productName = "Camiseta básica";
  const price = "59,90";

  await page.goto("/categories");
  await page.getByLabel("Nova categoria").fill(categoryName);
  await page.getByRole("button", { name: "Adicionar categoria" }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: `Categoria “${categoryName}” criada.` })
  ).toBeVisible();

  await page.goto("/products");
  await page.getByRole("button", { name: "Novo produto" }).first().click();
  await page.getByLabel("Nome do produto").fill(productName);
  await page.getByLabel("Preço de tabela").fill(price);
  await page.getByLabel("Quantos você tem agora").fill("10");
  await page.getByLabel("Custo de cada unidade").fill("12,50");
  // the category is under "Mais detalhes"
  await page.getByRole("button", { name: "Mais detalhes" }).click();
  await page.getByRole("combobox", { exact: true, name: "Categoria" }).click();
  await page.getByRole("option", { exact: true, name: categoryName }).click();
  await page.getByRole("button", { name: "Cadastrar produto" }).click();
  await expect(
    page.locator("[data-product-id]", { hasText: productName })
  ).toBeVisible();

  // the product, its variant with the price, the receipt with the cost and the balance, all from the one save
  await expect
    .poll(async () => {
      const { rows } = await sql.query<{
        balance: number | null;
        category: string | null;
        list_price: string | null;
        movements: number;
      }>(
        `SELECT v.list_price::text AS list_price, c.name AS category,
                  (SELECT quantity FROM inventory_balances b WHERE b.variant_id = v.id) AS balance,
                  (SELECT count(*)::int FROM stock_movements m WHERE m.variant_id = v.id) AS movements
             FROM products p
             JOIN product_variants v ON v.product_id = p.id
             LEFT JOIN categories c ON c.id = p.category_id
            WHERE p.organization_id = $1 AND p.name = $2`,
        [journey.organizationId, productName]
      );
      return rows.map((row) => ({
        balance: row.balance,
        category: row.category,
        movements: row.movements,
        price: row.list_price === null ? null : numericCents(row.list_price),
      }));
    })
    .toEqual([
      {
        balance: 10,
        category: categoryName,
        movements: 1,
        price: cents(price),
      },
    ]);
  const {
    rows: [receipt],
  } = await sql.query<{
    average_cost: string | null;
    movement_type: string;
    occurred_on: string;
    quantity_delta: number;
    unit_cost: string | null;
  }>(
    `SELECT m.movement_type, m.quantity_delta, m.unit_cost::text AS unit_cost, m.occurred_on::text AS occurred_on,
            b.moving_average_cost::text AS average_cost
       FROM stock_movements m
       JOIN products p ON p.id = m.product_id
       JOIN inventory_balances b ON b.variant_id = m.variant_id
      WHERE p.organization_id = $1 AND p.name = $2`,
    [journey.organizationId, productName]
  );
  expect(receipt).toMatchObject({
    movement_type: "receipt",
    quantity_delta: 10,
  });
  expect(receipt?.unit_cost).toMatch(UNIT_COST_12_50);
  expect(receipt?.average_cost).toMatch(UNIT_COST_12_50);
  expect(receipt?.occurred_on).toBe(localDate(runT0(), ZONE));

  // a quantity with no cost opens the stock with the cost unknown: a count from zero, and no average cost
  const withoutCost = "Caneca esmaltada";
  await page.getByRole("button", { name: "Novo produto" }).first().click();
  await page.getByLabel("Nome do produto").fill(withoutCost);
  await page.getByLabel("Quantos você tem agora").fill("4");
  await page.getByRole("button", { name: "Cadastrar produto" }).click();
  await expect(
    page.locator("[data-product-id]", { hasText: withoutCost })
  ).toBeVisible();
  await expect
    .poll(async () => {
      const { rows } = await sql.query<{
        average_cost: string | null;
        movement_type: string;
        quantity: number;
        unit_cost: string | null;
      }>(
        `SELECT m.movement_type, b.quantity, m.unit_cost::text AS unit_cost,
                  b.moving_average_cost::text AS average_cost
             FROM stock_movements m
             JOIN products p ON p.id = m.product_id
             JOIN inventory_balances b ON b.variant_id = m.variant_id
            WHERE p.organization_id = $1 AND p.name = $2`,
        [journey.organizationId, withoutCost]
      );
      return rows.map((row) => ({
        average_cost: row.average_cost,
        movement_type: row.movement_type,
        quantity: row.quantity,
        unit_cost: row.unit_cost,
      }));
    })
    .toEqual([
      {
        average_cost: null,
        movement_type: "inventory_count",
        quantity: 4,
        unit_cost: null,
      },
    ]);

  // the sale screen finds the first one, with the list price
  await page.goto("/sales");
  const item = page.getByRole("group", { name: "Item 1" });
  await item.getByLabel("Produto ou variante").fill("Camiseta");
  const option = item
    .getByRole("list", { name: "Variantes encontradas" })
    .getByRole("button", { name: new RegExp(productName) });
  await expect(option).toBeVisible();
  await option.click();
  await expect(item.getByLabel("Preço de tabela")).toHaveValue(price);
});
