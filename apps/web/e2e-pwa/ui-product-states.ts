/// <reference lib="dom" />
// Only types from Playwright: `ui-screens.ts` is read under Vitest by the source rules.
import type { Page, Route } from "@playwright/test";
import { mediaListBody, solidPng } from "../e2e/media-fixtures";
import { serveLabWorker, WORKER_MARK } from "./worker-mark";

/**
 * The states of the products screen the interface guardrails measure: the screen in the lab of the screens
 * (`/offline-screens-lab?screen=products`) over the real offline runtime, with the catalog the lab seeds
 * (`&catalog=seeded`: five active products, one archived, two categories), and the variants answered by the test
 * (`page.route`). Only a few states: each one starts the runtime of the lab (OPFS and SQLite) in every context of the
 * map, which costs more than a static page, and the CI job has a limit of 30 minutes; the other states (empty, the
 * archived list, the search with no match, the variants already configured, no connection) are proved in `e2e/products-screen.e2e.ts`
 * and in the captures of the pull request. Synthetic data only. The lab's own controls are hidden at the end of each state, so what
 * is measured is the screen alone. The states that need the server mode (loading, the list failing to load) are in
 * `e2e/products-screen.e2e.ts`: the lab always has the device's collections.
 */
const id = (n: number) => `0199c2d0-0000-7000-8000-0000000000${n}`;
const PRODUCT_ID = id(21);

