import type { Page } from "@playwright/test";
import { localDate } from "../calendar";
import { expect, openJourney, refusedWith, runT0, test } from "../fixtures";
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

const QUANTITY_FOR_COST =
  "Informe quantos você tem para guardar o custo, ou apague o custo.";
const PRICE_INVALID = "Informe um valor em reais, como 59,90.";
const NAME_INVALID = "Informe um nome de produto válido.";
const BELL = String.fromCodePoint(0x00_07);
const RIGHT_TO_LEFT_OVERRIDE = String.fromCodePoint(0x20_2e);

interface CatalogCounts {
  audits: number;
  balances: number;
  movements: number;
  products: number;
  variants: number;
}

async function catalogCounts(
  sql: Sql,
  organizationId: string
): Promise<CatalogCounts> {
  const { rows } = await sql.query(
    `SELECT (SELECT count(*)::int FROM products WHERE organization_id = $1) AS products,
            (SELECT count(*)::int FROM product_variants WHERE organization_id = $1) AS variants,
            (SELECT count(*)::int FROM inventory_balances WHERE organization_id = $1) AS balances,
            (SELECT count(*)::int FROM stock_movements WHERE organization_id = $1) AS movements,
            (SELECT count(*)::int FROM tenant_audit_event
              WHERE organization_id = $1 AND entity_type IN ('product', 'stock_movement')) AS audits`,
    [organizationId]
  );
  return rows[0] as CatalogCounts;
}

async function openNewProduct(page: Page) {
  await page.getByRole("button", { name: "Novo produto" }).first().click();
}

async function fillNewProduct(
  page: Page,
  fields: {
    cost?: string;
    name: string;
    price?: string;
    quantity?: string;
  }
) {
  await page.getByLabel("Nome do produto").fill(fields.name);
  if (fields.price !== undefined) {
    await page.getByLabel("Preço de tabela").fill(fields.price);
  }
  if (fields.quantity !== undefined) {
    await page.getByLabel("Quantos você tem agora").fill(fields.quantity);
  }
  if (fields.cost !== undefined) {
    await page.getByLabel("Custo de cada unidade").fill(fields.cost);
  }
}

const saveProduct = (page: Page) =>
  page.getByRole("button", { name: "Cadastrar produto" }).click();

const productCard = (page: Page, name: string) =>
  page.locator("[data-product-id]", { hasText: name });

/** A cost with no quantity has no stock to be the cost of: the field says so, and nothing is written. */
test("produto: custo sem quantidade é erro de campo e nada é gravado", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "produto-custo-so", {
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  const organizationId = journey.organizationId as string;
  const name = `Camiseta ${journey.name}`;
  const before = await catalogCounts(sql, organizationId);

  await page.goto("/products");
  await openNewProduct(page);
  await fillNewProduct(page, { cost: "12,50", name, price: "59,90" });
  await saveProduct(page);

  await expect(page.getByText(QUANTITY_FOR_COST)).toBeVisible();
  await expect(page.getByLabel("Quantos você tem agora")).toHaveAttribute(
    "aria-invalid",
    "true"
  );
  await expect(productCard(page, name)).toHaveCount(0);
  expect(await catalogCounts(sql, organizationId)).toEqual(before);
});

/** A price below zero or with three places is refused in the field, and nothing is written. */
test("produto: preço negativo ou com três casas é erro de campo e nada é gravado", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "produto-preco", {
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  const organizationId = journey.organizationId as string;
  const name = `Camiseta ${journey.name}`;
  const before = await catalogCounts(sql, organizationId);

  await page.goto("/products");
  await openNewProduct(page);
  await page.getByLabel("Nome do produto").fill(name);
  for (const price of ["-5", "1,999"]) {
    // biome-ignore lint/performance/noAwaitInLoops: one price after the other in the same open dialog
    await page.getByLabel("Preço de tabela").fill(price);
    await saveProduct(page);
    await expect(page.getByText(PRICE_INVALID)).toBeVisible();
    await expect(page.getByLabel("Preço de tabela")).toHaveAttribute(
      "aria-invalid",
      "true"
    );
    await expect(productCard(page, name)).toHaveCount(0);
    expect(await catalogCounts(sql, organizationId)).toEqual(before);
  }

  // the same dialog saves once the price reads: the refusals left nothing half done behind
  await page.getByLabel("Preço de tabela").fill("1,99");
  await saveProduct(page);
  await expect(productCard(page, name)).toBeVisible();
  await expect
    .poll(async () => {
      const { rows } = await sql.query<{ list_price: string }>(
        `SELECT v.list_price::text AS list_price
           FROM products p JOIN product_variants v ON v.product_id = p.id
          WHERE p.organization_id = $1 AND p.name = $2`,
        [organizationId, name]
      );
      return rows.map((row) => numericCents(row.list_price));
    })
    .toEqual([cents("1,99")]);
});

