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

const SKU_SECTION = "SKU das variantes";
const REPEATED_VALUES = "Remova valores repetidos nesta opção.";

interface VariantRow {
  is_default: boolean;
  size: string | null;
  sku: string | null;
}

/** Version, variants (with SKU), stock and audit events of one product, read from the database. */
async function productState(sql: Sql, organizationId: string, name: string) {
  const { rows: products } = await sql.query<{
    configured: boolean;
    id: string;
    version: number;
  }>(
    `SELECT id, version, variants_configured_at IS NOT NULL AS configured
       FROM products WHERE organization_id = $1 AND name = $2`,
    [organizationId, name]
  );
  const [product] = products;
  if (products.length !== 1 || product === undefined) {
    throw new Error(`Expected one product named ${name}.`);
  }
  const { rows: variants } = await sql.query<VariantRow>(
    `SELECT v.is_default, v.sku, ov.name AS size
       FROM product_variants v
       LEFT JOIN variant_option_values vov ON vov.variant_id = v.id
       LEFT JOIN product_option_values ov ON ov.id = vov.option_value_id
      WHERE v.organization_id = $1 AND v.product_id = $2
      ORDER BY ov.name NULLS FIRST`,
    [organizationId, product.id]
  );
  const { rows: audits } = await sql.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM tenant_audit_event
      WHERE organization_id = $1 AND entity_id = $2 AND event_type = 'product.variants_configured'`,
    [organizationId, product.id]
  );
  const { rows: stock } = await sql.query<{
    balance: number | null;
    movements: number;
  }>(
    `SELECT (SELECT sum(quantity)::int FROM inventory_balances
              WHERE organization_id = $1 AND product_id = $2) AS balance,
            (SELECT count(*)::int FROM stock_movements
              WHERE organization_id = $1 AND product_id = $2) AS movements`,
    [organizationId, product.id]
  );
  return {
    audits: audits[0]?.total ?? 0,
    balance: stock[0]?.balance ?? null,
    configured: product.configured,
    id: product.id,
    movements: stock[0]?.movements ?? 0,
    variants,
    version: product.version,
  };
}

function runId(): string {
  const id = process.env.E2E_RUN_ID;
  if (id === undefined) {
    throw new Error("E2E_RUN_ID is missing: the global setup sets it.");
  }
  return id;
}

/** The oRPC code and the domain reason of a `configureVariants` over these sizes (one combination per distinct value, so only the option values can be refused), which the server must refuse. */
async function configureRefusal(
  journey: Awaited<ReturnType<typeof openJourney>>,
  product: { id: string; version: number },
  values: string[] = ["P", "M"]
): Promise<{ code: string; reason: string | undefined }> {
  try {
    await journey.user.rpc.product.configureVariants({
      expectedVersion: product.version,
      id: product.id,
      options: [{ name: "size", values }],
      organizationId: journey.organizationId as string,
      variants: [...new Set(values.map((size) => size.toLowerCase()))].map(
        (size) => ({ values: { size } })
      ),
    });
  } catch (error) {
    const { code, data } = error as {
      code?: string;
      data?: { reason?: string };
    };
    return { code: String(code), reason: data?.reason };
  }
  throw new Error("configureVariants was expected to be refused.");
}

async function createOnScreen(
  page: Page,
  name: string,
  openingStock?: string
): Promise<void> {
  await page.goto("/products");
  await page.getByRole("button", { name: "Novo produto" }).first().click();
  await page.getByLabel("Nome do produto").fill(name);
  await page.getByLabel("Preço de tabela").fill(PRICE);
  if (openingStock !== undefined) {
    await page.getByLabel("Quantos você tem agora").fill(openingStock);
    await page.getByLabel("Custo de cada unidade").fill("12,50");
  }
  await page.getByRole("button", { name: "Cadastrar produto" }).click();
  await expect(
    page.locator("[data-product-id]", { hasText: name })
  ).toBeVisible();
}

async function openVariants(page: Page, name: string) {
  await page.getByRole("button", { name: `Mais ações para ${name}` }).click();
  await page.getByRole("menuitem", { name: "Variantes" }).click();
  const dialog = page.getByRole("dialog", { name });
  await expect(dialog).toBeVisible();
  return dialog;
}

type Dialog = Awaited<ReturnType<typeof openVariants>>;

async function saveSku(
  dialog: Dialog,
  variant: string,
  sku: string
): Promise<void> {
  const section = dialog.getByRole("region", { name: SKU_SECTION });
  const label = `SKU · ${variant}`;
  await section.getByLabel(label, { exact: true }).fill(sku);
  await section
    .getByRole("listitem")
    .filter({ has: dialog.page().getByLabel(label, { exact: true }) })
    .getByRole("button", { name: "Salvar SKU" })
    .click();
}

async function fillSizes(dialog: Dialog, values: string): Promise<void> {
  await dialog.getByRole("checkbox", { name: "Tamanho" }).click();
  await dialog.getByLabel("Valores de Tamanho").fill(values);
}

/** The refused code has a space at the end and another case, so one run proves both normalizations. */
test("variantes: o SKU é único na loja sem diferenciar caixa e vale em outra loja", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "variantes-sku-unico", {
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  const organizationId = journey.organizationId as string;
  const original = `CAM-${runId()}`;
  const sameCode = ` ${original.toLowerCase()} `;

  await createOnScreen(page, PRODUCT);
  let dialog = await openVariants(page, PRODUCT);
  await fillSizes(dialog, "P\nM");
  await dialog
    .getByRole("button", { name: "Adicionar todas as combinações (2)" })
    .click();
  await dialog.getByRole("button", { name: "Salvar variantes" }).click();
  await expect(dialog.getByText(TWO_VARIANTS)).toBeVisible();

  const skuSection = dialog.getByRole("region", { name: SKU_SECTION });
  await saveSku(dialog, "Tamanho: P", original);
  await expect(skuSection.getByText("SKU salvo.")).toBeVisible();
  await expect
    .poll(
      async () => (await productState(sql, organizationId, PRODUCT)).variants
    )
    .toEqual([
      { is_default: false, size: "M", sku: null },
      { is_default: false, size: "P", sku: original },
    ]);

  await saveSku(dialog, "Tamanho: M", sameCode);
  const refusal = `O SKU ${sameCode.trim()} já está em uso por outra variante. Use outro código.`;
  await expect(skuSection.getByText(refusal)).toBeVisible();
  expect((await productState(sql, organizationId, PRODUCT)).variants).toEqual([
    { is_default: false, size: "M", sku: null },
    { is_default: false, size: "P", sku: original },
  ]);

  const other = await openJourney(browser, testInfo, "variantes-sku-unico-b", {
    organization: { timezone: ZONE },
  });
  const otherOrganization = other.organizationId as string;
  expect(otherOrganization).not.toBe(organizationId);
  await createOnScreen(other.page, PRODUCT);
  dialog = await openVariants(other.page, PRODUCT);
  await saveSku(dialog, "Variante padrão", sameCode);
  await expect(
    dialog.getByRole("region", { name: SKU_SECTION }).getByText("SKU salvo.")
  ).toBeVisible();
  await expect
    .poll(
      async () => (await productState(sql, otherOrganization, PRODUCT)).variants
    )
    .toEqual([{ is_default: true, size: null, sku: original.toLowerCase() }]);
});

/** The product version moves only with the configuration that passes, in the same transaction as its one audit event. */
test("variantes: a variante padrão com SKU recusa 'Salvar variantes' até limpar o SKU, e só a configuração que passa sobe a versão e audita", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "variantes-padrao-sku", {
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  const organizationId = journey.organizationId as string;
  const sku = `PAD-${runId()}`;

  await createOnScreen(page, PRODUCT);
  const dialog = await openVariants(page, PRODUCT);
  await saveSku(dialog, "Variante padrão", sku);
  await expect(dialog.getByText("SKU salvo.")).toBeVisible();
  await fillSizes(dialog, "P\nM");
  await dialog
    .getByRole("button", { name: "Adicionar todas as combinações (2)" })
    .click();

  await expect(
    dialog.getByText(
      "Limpe o SKU da variante padrão antes de configurar opções: a configuração a substitui."
    )
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Salvar variantes" })
  ).toBeDisabled();

  const before = await productState(sql, organizationId, PRODUCT);
  expect(before.variants).toEqual([{ is_default: true, size: null, sku }]);
  expect(before.configured).toBe(false);
  expect(await configureRefusal(journey, before)).toEqual({
    code: "CONFLICT",
    reason: "product_default_variant_sku_conflict",
  });
  expect(await productState(sql, organizationId, PRODUCT)).toEqual(before);

  await dialog
    .getByRole("button", { name: `Limpar SKU "${sku}" da variante padrão` })
    .click();
  await expect(
    dialog.getByText(`SKU "${sku}" apagado da variante padrão.`)
  ).toBeVisible();
  await expect
    .poll(
      async () => (await productState(sql, organizationId, PRODUCT)).variants
    )
    .toEqual([{ is_default: true, size: null, sku: null }]);
  const cleared = await productState(sql, organizationId, PRODUCT);
  expect(cleared.audits).toBe(0);
  expect(cleared.configured).toBe(false);

  await dialog.getByRole("button", { name: "Salvar variantes" }).click();
  await expect(dialog.getByText(TWO_VARIANTS)).toBeVisible();
  await expect
    .poll(() => productState(sql, organizationId, PRODUCT))
    .toMatchObject({
      audits: 1,
      configured: true,
      variants: [
        { is_default: false, size: "M", sku: null },
        { is_default: false, size: "P", sku: null },
      ],
      version: cleared.version + 1,
    });
});

/** The screen reloads the form silently on the refusal, so the proof is the 409 and the untouched database. */
test("variantes: a variante padrão com estoque recusa a configuração e o saldo segue como estava", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(
    browser,
    testInfo,
    "variantes-padrao-estoque",
    {
      organization: { timezone: ZONE },
    }
  );
  const { page } = journey;
  const organizationId = journey.organizationId as string;

  await createOnScreen(page, PRODUCT, "5");
  const before = await productState(sql, organizationId, PRODUCT);
  expect(before).toMatchObject({
    audits: 0,
    balance: 5,
    configured: false,
    movements: 1,
    variants: [{ is_default: true, size: null, sku: null }],
  });

  const dialog = await openVariants(page, PRODUCT);
  await fillSizes(dialog, "P\nM");
  await dialog
    .getByRole("button", { name: "Adicionar todas as combinações (2)" })
    .click();
  const answered = page.waitForResponse((response) =>
    response.url().includes("/rpc/product/configureVariants")
  );
  await dialog.getByRole("button", { name: "Salvar variantes" }).click();
  expect((await answered).status()).toBe(409);
  await expect(dialog.getByText(TWO_VARIANTS)).toHaveCount(0);
  expect(await productState(sql, organizationId, PRODUCT)).toEqual(before);

  expect(await configureRefusal(journey, before)).toEqual({
    code: "CONFLICT",
    reason: "product_default_variant_stock_history_conflict",
  });
  expect(await productState(sql, organizationId, PRODUCT)).toEqual(before);
});

test("variantes: valores repetidos na mesma opção (P e p) são recusados no campo e nada é gravado", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(
    browser,
    testInfo,
    "variantes-valor-repetido",
    {
      organization: { timezone: ZONE },
    }
  );
  const { page } = journey;
  const organizationId = journey.organizationId as string;

  await createOnScreen(page, PRODUCT);
  const before = await productState(sql, organizationId, PRODUCT);
  const dialog = await openVariants(page, PRODUCT);
  await fillSizes(dialog, "P\np");
  await expect(dialog.getByText(REPEATED_VALUES)).toBeVisible();
  await expect(dialog.getByLabel("Valores de Tamanho")).toHaveAttribute(
    "aria-invalid",
    "true"
  );
  await expect(
    dialog.getByRole("button", { name: "Salvar variantes" })
  ).toBeDisabled();
  expect(await productState(sql, organizationId, PRODUCT)).toEqual(before);

  expect(await configureRefusal(journey, before, ["P", "p"])).toEqual({
    code: "BAD_REQUEST",
    reason: "invalid_product_variant_configuration",
  });
  expect(await productState(sql, organizationId, PRODUCT)).toEqual(before);
});

/** The balance comes from a receipt made on the Estoque screen after the product exists: it blocks the configuration like opening stock does. */
test("variantes: o saldo da variante padrão vindo de uma entrada pelo Estoque também recusa a configuração", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(
    browser,
    testInfo,
    "variantes-padrao-entrada-estoque",
    {
      organization: { timezone: ZONE },
    }
  );
  const { page } = journey;
  const organizationId = journey.organizationId as string;

  await createOnScreen(page, PRODUCT);
  expect(await productState(sql, organizationId, PRODUCT)).toMatchObject({
    balance: null,
    configured: false,
    movements: 0,
  });

  await page.goto("/inventory");
  await receive(page, "Variante padrão", "4");
  await expect(
    termValue(stockRowOf(page, "Variante padrão"), "Saldo")
  ).toHaveText("4");
  await expect
    .poll(() => productState(sql, organizationId, PRODUCT))
    .toMatchObject({
      audits: 0,
      balance: 4,
      configured: false,
      movements: 1,
      variants: [{ is_default: true, size: null, sku: null }],
    });
  const before = await productState(sql, organizationId, PRODUCT);

  await page.goto("/products");
  const dialog = await openVariants(page, PRODUCT);
  await fillSizes(dialog, "P\nM");
  await dialog
    .getByRole("button", { name: "Adicionar todas as combinações (2)" })
    .click();
  const answered = page.waitForResponse((response) =>
    response.url().includes("/rpc/product/configureVariants")
  );
  await dialog.getByRole("button", { name: "Salvar variantes" }).click();
  expect((await answered).status()).toBe(409);
  expect(await productState(sql, organizationId, PRODUCT)).toEqual(before);

  expect(await configureRefusal(journey, before)).toEqual({
    code: "CONFLICT",
    reason: "product_default_variant_stock_history_conflict",
  });
  expect(await productState(sql, organizationId, PRODUCT)).toEqual(before);
});
