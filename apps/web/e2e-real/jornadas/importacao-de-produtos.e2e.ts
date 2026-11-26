import type { Locator, Page } from "@playwright/test";
import { extremeTimeZone, localDate } from "../calendar";
import { expect, openJourney, runT0, test } from "../fixtures";
import { cents, numericCents } from "../oracle";

type Sql = Parameters<Parameters<typeof test>[2]>[0]["sql"];

const IMPORT_DIALOG = "Importar planilha";
const SHIRT = "Camiseta básica";
const SOCKS = "Meia listrada";
const BAD_ROW = "Boné";
const BELT = "Cinto de couro";
const SHIRT_PRICE = "49,90";
const SOCKS_PRICE = "12,00";

/** Three rows: two valid, with a price and an opening stock, and one whose price is not a value in reais. */
const FILE_LINES = [
  "Nome;Preço de tabela;Quantidade;Custo de cada unidade",
  `${SHIRT};${SHIRT_PRICE};10;12,50`,
  `${BAD_ROW};abc;;`,
  `${SOCKS};${SOCKS_PRICE};4;3,25`,
] as const;

interface ProductRow {
  balance: number | null;
  listPrice: string | null;
  movementOrganizations: string[];
  movements: { delta: number; on: string; unitCost: string | null }[];
  name: string;
  organizationId: string;
  variantOrganizations: string[];
  variants: number;
}

const dialogOf = (page: Page) =>
  page.getByRole("dialog", { name: IMPORT_DIALOG });

const statusIn = (dialog: Locator, text: string | RegExp) =>
  dialog.getByRole("status").filter({ hasText: text });

async function chooseFile(page: Page, lines: readonly string[] = FILE_LINES) {
  await dialogOf(page)
    .locator('input[type="file"]')
    .setInputFiles({
      buffer: Buffer.from(`${lines.join("\r\n")}\r\n`, "utf8"),
      mimeType: "text/csv",
      name: "produtos.csv",
    });
  await expect(dialogOf(page).getByText("produtos.csv")).toBeVisible();
}

const expectLines = (dialog: Locator, lines: readonly string[]) =>
  Promise.all(
    lines.map((line) =>
      expect(dialog.getByText(line, { exact: true })).toBeVisible()
    )
  );

/** The sale screen finds the product by its name and fills the list price on the line (the draft keeps the lines). */
async function findOnSale(
  page: Page,
  position: number,
  name: string,
  price: string
) {
  const item = page.getByRole("group", { name: `Item ${position}` });
  await item.getByLabel("Produto ou variante").fill(name);
  const option = page
    .getByRole("listbox", { name: "Variantes encontradas" })
    .getByRole("option", { name: new RegExp(name) });
  await expect(option).toBeVisible();
  await option.click();
  await expect(item.getByLabel("Preço de tabela")).toHaveValue(price);
}

async function productCount(sql: Sql, organizationId: string) {
  const { rows } = await sql.query<{ total: number }>(
    "SELECT count(*)::int AS total FROM products WHERE organization_id = $1",
    [organizationId]
  );
  return rows[0]?.total;
}

async function productsOf(sql: Sql, organizationId: string) {
  const { rows } = await sql.query<{
    balance: number | null;
    list_price: string | null;
    movement_organizations: string[];
    movements: { delta: number; on: string; unitCost: string | null }[];
    name: string;
    organization_id: string;
    variant_organizations: string[];
    variants: number;
  }>(
    `SELECT p.name, p.organization_id,
            (SELECT count(*)::int FROM product_variants v WHERE v.product_id = p.id) AS variants,
            (SELECT array_agg(v.organization_id) FROM product_variants v WHERE v.product_id = p.id) AS variant_organizations,
            (SELECT v.list_price::text FROM product_variants v WHERE v.product_id = p.id) AS list_price,
            (SELECT sum(b.quantity)::int FROM inventory_balances b WHERE b.product_id = p.id) AS balance,
            COALESCE((SELECT json_agg(json_build_object('delta', m.quantity_delta, 'on', m.occurred_on::text, 'unitCost', m.unit_cost::text))
                        FROM stock_movements m WHERE m.product_id = p.id), '[]'::json) AS movements,
            COALESCE((SELECT array_agg(m.organization_id) FROM stock_movements m WHERE m.product_id = p.id), '{}') AS movement_organizations
       FROM products p WHERE p.organization_id = $1 ORDER BY p.name`,
    [organizationId]
  );
  return rows.map(
    (row): ProductRow => ({
      balance: row.balance,
      listPrice: row.list_price,
      movementOrganizations: row.movement_organizations,
      movements: row.movements,
      name: row.name,
      organizationId: row.organization_id,
      variantOrganizations: row.variant_organizations,
      variants: row.variants,
    })
  );
}

/**
 * The import of a spreadsheet against the database. A file of three rows (two valid, one with an invalid
 * price): the preview counts them and writes nothing, only the confirmation creates the two products, each with its
 * default variant, its list price in cents and its opening stock (one receipt, dated today in the organization's
 * zone), all of the same organization; the products are on the list and on the sale screen. The same file again
 * creates nothing: its valid rows are "already exist" (docs/business-rules/products.md). The send goes one row per call,
 * with the pause of `IMPORT_CALL_INTERVAL_MS` between calls, which the test waits for as the lab spec does (nothing
 * of the pause is shortened).
 */
