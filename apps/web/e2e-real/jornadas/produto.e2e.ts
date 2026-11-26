import type { Page } from "@playwright/test";
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
  const option = page
    .getByRole("listbox", { name: "Variantes encontradas" })
    .getByRole("option", { name: new RegExp(productName) });
  await expect(option).toBeVisible();
  await option.click();
  await expect(item.getByLabel("Preço de tabela")).toHaveValue(price);
});

const DUPLICATE_NAME = "Já existe uma categoria com esse nome nesta loja.";
const PRODUCTS_LINKED =
  "Desvincule os produtos desta categoria antes de removê-la.";

interface CategoryRow {
  archived: boolean;
  deleted: boolean;
  id: string;
  name: string;
  updated_at: string;
}

interface Sql {
  query: (text: string, values: string[]) => Promise<{ rows: unknown[] }>;
}

async function categoriesOf(
  sql: Sql,
  organizationId: string
): Promise<CategoryRow[]> {
  const { rows } = await sql.query(
    `SELECT id, name, archived_at IS NOT NULL AS archived, deleted_at IS NOT NULL AS deleted,
            updated_at::text AS updated_at
       FROM categories
      WHERE organization_id = $1
      ORDER BY name`,
    [organizationId]
  );
  return rows as CategoryRow[];
}

async function addCategory(page: Page, name: string) {
  await page.getByLabel("Nova categoria").fill(name);
  await page.getByRole("button", { name: "Adicionar categoria" }).click();
}

async function addCategoryAndWait(page: Page, name: string) {
  await addCategory(page, name);
  await expect(
    page.getByRole("status").filter({ hasText: `Categoria “${name}” criada.` })
  ).toBeVisible();
}

async function chooseRowAction(page: Page, name: string, action: string) {
  await page.getByRole("button", { name: `Mais ações para ${name}` }).click();
  await page.getByRole("menuitem", { exact: true, name: action }).click();
}

const categoryRow = (page: Page, name: string) =>
  page.locator("li[data-category-id]", { hasText: name });

const refusal = (page: Page, text: string) =>
  page.getByRole("alert").filter({ hasText: text });

async function showCategories(
  page: Page,
  tab: "Arquivadas" | "Ativas" | "Removidas"
) {
  const option = page
    .getByRole("tablist", { exact: true, name: "Estado das categorias" })
    .getByRole("tab", { exact: true, name: tab });
  await option.click();
  await expect(option).toHaveAttribute("aria-selected", "true");
}

/**
 * Category names are unique per organization without case or outer spaces, and a rename onto another name is refused
 * the same way: what the database holds does not change when the screen says "Já existe".
 */
test("categoria: nome repetido e renomear em cima de outra são recusados e não mudam o banco", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "categoria-nome", {
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  const organizationId = journey.organizationId as string;
  const first = `Camisetas ${journey.name}`;
  const second = `Bonés ${journey.name}`;

  await page.goto("/categories");
  await addCategoryAndWait(page, first);

  await addCategory(page, `  ${first.toLowerCase()}  `);
  await expect(refusal(page, DUPLICATE_NAME)).toBeVisible();
  expect(await categoriesOf(sql, organizationId)).toEqual([
    expect.objectContaining({ deleted: false, name: first }),
  ]);

  await addCategoryAndWait(page, second);
  const before = await categoriesOf(sql, organizationId);
  expect(before.map((row) => row.name)).toEqual([second, first]);

  await chooseRowAction(page, second, "Renomear");
  await page.getByLabel(`Novo nome para ${second}`).fill(first);
  await page.getByRole("button", { exact: true, name: "Salvar" }).click();
  await expect(refusal(page, DUPLICATE_NAME)).toBeVisible();
  expect(await categoriesOf(sql, organizationId)).toEqual(before);
});