/**
 * A quantity of 0 is an empty quantity: only the product and its default variant are made, with no movement and no
 * balance, and the version starts at 1.
 */
test("produto: quantidade 0 cria só o produto e a variante padrão, sem movimento nem saldo", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "produto-qtd-zero", {
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  const organizationId = journey.organizationId as string;
  const name = `Camiseta ${journey.name}`;

  await page.goto("/products");
  await openNewProduct(page);
  await fillNewProduct(page, { name, quantity: "0" });
  await saveProduct(page);
  await expect(productCard(page, name)).toBeVisible();

  await expect
    .poll(async () => {
      const { rows } = await sql.query<{
        balances: number;
        movements: number;
        variants: number;
        version: number;
      }>(
        `SELECT p.version,
                (SELECT count(*)::int FROM product_variants v WHERE v.product_id = p.id) AS variants,
                (SELECT count(*)::int FROM stock_movements m WHERE m.product_id = p.id) AS movements,
                (SELECT count(*)::int FROM inventory_balances b WHERE b.product_id = p.id) AS balances
           FROM products p
          WHERE p.organization_id = $1 AND p.name = $2`,
        [organizationId, name]
      );
      return rows;
    })
    .toEqual([{ balances: 0, movements: 0, variants: 1, version: 1 }]);
  expect(await catalogCounts(sql, organizationId)).toMatchObject({
    balances: 0,
    movements: 0,
    products: 1,
    variants: 1,
  });
});

interface WholeProduct {
  balance: number | null;
  id: string;
  movementCost: string | null;
  movements: number;
  movementType: string | null;
  price: number | null;
  variants: number;
  version: number;
}

async function wholeProducts(
  sql: Sql,
  organizationId: string,
  name: string
): Promise<WholeProduct[]> {
  const { rows } = await sql.query(
    `SELECT p.id, p.version,
            (SELECT count(*)::int FROM product_variants v WHERE v.product_id = p.id) AS variants,
            (SELECT v.list_price::text FROM product_variants v WHERE v.product_id = p.id) AS price,
            (SELECT b.quantity FROM inventory_balances b WHERE b.product_id = p.id) AS balance,
            (SELECT count(*)::int FROM stock_movements m WHERE m.product_id = p.id) AS movements,
            (SELECT m.movement_type FROM stock_movements m WHERE m.product_id = p.id) AS movement_type,
            (SELECT m.unit_cost::text FROM stock_movements m WHERE m.product_id = p.id) AS movement_cost
       FROM products p
      WHERE p.organization_id = $1 AND p.name = $2
      ORDER BY p.id`,
    [organizationId, name]
  );
  const found = rows as {
    balance: number | null;
    id: string;
    movement_cost: string | null;
    movement_type: string | null;
    movements: number;
    price: string | null;
    variants: number;
    version: number;
  }[];
  return found.map((row) => ({
    balance: row.balance,
    id: row.id,
    movementCost: row.movement_cost,
    movements: row.movements,
    movementType: row.movement_type,
    price: row.price === null ? null : numericCents(row.price),
    variants: row.variants,
    version: row.version,
  }));
}

/**
 * Name, price, quantity and cost make everything at once: the product, its variant, the balance, the receipt and the
 * audit of each. The same name again is a second product: names repeat inside a store.
 */