const rpc = (body: unknown) => ({
  body: JSON.stringify({ json: body, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
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

const serveVariants = (page: Page, configuration: unknown) =>
  page.route("**/rpc/product/getVariants", (route: Route) =>
    route.fulfill(rpc(configuration))
  );

const menuOf = (page: Page, name: string) =>
  page.getByRole("button", { name: `Mais ações para ${name}` });

/** Starts the lab's runtime and waits for the screen. */
async function openProductsLab(page: Page) {
  await serveVariants(page, DEFAULT_CONFIGURATION);
  await serveLabWorker(page);
  await page.goto("/offline-screens-lab?screen=products&catalog=seeded");
  await page.getByLabel("Usuário").fill(`guardrails-${crypto.randomUUID()}`);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await page
    .getByTestId("message")
    .filter({ hasText: "Iniciar: ok (ready)" })
    .waitFor({ timeout: 20_000 });
  await page.getByRole("heading", { exact: true, name: "Produtos" }).waitFor();
  await page.getByText("Calça jeans").waitFor();
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

const CONFIGURED_VARIANTS = {
  configured: true,
  options: [],
  productId: PRODUCT_ID,
  productVersion: 2,
  variants: [
    ...DEFAULT_CONFIGURATION.variants,
    ...[1, 2].map((n) => ({
      id: id(60 + n),
      isDefault: false,
      listPrice: "50.00",
      sku: `CAM-00${n}`,
      values: [
        {
          optionName: "color",
          optionValueId: id(40 + n),
          optionValueName: n === 1 ? "Azul" : "Preta",
        },
      ],
      version: 1,
    })),
  ],
};

/** The images panel of "Camiseta do teste": two images answered by the test, and the variants it can be tied to. */
async function openMediaPanel(page: Page) {
  await openProductsLab(page);
  await serveVariants(page, CONFIGURED_VARIANTS);
  await page.route("**/api/products/*/media**", (route: Route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          body: mediaListBody(2),
          contentType: "application/json",
          headers: { ...WORKER_MARK },
        })
      : route.abort("failed")
  );
  await page.route("**/api/media/**", (route: Route) =>
    route.fulfill({
      body: solidPng(96, 96, [150, 160, 170]),
      contentType: "image/png",
    })
  );
  await menuOf(page, "Camiseta do teste").click();
  await page.getByRole("menuitem", { name: "Imagens" }).click();
  await page
    .getByRole("heading", { level: 3, name: "Imagens associadas" })
    .waitFor();
  await page.getByRole("button", { name: "Remover imagem 2" }).waitFor();
}

/** A spreadsheet of the import (corte 2.5) as the file the person chooses: nothing of it goes to the server. */
const importFile = (lines: readonly string[]) => ({
  buffer: Buffer.from(`${lines.join("\r\n")}\r\n`, "utf8"),
  mimeType: "text/csv",
  name: "produtos.csv",
});

/** Opens "Importar planilha", chooses the file and reads it: the preview, with the store's names answered here. */
async function openImportPreview(page: Page, lines: readonly string[]) {
  await openProductsLab(page);
  await page.route("**/rpc/product/namesExisting", (route: Route) =>
    route.fulfill(rpc({ names: ["Calça jeans"] }))
  );
  // the plan is not read here: the preview goes without the notice of the plan's room
  await page.route("**/rpc/billing/readPlan", (route: Route) =>
    route.abort("failed")
  );
  await page.getByRole("button", { name: "Importar planilha" }).click();
  const dialog = page.getByRole("dialog", { name: "Importar planilha" });
  await dialog.locator('input[type="file"]').setInputFiles(importFile(lines));
  await dialog.getByRole("button", { name: "Ver a prévia" }).click();
  await dialog.getByText("Passo 2 de 4 · Prévia").waitFor();
  return dialog;
}

export const productStates = {
  /** The edit of a product with the name cleared and saved: the form (name, category, description) and the message of the field. */
  async edit(page: Page) {
    await openProductsLab(page);
    await menuOf(page, "Camiseta do teste").click();
    await page.getByRole("menuitem", { name: "Editar" }).click();
    await page.getByRole("dialog", { name: "Camiseta do teste" }).waitFor();
    await page.getByLabel("Nome do produto").fill("");
    await page.getByRole("button", { name: "Salvar alterações" }).click();
    await page.getByText("Informe o nome do produto.").waitFor();
    await showScreenAlone(page);
  },

  /** A new product in one step: name, price, stock and cost, with "Mais detalhes" closed (AC-24). */
  async create(page: Page) {
    await openProductsLab(page);
    await page.getByRole("button", { name: "Novo produto" }).first().click();
    await page.getByRole("dialog", { name: "Novo produto" }).waitFor();
    await showScreenAlone(page);
  },

  /** The product open with no connection: the strip with "Tentar agora" and the save button off with its reason. */
  async offline(page: Page) {
    await openProductsLab(page);
    await menuOf(page, "Camiseta do teste").click();
    await page.getByRole("menuitem", { name: "Editar" }).click();
    await page.getByRole("dialog", { name: "Camiseta do teste" }).waitFor();
    // the lab's network control is under the veil of the dialog: switched by the page
    await page
      .getByLabel("Rede disponível")
      .evaluate((box) => (box as HTMLInputElement).click());
    await page.getByRole("button", { name: "Tentar agora" }).waitFor();
    await showScreenAlone(page);
  },

  /** The list of the seeded catalog. */
  async list(page: Page) {
    await openProductsLab(page);
    await showScreenAlone(page);
  },

  /** The images panel with two images, the second one asking whether to remove it (the open state, with its buttons). */
  async media(page: Page) {
    await openMediaPanel(page);
    await page.getByRole("button", { name: "Remover imagem 2" }).click();
    await page.getByRole("alertdialog").waitFor();
    await showScreenAlone(page);
  },

  /** An image picked: the crop area drawn with the area adjusted, the variants to tie it to, and the send button on. */
  async mediaCrop(page: Page) {
    await openMediaPanel(page);
    await page.getByLabel("Escolher imagem").setInputFiles({
      buffer: solidPng(480, 320),
      mimeType: "image/png",
      name: "foto.png",
    });
    await page
      .getByRole("button", {
        name: "Área de recorte. Arraste ou use as setas para ajustar.",
      })
      .waitFor();
    await page.getByRole("button", { name: "Ajustar com o dedo" }).click();
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

  /** The preview of an import: a row that enters, one with an error, one the store has and one without category. */
  async importPreview(page: Page) {
    await openImportPreview(page, [
      "Nome;Preço de tabela;Quantidade;Categoria;Marca",
      "Caneca do teste;25,00;3;;X",
      "Boné do teste;abc;;;",
      "Calça jeans;10;;;",
      "Meia do teste;12;;Inexistente;",
    ]);
    await showScreenAlone(page);
  },

  /** The result of an import: one product in, one row out, with its table and the CSV to download. */
  async importResult(page: Page) {
    await page.route("**/rpc/product/importBatch", (route: Route) => {
      const { json } = route.request().postDataJSON() as {
        json: { rows: { productId: string; rowNumber: number }[] };
      };
      return route.fulfill(
        rpc({
          results: json.rows.map((row) => ({
            productId: row.productId,
            rowNumber: row.rowNumber,
            status: "created",
          })),
        })
      );
    });
    const dialog = await openImportPreview(page, [
      "Nome;Preço de tabela;Quantidade",
      "Caneca do teste;25,00;3",
      "Boné do teste;abc;",
    ]);
    await dialog.getByRole("button", { name: "Importar 1 produto" }).click();
    await dialog.getByText("Passo 4 de 4 · Resultado").waitFor();
    await showScreenAlone(page);
  },
};
