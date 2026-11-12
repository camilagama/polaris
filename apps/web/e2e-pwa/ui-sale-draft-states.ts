/// <reference lib="dom" />
import type { Locator, Page, Route } from "@playwright/test";
import { serveHome } from "./ui-home-states";
import { WORKER_MARK } from "./worker-mark";

/**
 * The sale being built, left for the Início and taken up again after the catalog changed its list price: the notice of
 * the cart that came back, with the new price in reais. The app with the server answered by the test (synthetic data).
 */
const VARIANT = {
  isDefaultVariant: false,
  listPrice: "50.00",
  movingAverageCost: null,
  productId: "0199c2d0-0000-7000-8000-0000000000f1",
  productName: "Camiseta do teste",
  productStatus: "active",
  quantity: 5,
  sku: "SKU-1",
  updatedAt: "2026-10-14T12:00:00.000Z",
  values: [{ optionName: "cor", optionValueName: "Azul" }],
  variantId: "0199c2d0-0000-7000-8000-0000000000b1",
  version: 1,
};

const SHIRT_OPTION = /Camiseta do teste/;

const rpc = (body: unknown) => ({
  body: JSON.stringify({ json: body, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
});

const menuLink = (page: Page, name: string): Locator =>
  page.getByRole("link", { exact: true, name }).filter({ visible: true });

export async function repricedDraft(page: Page) {
  let entries = [VARIANT];
  await serveHome(page, { signedIn: true });
  await page.route("**/rpc/inventory/listBalances", (route: Route) =>
    route.fulfill(rpc({ entries, nextCursor: null }))
  );
  await page.route("**/rpc/paymentProfile/list", (route: Route) =>
    route.fulfill(rpc({ profiles: [] }))
  );
  await page.goto("/sales");
  await page
    .getByRole("heading", { exact: true, name: "Nova venda" })
    .waitFor();
  const item = page.getByRole("group", { exact: true, name: "Item 1" });
  await item.getByLabel("Produto ou variante").fill("cam");
  await page
    .getByRole("listbox", { name: "Variantes encontradas" })
    .getByRole("option", { name: SHIRT_OPTION })
    .click();
  await item.getByRole("button", { name: "Mais uma unidade" }).click();
  await menuLink(page, "Início").click();
  await page
    .getByRole("heading", { exact: true, level: 1, name: "Início" })
    .waitFor();
  entries = [{ ...VARIANT, listPrice: "38.00", version: 2 }];
  await menuLink(page, "Vender").click();
  await page
    .locator("[aria-live]")
    .filter({ hasText: "Camiseta do teste · Azul: preço de tabela atualizado" })
    .waitFor();
}