test("importação de planilha: a prévia não grava, a confirmação cria 2 produtos com variante, preço e estoque, e o mesmo arquivo de novo não cria nada", async ({
  browser,
  sql,
}, testInfo) => {
  test.setTimeout(120_000);
  const zone = extremeTimeZone(runT0());
  const journey = await openJourney(browser, testInfo, "importacao", {
    organization: { timezone: zone },
  });
  const { page } = journey;
  const organizationId = journey.organizationId as string;
  const today = localDate(runT0(), zone);

  await page.goto("/products");
  await page.getByRole("button", { name: IMPORT_DIALOG }).click();
  const dialog = dialogOf(page);
  await expect(dialog.getByText("Passo 1 de 4 · Arquivo")).toBeVisible();
  await chooseFile(page);
  await dialog.getByRole("button", { name: "Ver a prévia" }).click();

  await expect(dialog.getByText("Passo 2 de 4 · Prévia")).toBeVisible();
  await expectLines(dialog, [
    "3 linhas no arquivo",
    "2 vão entrar",
    "1 com erro (não entra)",
  ]);
  await expect(
    dialog
      .getByRole("table", { name: "Linhas do arquivo: Com erro" })
      .getByRole("row", { name: new RegExp(BAD_ROW) })
  ).toContainText("Preço de tabela: Informe um valor em reais, como 59,90.");
  // the preview wrote nothing
  expect(await productCount(sql, organizationId)).toBe(0);

  await dialog.getByRole("button", { name: "Importar 2 produtos" }).click();
  await expect(statusIn(dialog, "Importamos 2 produtos.")).toBeVisible({
    timeout: 60_000,
  });
  await expect(statusIn(dialog, "1 linha não entrou.")).toBeVisible();

  const unitCostOf = (name: string) => (name === SHIRT ? "12.50" : "3.25");
  const products = await productsOf(sql, organizationId);
  expect(products.map((product) => product.name)).toEqual([SHIRT, SOCKS]);
  for (const product of products) {
    const isShirt = product.name === SHIRT;
    expect(product.organizationId).toBe(organizationId);
    expect(product.variants).toBe(1);
    expect(product.variantOrganizations).toEqual([organizationId]);
    expect(cents(isShirt ? SHIRT_PRICE : SOCKS_PRICE)).toBe(
      numericCents(product.listPrice ?? "")
    );
    expect(product.balance).toBe(isShirt ? 10 : 4);
    expect(product.movementOrganizations).toEqual([organizationId]);
    expect(product.movements).toHaveLength(1);
    const [movement] = product.movements;
    expect(movement?.delta).toBe(isShirt ? 10 : 4);
    expect(movement?.on).toBe(today);
    expect(numericCents(movement?.unitCost ?? "")).toBe(
      numericCents(unitCostOf(product.name))
    );
  }

  // the list of Produtos and the sale screen show the two
  await page.goto("/products");
  await Promise.all(
    [SHIRT, SOCKS].map((name) =>
      expect(page.locator("[data-product-id]", { hasText: name })).toBeVisible()
    )
  );
  await expect(
    page.locator("[data-product-id]", { hasText: BAD_ROW })
  ).toHaveCount(0);
  await page.goto("/sales");
  await findOnSale(page, 1, SHIRT, SHIRT_PRICE);
  await page.getByRole("button", { name: "Adicionar item" }).click();
  await findOnSale(page, 2, SOCKS, SOCKS_PRICE);

  // the same file again: both valid rows already exist, nothing is sent and nothing is created
  await page.goto("/products");
  await page.getByRole("button", { name: IMPORT_DIALOG }).click();
  await chooseFile(page);
  await dialogOf(page).getByRole("button", { name: "Ver a prévia" }).click();
  await expect(dialogOf(page).getByText("Passo 2 de 4 · Prévia")).toBeVisible();
  await expectLines(dialogOf(page), [
    "3 linhas no arquivo",
    "0 vão entrar",
    "2 já existem (ficam como estão)",
    "1 com erro (não entra)",
  ]);
  await expect(
    dialogOf(page).getByRole("button", { name: "Importar 0 produtos" })
  ).toHaveAttribute("aria-disabled", "true");
  expect(await productCount(sql, organizationId)).toBe(2);
  expect(await productsOf(sql, organizationId)).toEqual(products);

  // a file with a row of a product that exists (another price and stock) and a new one: only the new one is created,
  // the existing one stays exactly as it was
  await page.goto("/products");
  await page.getByRole("button", { name: IMPORT_DIALOG }).click();
  await chooseFile(page, [
    FILE_LINES[0],
    `${SHIRT};99,90;50;1,00`,
    `${BELT};35,00;3;9,00`,
  ]);
  await dialogOf(page).getByRole("button", { name: "Ver a prévia" }).click();
  await expectLines(dialogOf(page), [
    "2 linhas no arquivo",
    "1 vai entrar",
    "1 já existe (fica como está)",
  ]);
  await dialogOf(page)
    .getByRole("button", { name: "Importar 1 produto" })
    .click();
  await expect(statusIn(dialogOf(page), "Importamos 1 produto.")).toBeVisible({
    timeout: 60_000,
  });
  const afterMixed = await productsOf(sql, organizationId);
  expect(afterMixed.map((product) => product.name).sort()).toEqual(
    [BELT, SHIRT, SOCKS].sort()
  );
  expect(afterMixed.filter((product) => product.name !== BELT)).toEqual(
    products
  );
  const belt = afterMixed.find((product) => product.name === BELT);
  expect(numericCents(belt?.listPrice ?? "")).toBe(cents("35,00"));
  expect(belt?.balance).toBe(3);
});
