/// <reference lib="dom" />
import type { Locator, Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { ORGANIZATION, serveHome } from "./ui-home-states";
import { CONFIRMED_SALE } from "./ui-sale-states";
import { WORKER_MARK } from "./worker-mark";

/**
 * The sale being built survives leaving Vender, a reload and the way back by "Vender" and "Nova venda", in the app
 * with the server answered by the test (synthetic data). It lives in the tab's `sessionStorage`, never in
 * `localStorage`; "Limpar venda" asks first when there are items; a line that left the catalog is taken out, and a new
 * list price taken, with a notice that names the item; and a lost answer, a reload and a second confirmation send the
 * same command ID, even when the catalog changed in between. The swap of the build with the cart out of the screen is
 * in `update.e2e.ts`.
 */
const SHIRT_OPTION = /Camiseta do teste/;
const DRAFT_KEY = `polaris.sale.draft.v1:${ORGANIZATION.id}`;
const ATTEMPT_KEY = `polaris.sale.attempt.v1:${ORGANIZATION.id}`;
const CONFIRMED_REGION = /Venda confirmada/;
const SUBMIT_NAME = /Confirmar venda|Tentar novamente/;

const SHIRT = {
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

const rpc = (body: unknown) => ({
  body: JSON.stringify({ json: body, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
});

/** The catalog the server answers now: a test takes the shirt out of it, or changes its price. */
interface Catalog {
  entries: (typeof SHIRT)[];
}

async function serveSale(page: Page): Promise<Catalog> {
  const catalog: Catalog = { entries: [SHIRT] };
  await serveHome(page, { signedIn: true });
  await page.route("**/rpc/inventory/listBalances", (route: Route) =>
    route.fulfill(rpc({ entries: catalog.entries, nextCursor: null }))
  );
  await page.route("**/rpc/paymentProfile/list", (route: Route) =>
    route.fulfill(rpc({ profiles: [] }))
  );
  return catalog;
}

const itemOne = (page: Page) =>
  page.getByRole("group", { exact: true, name: "Item 1" });

async function openSale(page: Page) {
  await page.goto("/sales");
  await page
    .getByRole("heading", { exact: true, name: "Nova venda" })
    .waitFor();
}

/** Two shirts, paid by Pix with no profile: a cart ready to confirm. */
async function buildCart(page: Page) {
  const item = itemOne(page);
  await item.getByLabel("Produto ou variante").fill("cam");
  await item
    .getByRole("list", { name: "Variantes encontradas" })
    .getByRole("button", { name: SHIRT_OPTION })
    .click();
  await item.getByRole("button", { name: "Mais uma unidade" }).click();
  await page
    .getByRole("radiogroup", { name: "Método de pagamento" })
    .getByRole("radio", { name: "Pix" })
    .check();
  await page
    .getByRole("combobox", { exact: true, name: "Perfil de pagamento" })
    .click();
  await page
    .getByRole("option", { exact: true, name: "Sem perfil de pagamento" })
    .click();
  await page.getByRole("listbox").waitFor({ state: "detached" });
}

/** The link of the menu that is on the screen: the sidebar on a desktop, the bar at the bottom on a phone. */
const menuLink = (page: Page, name: string): Locator =>
  page.getByRole("link", { exact: true, name }).filter({ visible: true });

async function goHome(page: Page) {
  await menuLink(page, "Início").click();
  await page
    .getByRole("heading", { exact: true, level: 1, name: "Início" })
    .waitFor();
}

async function expectCart(page: Page) {
  await expect(itemOne(page).getByText("Camiseta do teste")).toBeVisible();
  await expect(itemOne(page).getByLabel("Quantidade")).toHaveValue("2");
  await expect(
    page
      .getByRole("radiogroup", { name: "Método de pagamento" })
      .getByRole("radio", { name: "Pix" })
  ).toBeChecked();
  await expect(
    page.getByRole("status").filter({ hasText: "Venda em andamento" })
  ).toBeVisible();
}

/** The first line is empty again: the search with nothing typed, one unit. */
async function expectBlankLine(page: Page) {
  await expect(itemOne(page).getByLabel("Produto ou variante")).toHaveValue("");
  await expect(itemOne(page).getByLabel("Quantidade")).toHaveValue("1");
}

const storageKeys = (page: Page, which: "localStorage" | "sessionStorage") =>
  page.evaluate((name) => Object.keys(window[name]), which);

test("AC-1, AC-5 e AC-7: a venda montada volta por Vender e por Nova venda, e o localStorage fica sem chave de venda", async ({
  page,
}) => {
  await serveSale(page);
  await openSale(page);
  await buildCart(page);
  await expect(
    page.getByRole("status").filter({ hasText: "Venda em andamento" })
  ).toBeVisible();

  await goHome(page);
  await menuLink(page, "Vender").click();
  await expectCart(page);

  await goHome(page);
  await page.getByRole("link", { exact: true, name: "Nova venda" }).click();
  await expectCart(page);

  // nothing of the cart on the device: no key of the draft, no value with the product on the sale
  const device = await page.evaluate(() => Object.entries(window.localStorage));
  expect(device.filter(([key]) => key.startsWith("polaris.sale."))).toEqual([]);
  expect(
    device.filter(([, value]) => value.includes(SHIRT.productName))
  ).toEqual([]);
  expect(await storageKeys(page, "sessionStorage")).toContain(DRAFT_KEY);
  // identifiers, quantities and values: the form has no customer, and nothing of a person is written
  const stored = await page.evaluate(
    (key) => window.sessionStorage.getItem(key) ?? "",
    DRAFT_KEY
  );
  expect(Object.keys(JSON.parse(stored).form).sort()).toEqual([
    "adjustments",
    "items",
    "occurredAtLocal",
    "payment",
    "profile",
  ]);
});

test("AC-2: uma recarga com a venda fora da tela mantém a venda", async ({
  page,
}) => {
  await serveSale(page);
  await openSale(page);
  await buildCart(page);
  await goHome(page);

  await page.reload();
  await page
    .getByRole("heading", { exact: true, level: 1, name: "Início" })
    .waitFor();
  await menuLink(page, "Vender").click();
  await expectCart(page);
});

test("AC-4: ao voltar, o item que saiu do catálogo é tirado com aviso anunciado", async ({
  page,
}) => {
  const catalog = await serveSale(page);
  await openSale(page);
  await buildCart(page);
  await goHome(page);

  catalog.entries = [];
  await menuLink(page, "Vender").click();
  const notice = page.locator("[aria-live]").filter({
    hasText:
      "O item Camiseta do teste · Azul saiu do catálogo e foi tirado da venda.",
  });
  await expect(notice).toBeVisible();
  await expectBlankLine(page);
  // the payment stays: only the line that left was taken out
  await expect(
    page
      .getByRole("radiogroup", { name: "Método de pagamento" })
      .getByRole("radio", { name: "Pix" })
  ).toBeChecked();
});

test("AC-4: ao voltar, o preço de tabela novo entra com aviso do item, do valor e do preço cobrado", async ({
  page,
}) => {
  const catalog = await serveSale(page);
  await openSale(page);
  await buildCart(page);
  await goHome(page);

  catalog.entries = [{ ...SHIRT, listPrice: "38.00", version: 2 }];
  await menuLink(page, "Vender").click();
  const notice = page.locator("[aria-live]").filter({
    hasText:
      "Camiseta do teste · Azul: preço de tabela atualizado para R$ 38,00; o preço cobrado acompanhou.",
  });
  await expect(notice).toBeVisible();
  await expect(itemOne(page).getByLabel("Preço cobrado")).toHaveValue("38,00");
});

test("AC-7: Limpar venda pede confirmação com itens, e sem itens limpa em um toque", async ({
  page,
}) => {
  await serveSale(page);
  await openSale(page);
  await buildCart(page);

  const clear = page.getByRole("button", { exact: true, name: "Limpar venda" });
  await clear.click();
  const dialog = page.getByRole("dialog", { name: "Limpar venda?" });
  await expect(dialog).toContainText("Isso tira o item da venda.");
  await dialog.getByRole("button", { name: "Cancelar" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(itemOne(page).getByText("Camiseta do teste")).toBeVisible();

  await clear.click();
  await dialog
    .getByRole("button", { exact: true, name: "Limpar venda" })
    .click();
  await expect(dialog).toHaveCount(0);
  await expectBlankLine(page);
  await expect(
    page.getByRole("status").filter({ hasText: "Venda em andamento" })
  ).toHaveCount(0);
  expect(await storageKeys(page, "sessionStorage")).not.toContain(DRAFT_KEY);

  // only a payment chosen: nothing to lose, no question
  await page
    .getByRole("radiogroup", { name: "Método de pagamento" })
    .getByRole("radio", { name: "Pix" })
    .check();
  await clear.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(clear).toHaveCount(0);

  await page.reload();
  await page
    .getByRole("heading", { exact: true, name: "Nova venda" })
    .waitFor();
  await expect(
    page
      .getByRole("radiogroup", { name: "Método de pagamento" })
      .getByRole("radio", { name: "Pix" })
  ).not.toBeChecked();
});

test("AC-6: resposta perdida, recarga e nova confirmação levam o mesmo commandId (uma venda só)", async ({
  page,
}) => {
  await serveSale(page);
  const sent: string[] = [];
  await page.route("**/rpc/sale/confirm", (route: Route) => {
    const body = route.request().postDataJSON() as {
      json: { commandId: string };
    };
    sent.push(body.json.commandId);
    return route.abort("connectionreset");
  });
  await openSale(page);
  await buildCart(page);
  await page.getByRole("button", { name: SUBMIT_NAME }).last().click();
  await expect.poll(() => sent.length).toBe(1);

  await page.reload();
  await page
    .getByRole("heading", { exact: true, name: "Nova venda" })
    .waitFor();
  await expectCart(page);
  await page.getByRole("button", { name: SUBMIT_NAME }).last().click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]).toBe(sent[0]);
});

test("AC-6: resposta perdida, preço mudado e recarga: o carrinho vai como foi, com o mesmo commandId e sem aviso", async ({
  page,
}) => {
  const catalog = await serveSale(page);
  const sent: unknown[] = [];
  await page.route("**/rpc/sale/confirm", (route: Route) => {
    sent.push(route.request().postDataJSON());
    return route.abort("connectionreset");
  });
  await openSale(page);
  await buildCart(page);
  await page.getByRole("button", { name: SUBMIT_NAME }).last().click();
  await expect.poll(() => sent.length).toBe(1);

  catalog.entries = [{ ...SHIRT, listPrice: "38.00", version: 2 }];
  const reread = page.waitForResponse("**/rpc/inventory/listBalances");
  await page.reload();
  await page
    .getByRole("heading", { exact: true, name: "Nova venda" })
    .waitFor();
  await reread;
  await expectCart(page);
  await expect(itemOne(page).getByLabel("Preço cobrado")).toHaveValue("50,00");
  await page.getByRole("button", { name: SUBMIT_NAME }).last().click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]).toEqual(sent[0]);
  await expect(
    page.locator("[aria-live]").filter({ hasText: "preço de tabela" })
  ).toHaveCount(0);
});

test("AC-3 e AC-6: a venda confirmada nunca volta como rascunho", async ({
  page,
}) => {
  await serveSale(page);
  await page.route("**/rpc/sale/confirm", (route: Route) =>
    route.fulfill(rpc(CONFIRMED_SALE))
  );
  await page.route("**/rpc/sale/getCustomerLink", (route: Route) =>
    route.fulfill(
      rpc({
        current: { customerId: null, version: 0 },
        history: [],
        saleId: CONFIRMED_SALE.sale.id,
      })
    )
  );
  await page.route("**/rpc/customer/list", (route: Route) =>
    route.fulfill(rpc({ customers: [] }))
  );
  await openSale(page);
  await buildCart(page);
  await page.getByRole("button", { name: SUBMIT_NAME }).last().click();
  await page.getByRole("region", { name: CONFIRMED_REGION }).waitFor();
  expect(await storageKeys(page, "sessionStorage")).not.toContain(DRAFT_KEY);

  await goHome(page);
  await menuLink(page, "Vender").click();
  await expectBlankLine(page);
  await expect(
    page.getByRole("status").filter({ hasText: "Venda em andamento" })
  ).toHaveCount(0);
});

test("AC-3: trocar de loja apaga a venda da loja deixada", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium-desktop",
    "a loja do celular se troca na folha Mais; o apagar é o mesmo"
  );
  await serveSale(page);
  const other = {
    ...ORGANIZATION,
    id: "0199c2d0-0000-7000-8000-00000000a002",
    name: "Outra loja",
  };
  await page.route("**/rpc/organization/listMine", (route: Route) =>
    route.fulfill(rpc({ organizations: [ORGANIZATION, other] }))
  );
  await openSale(page);
  await buildCart(page);
  // the attempt of a sale sent with no answer goes with the cart it was made for
  await page.evaluate(
    (key) => window.sessionStorage.setItem(key, "{}"),
    ATTEMPT_KEY
  );

  const chooseStore = async (name: string) => {
    await page.getByRole("button", { name: "Loja, tema e Sair" }).click();
    await page.getByRole("menuitemradio", { name }).click();
    // a radio item keeps the menu open
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
  };
  await chooseStore("Outra loja");
  await page
    .getByRole("heading", { exact: true, name: "Nova venda" })
    .waitFor();
  const kept = await storageKeys(page, "sessionStorage");
  expect(kept).not.toContain(DRAFT_KEY);
  expect(kept).not.toContain(ATTEMPT_KEY);

  await chooseStore("Loja do teste");
  await menuLink(page, "Vender").click();
  await page
    .getByRole("heading", { exact: true, name: "Nova venda" })
    .waitFor();
  await expectBlankLine(page);
});