/** Archiving takes the category off the active list and restoring brings the same row back, with the same id. */
test("categoria: arquivar e restaurar mantêm o mesmo id", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "categoria-arquivar", {
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  const organizationId = journey.organizationId as string;
  const name = `Camisetas ${journey.name}`;

  await page.goto("/categories");
  await addCategoryAndWait(page, name);
  const [created] = await categoriesOf(sql, organizationId);
  expect(created).toMatchObject({ archived: false, deleted: false, name });

  await chooseRowAction(page, name, "Arquivar");
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: `Categoria “${name}” arquivada.` })
  ).toBeVisible();
  await expect(categoryRow(page, name)).toHaveCount(0);
  expect(await categoriesOf(sql, organizationId)).toEqual([
    expect.objectContaining({
      archived: true,
      deleted: false,
      id: created?.id,
    }),
  ]);
  await showCategories(page, "Arquivadas");
  await expect(categoryRow(page, name)).toBeVisible();

  await chooseRowAction(page, name, "Restaurar");
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: `Categoria “${name}” restaurada.` })
  ).toBeVisible();
  expect(await categoriesOf(sql, organizationId)).toEqual([
    expect.objectContaining({
      archived: false,
      deleted: false,
      id: created?.id,
    }),
  ]);
  await showCategories(page, "Ativas");
  await expect(categoryRow(page, name)).toBeVisible();
});

/**
 * A category with a product cannot be removed; one without goes off the list but its row stays (a tombstone) and
 * its name stays reserved.
 */
test("categoria: remover com produto é recusado; sem produto vira tombstone e reserva o nome", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "categoria-remover", {
    organization: { timezone: ZONE },
  });
  const { page, user } = journey;
  const organizationId = journey.organizationId as string;
  const used = `Com produto ${journey.name}`;
  const free = `Sem produto ${journey.name}`;
  const productName = `Camiseta ${journey.name}`;

  const usedCategory = await user.rpc.category.create({
    name: used,
    organizationId,
  });
  await user.rpc.product.create({
    categoryId: usedCategory.id,
    name: productName,
    organizationId,
  });

  await page.goto("/categories");
  await addCategoryAndWait(page, free);

  await chooseRowAction(page, used, "Remover");
  await page.getByRole("button", { name: "Remover categoria" }).click();
  await expect(refusal(page, PRODUCTS_LINKED)).toBeVisible();
  expect(await categoriesOf(sql, organizationId)).toEqual([
    expect.objectContaining({
      deleted: false,
      id: usedCategory.id,
      name: used,
    }),
    expect.objectContaining({ deleted: false, name: free }),
  ]);
  const { rows: linked } = await sql.query<{ category_id: string }>(
    "SELECT category_id FROM products WHERE organization_id = $1 AND name = $2",
    [organizationId, productName]
  );
  expect(linked).toEqual([{ category_id: usedCategory.id }]);

  await page.getByRole("button", { name: "Cancelar" }).click();
  await chooseRowAction(page, free, "Remover");
  await page.getByRole("button", { name: "Remover categoria" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: `Categoria “${free}” removida` })
  ).toBeVisible();
  await expect(categoryRow(page, free)).toHaveCount(0);
  expect(await categoriesOf(sql, organizationId)).toEqual([
    expect.objectContaining({
      deleted: false,
      id: usedCategory.id,
      name: used,
    }),
    expect.objectContaining({ deleted: true, name: free }),
  ]);

  await showCategories(page, "Removidas");
  await expect(categoryRow(page, free)).toContainText(
    "Histórico preservado; não pode ser restaurada."
  );
  await showCategories(page, "Ativas");

  await addCategory(page, free);
  await expect(refusal(page, DUPLICATE_NAME)).toBeVisible();
  expect(await categoriesOf(sql, organizationId)).toHaveLength(2);

  await addCategory(page, free.toUpperCase());
  await expect(refusal(page, DUPLICATE_NAME)).toBeVisible();
  expect(await categoriesOf(sql, organizationId)).toHaveLength(2);

  await addCategory(page, `  ${free}  `);
  await expect(refusal(page, DUPLICATE_NAME)).toBeVisible();
  expect(await categoriesOf(sql, organizationId)).toHaveLength(2);
});
