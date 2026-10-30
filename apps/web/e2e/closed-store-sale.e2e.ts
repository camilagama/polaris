/// <reference lib="dom" />
import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { serveHealth, WORKER_MARK } from "./worker-mark";

/**
 * A sale confirmed online while the store is closed: the server refuses it with `FORBIDDEN` and
 * `data.reason: "organization_closed"`. The sale never entered the device's queue, so the notice must not say it is
 * kept there; the cart stays in this tab's draft, through the notice and through undoing the closure, and Vender
 * gives it back once the store is open again.
 */
const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const PRODUCT_ID = "0199c2d0-0000-7000-8000-0000000000f1";
const VARIANT_ID = "0199c2d0-0000-7000-8000-0000000000b1";
const DRAFT_KEY = `polaris.sale.draft.v1:${ORGANIZATION.id}`;
const SHIRT_OPTION = /Camiseta do teste · Azul/;
const REOPENED_URL = /reaberta=1/;
const DAY = 86_400_000;
const SALE_REFUSED = "A venda que você acabou de confirmar não foi registrada.";
const CART_KEPT =
  "O carrinho continua nesta aba e volta em Vender se a loja reabrir; se você fechar a aba, ele se perde.";
const QUEUE_LIE = "o que não foi enviado continua guardado na fila";

const SHIRT_ENTRY = {
  isDefaultVariant: false,
  listPrice: "50.00",
  movingAverageCost: null,
  productId: PRODUCT_ID,
  productName: "Camiseta do teste",
  productStatus: "active",
  quantity: 5,
  sku: "CAM-AZ-M",
  updatedAt: "2026-10-14T12:00:00.000Z",
  values: [{ optionName: "color", optionValueName: "Azul" }],
  variantId: VARIANT_ID,
  version: 1,
};

const rpc = (json: unknown, status = 200) => ({
  body: JSON.stringify({ json, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
  status,
});

const closedRefusal = rpc(
  {
    code: "FORBIDDEN",
    data: { reason: "organization_closed" },
    defined: false,
    message: "FORBIDDEN",
    status: 403,
  },
  403
);

function closedStore() {
  const now = Date.now();
  return {
    canRecover: true,
    deletableFrom: new Date(now + 90 * DAY).toISOString(),
    deletionDate: new Date(now + 90 * DAY).toISOString().slice(0, 10),
    exportOpenUntil: new Date(now + 60 * DAY).toISOString(),
    id: ORGANIZATION.id,
    milestones: {
      closure: new Date(now - DAY).toISOString(),
      d30: new Date(now + 30 * DAY).toISOString(),
      d7: new Date(now + 7 * DAY).toISOString(),
      deletionDay: new Date(now + 90 * DAY).toISOString(),
    },
    name: ORGANIZATION.name,
    phase: "closing",
    recoverUntil: new Date(now + 20 * DAY).toISOString(),
    renewal: "not_handled",
    requestedAt: new Date(now - DAY).toISOString(),
    timezone: "America/Sao_Paulo",
  };
}

class Store {
  closed = Boolean(0);
  confirms = 0;

  async install(page: Page) {
    await serveHealth(page);
    await page.route("**/api/auth/get-session", (route) =>
      route.fulfill({
        body: JSON.stringify({
          session: { id: "s" },
          user: { id: "user-closed-sale" },
        }),
        contentType: "application/json",
        headers: { ...WORKER_MARK },
      })
    );
    await page.route("**/rpc/**", (route) => this.answer(route));
  }

  private answer(route: Route) {
    const procedure = new URL(route.request().url()).pathname.replace(
      "/rpc/",
      ""
    );
    switch (procedure) {
      case "organization/listMine":
        return route.fulfill(
          rpc({
            billingSelfService: false,
            organizations: this.closed ? [] : [ORGANIZATION],
          })
        );
      case "organization/closedStatus":
        return route.fulfill(rpc({ organization: closedStore() }));
      case "organization/recoverClosure":
        this.closed = false;
        return route.fulfill(rpc({}));
      default:
        break;
    }
    if (this.closed) {
      return route.fulfill(closedRefusal);
    }
    switch (procedure) {
      case "inventory/listBalances":
        return route.fulfill(rpc({ entries: [SHIRT_ENTRY], nextCursor: null }));
      case "paymentProfile/list":
        return route.fulfill(rpc({ profiles: [] }));
      case "sale/confirm":
        this.confirms += 1;
        this.closed = true;
        return route.fulfill(closedRefusal);
      default:
        return route.abort("internetdisconnected");
    }
  }
}

async function buildCart(page: Page) {
  await page.getByLabel("Produto ou variante").fill("camiseta azul");
  await page.getByRole("button", { name: SHIRT_OPTION }).click();
  await page.getByLabel("Quantidade").fill("2");
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
}

const draft = (page: Page) =>
  page.evaluate((key) => window.sessionStorage.getItem(key), DRAFT_KEY);

const notice = (page: Page) =>
  page.locator('[data-notice="organization-closed"]');

test.describe("venda recusada com a loja encerrada", () => {
  test.setTimeout(60_000);

  test("o carrinho continua depois do aviso e do desfazer, e o aviso não diz que a venda está na fila", async ({
    page,
  }) => {
    const store = new Store();
    await store.install(page);
    await page.goto("/sales");
    await buildCart(page);
    await expect.poll(() => draft(page)).not.toBeNull();
    const before = await draft(page);

    await page.getByRole("button", { name: "Confirmar venda" }).click();

    await expect(notice(page)).toContainText(SALE_REFUSED, { timeout: 20_000 });
    await expect(notice(page)).toContainText(CART_KEPT);
    await expect(notice(page)).not.toContainText(QUEUE_LIE);
    expect(store.confirms).toBe(1);
    expect(await draft(page)).toBe(before);

    await notice(page)
      .getByRole("link", { name: "Ver a loja encerrada" })
      .click();
    await page.getByRole("button", { name: "Desfazer encerramento" }).click();
    await page.getByRole("button", { name: "Sim, desfazer" }).click();
    await expect(page).toHaveURL(REOPENED_URL);
    expect(await draft(page)).toBe(before);

    await page.goto("/sales");
    await expect(
      page.getByRole("heading", { exact: true, name: "Nova venda" })
    ).toBeVisible();
    await expect(page.getByLabel("Quantidade")).toHaveValue("2");
    await expect(page.getByText("Camiseta do teste")).toBeVisible();
    await expect(notice(page)).toHaveCount(0);
  });
});