test("produto: nome, preço, quantidade e custo criam tudo junto, e o mesmo nome de novo cria outro produto", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "produto-tudo-junto", {
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  const organizationId = journey.organizationId as string;
  const name = `Camiseta ${journey.name}`;
  const fields = { cost: "12,50", name, price: "59,90", quantity: "10" };
  const before = await catalogCounts(sql, organizationId);

  await page.goto("/products");
  await openNewProduct(page);
  await fillNewProduct(page, fields);
  await saveProduct(page);
  await expect(productCard(page, name)).toHaveCount(1);

  await expect
    .poll(async () => await catalogCounts(sql, organizationId))
    .toEqual({
      audits: before.audits + 2,
      balances: 1,
      movements: 1,
      products: 1,
      variants: 1,
    });
  const [first] = await wholeProducts(sql, organizationId, name);
  expect(first).toMatchObject({
    balance: 10,
    movements: 1,
    movementType: "receipt",
    price: cents("59,90"),
    variants: 1,
    version: 1,
  });
  expect(first?.movementCost).toMatch(UNIT_COST_12_50);
  const { rows: audits } = await sql.query<{
    entity_type: string;
    event_type: string;
  }>(
    `SELECT a.entity_type, a.event_type
       FROM tenant_audit_event a
      WHERE a.organization_id = $1 AND a.entity_type IN ('product', 'stock_movement')
      ORDER BY a.event_type`,
    [organizationId]
  );
  expect(audits).toEqual([
    {
      entity_type: "stock_movement",
      event_type: "inventory.movement_recorded",
    },
    { entity_type: "product", event_type: "product.created" },
  ]);

  await openNewProduct(page);
  await fillNewProduct(page, fields);
  await saveProduct(page);
  await expect(productCard(page, name)).toHaveCount(2);

  await expect
    .poll(async () => await wholeProducts(sql, organizationId, name))
    .toHaveLength(2);
  const both = await wholeProducts(sql, organizationId, name);
  expect(new Set(both.map((product) => product.id)).size).toBe(2);
  expect(both).toEqual([
    expect.objectContaining({ balance: 10, movements: 1, variants: 1 }),
    expect.objectContaining({ balance: 10, movements: 1, variants: 1 }),
  ]);
  expect(await catalogCounts(sql, organizationId)).toEqual({
    audits: before.audits + 4,
    balances: 2,
    movements: 2,
    products: 2,
    variants: 2,
  });
});

/**
 * A name with a control character or one that controls the direction of the text is refused, on the screen and by the
 * server, and nothing is written; a line break in the description is fine.
 */
test("produto: nome com caractere de controle ou de direção é recusado e nada é gravado; quebra de linha na descrição vale", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(
    browser,
    testInfo,
    "produto-nome-proibido",
    {
      organization: { timezone: ZONE },
    }
  );
  const { page, user } = journey;
  const organizationId = journey.organizationId as string;
  const base = `Camiseta ${journey.name}`;
  const before = await catalogCounts(sql, organizationId);

  await page.goto("/products");
  await openNewProduct(page);
  for (const forbidden of [BELL, RIGHT_TO_LEFT_OVERRIDE]) {
    const name = `${base}${forbidden}`;
    // biome-ignore lint/performance/noAwaitInLoops: one name after the other in the same open dialog
    await fillNewProduct(page, { name, price: "59,90" });
    await saveProduct(page);
    await expect(
      page.getByRole("alert").filter({ hasText: NAME_INVALID })
    ).toBeVisible();
    expect(await catalogCounts(sql, organizationId)).toEqual(before);
    const { rows } = await sql.query(
      "SELECT 1 FROM products WHERE organization_id = $1 AND name LIKE $2",
      [organizationId, `${base}%`]
    );
    expect(rows).toHaveLength(0);
  }

  for (const forbidden of [BELL, RIGHT_TO_LEFT_OVERRIDE]) {
    // biome-ignore lint/performance/noAwaitInLoops: one refusal after the other
    const code = await refusedWith(
      user.rpc.product.create({ name: `${base}${forbidden}`, organizationId })
    );
    expect(code).toBe("BAD_REQUEST");
  }
  expect(await catalogCounts(sql, organizationId)).toEqual(before);

  const description = "Primeira linha\nSegunda linha";
  await page.getByLabel("Nome do produto").fill(base);
  await page.getByRole("button", { name: "Mais detalhes" }).click();
  await page.getByLabel("Descrição").fill(description);
  await saveProduct(page);
  await expect(productCard(page, base)).toBeVisible();
  await expect
    .poll(async () => {
      const { rows } = await sql.query<{ description: string | null }>(
        "SELECT description FROM products WHERE organization_id = $1 AND name = $2",
        [organizationId, base]
      );
      return rows.map((row) => row.description);
    })
    .toEqual([description]);
});
