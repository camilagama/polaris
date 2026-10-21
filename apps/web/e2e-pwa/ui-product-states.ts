/// <reference lib="dom" />
// Only types from Playwright: `ui-screens.ts` is read under Vitest by the source rules.
import type { Page, Route } from "@playwright/test";

/**
 * The states of the products screen the interface guardrails measure: the screen in the lab of the screens
 * (`/offline-screens-lab?screen=products`) over the real offline runtime, with the catalog the lab seeds
 * (`&catalog=seeded`: five active products, one archived, two categories) or empty, and the variants answered by
 * the test (`page.route`). Synthetic data only. The lab's own controls are hidden at the end of each state, so what
 * is measured is the screen alone. The states that need the server mode (loading, the list failing to load) are in
 * `e2e/products-screen.e2e.ts`: the lab always has the device's collections.
 */
const id = (n: number) => `0199c2d0-0000-7000-8000-0000000000${n}`;
const PRODUCT_ID = id(21);

const rpc = (body: unknown) => ({
  body: JSON.stringify({ json: body, meta: [] }),
  contentType: "application/json",
});

const DEFAULT_CONFIGURATION = {
  configured: false,
  optionValues: [],
  productId: PRODUCT_ID,
  productVersion: 1,
  variants: [
    {
      id: id(31),
      isDefault: true,
      listPrice: "50.00",
      sku: "CAM-001",
      values: [],
      version: 1,
    },
  ],
};

const CONFIGURED = {
  configured: true,
  optionValues: [
    { optionName: "color", optionValueName: "Azul" },
    { optionName: "color", optionValueName: "Preta" },
  ],
  productId: PRODUCT_ID,
  productVersion: 2,
  variants: [
    {
      id: id(32),
      isDefault: false,
      listPrice: "50.00",
      sku: "CAM-AZ",
      values: [{ optionName: "color", optionValueName: "Azul" }],
      version: 1,
    },
    {
      id: id(33),
      isDefault: false,
      listPrice: null,
      sku: null,
      values: [{ optionName: "color", optionValueName: "Preta" }],
      version: 1,
    },
  ],
};

const serveVariants = (page: Page, configuration: unknown) =>
  page.route("**/rpc/product/getVariants", (route: Route) =>
    route.fulfill(rpc(configuration))
  );

const menuOf = (page: Page, name: string) =>
  page.getByRole("button", { name: `Mais ações para ${name}` });

/** Starts the lab's runtime and waits for the screen. */
async function openProductsLab(
  page: Page,
  {
    configuration = DEFAULT_CONFIGURATION,
    seeded = true,
  }: { configuration?: unknown; seeded?: boolean } = {}
) {
  await serveVariants(page, configuration);
  await page.goto(
    `/offline-screens-lab?screen=products${seeded ? "&catalog=seeded" : ""}`
  );
  await page.getByLabel("Usuário").fill(`guardrails-${crypto.randomUUID()}`);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await page
    .getByTestId("message")
    .filter({ hasText: "Iniciar: ok (ready)" })
    .waitFor({ timeout: 20_000 });
  await page.getByRole("heading", { exact: true, name: "Produtos" }).waitFor();
  if (seeded) {
    await page.getByText("Calça jeans").waitFor();
  }
}

/** Hides the lab's own controls and waits for the fonts: what stays is the screen. */
async function showScreenAlone(page: Page) {
  await page.evaluate(() => {
    for (const element of document.querySelectorAll("[data-lab-chrome]")) {
      (element as HTMLElement).hidden = true;
    }
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

async function openVariants(page: Page, name = "Camiseta do teste") {
  await menuOf(page, name).click();
  await page.getByRole("menuitem", { name: "Variantes" }).click();
  await page
    .getByRole("heading", { level: 3, name: "SKU das variantes" })
    .waitFor();
}

export const productStates = {
  /** The archived list. */
  async archived(page: Page) {
    await openProductsLab(page);
    await page.getByRole("button", { name: "Arquivados" }).click();
    await page.getByText("Jaqueta de inverno").waitFor();
    await showScreenAlone(page);
  },

  /** The edit of a product: the form with its name, category and description. */
  async edit(page: Page) {
    await openProductsLab(page);
    await menuOf(page, "Camiseta do teste").click();
    await page.getByRole("menuitem", { name: "Editar" }).click();
    await page.getByRole("heading", { name: "Editar produto" }).waitFor();
    await showScreenAlone(page);
  },

  /** No product yet. */
  async empty(page: Page) {
    await openProductsLab(page, { seeded: false });
    await page.getByText("Nenhum produto ainda").waitFor();
    await showScreenAlone(page);
  },

  /** The search with no match. */
  async emptySearch(page: Page) {
    await openProductsLab(page);
    await page.getByLabel("Buscar produto").fill("tenis");
    await page.getByText("Nenhum produto com").waitFor();
    await showScreenAlone(page);
  },

  /** The list of the seeded catalog. */
  async list(page: Page) {
    await openProductsLab(page);
    await showScreenAlone(page);
  },

  /** A new product with the name left empty: the message of the field. */
  async nameRequired(page: Page) {
    await openProductsLab(page);
    await page.getByRole("button", { name: "Novo produto" }).first().click();
    await page.getByRole("button", { name: "Cadastrar produto" }).click();
    await page.getByText("Informe o nome do produto.").waitFor();
    await showScreenAlone(page);
  },

  /** Without a network: a product kept on the device, and the rest of the list locked. */
  async offline(page: Page) {
    await openProductsLab(page);
    await page.getByLabel("Rede disponível").uncheck();
    await page.getByRole("button", { name: "Novo produto" }).first().click();
    await page.getByLabel("Nome do produto").fill("Bolsa de couro");
    await page.getByRole("button", { name: "Cadastrar produto" }).click();
    await page.getByText("Aguardando envio").waitFor({ timeout: 15_000 });
    await showScreenAlone(page);
  },

  /** The variants of a product with its default variant: SKU, price and the form of the options. */
  async variants(page: Page) {
    await openProductsLab(page);
    await openVariants(page);
    await page.getByLabel("SKU — Variante padrão").waitFor();
    await showScreenAlone(page);
  },

  /** The variants of a product that already has them configured. */
  async variantsConfigured(page: Page) {
    await openProductsLab(page, { configuration: CONFIGURED });
    await openVariants(page);
    await page.getByText("Variantes cadastradas").first().waitFor();
    await showScreenAlone(page);
  },

  /** The options picked and the first combination added (the tallest form). */
  async variantsForm(page: Page) {
    await openProductsLab(page);
    await openVariants(page);
    await page.getByText("Cor", { exact: true }).click();
    await page.getByLabel("Valores de Cor").fill("Azul\nPreta");
    await page.getByRole("button", { name: "Adicionar combinação" }).click();
    await page.getByRole("button", { name: "Remover combinação 1" }).waitFor();
    await showScreenAlone(page);
  },
};
