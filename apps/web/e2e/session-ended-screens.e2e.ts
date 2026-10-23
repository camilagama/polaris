/// <reference lib="dom" />
import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";

/**
 * "Sua sessão acabou" nas telas que sobraram do PR da tela de entrada: venda (texto do 401 e rolagem),
 * foto do produto (o upload não é oRPC), preço de variante (sinal de trabalho não enviado).
 * A caixa vermelha diz só o que não aconteceu; a frase da sessão é só do aviso do shell.
 */
const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const PRODUCT_ID = "0199c2d0-0000-7000-8000-0000000000f1";
const VARIANT_ID = "0199c2d0-0000-7000-8000-0000000000b1";
const SENTENCE = "Sua sessão acabou. Entre de novo para continuar.";
const WARNING =
  "O que você digitou e ainda não enviou pode se perder ao entrar de novo.";
const SHIRT_OPTION = /Camiseta do teste — Azul/;
const PRICE_FIELD = /Preço de tabela — /;
const SHOTS = process.env.T111_SHOTS;

const rpc = (json: unknown, status = 200) => ({
  body: JSON.stringify({ json, meta: [] }),
  contentType: "application/json",
  status,
});
const unauthorized = rpc(
  {
    code: "UNAUTHORIZED",
    data: undefined,
    defined: false,
    message: "Unauthorized",
    status: 401,
  },
  401
);

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
const PRODUCT = {
  archivedAt: null,
  categoryId: null,
  createdAt: "2026-10-14T12:00:00.000Z",
  deletedAt: null,
  description: null,
  id: PRODUCT_ID,
  name: "Camiseta do teste",
  organizationId: ORGANIZATION.id,
  status: "active",
  updatedAt: "2026-10-14T12:00:00.000Z",
  version: 1,
};
const CONFIGURATION = {
  optionValues: [{ optionName: "color", optionValueName: "Azul" }],
  productId: PRODUCT_ID,
  productVersion: 1,
  variants: [
    {
      id: VARIANT_ID,
      isDefault: false,
      listPrice: "50.00",
      sku: "CAM-AZ-M",
      values: [{ optionName: "color", optionValueName: "Azul" }],
      version: 1,
    },
  ],
};

/** Signed in until `endSession` runs; the sign-in lookup then answers "nobody". */
async function openScreen(
  page: Page,
  path: string,
  handlers: Record<string, (route: Route) => Promise<void>>
) {
  let alive = true;
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      body: JSON.stringify(
        alive ? { session: { id: "s" }, user: { id: "u" } } : null
      ),
      contentType: "application/json",
    })
  );
  await page.route("**/rpc/**", (route) => {
    const procedure = new URL(route.request().url()).pathname.replace(
      "/rpc/",
      ""
    );
    if (procedure === "organization/listMine") {
      return route.fulfill(rpc({ organizations: [ORGANIZATION] }));
    }
    const handler = handlers[procedure];
    if (handler) {
      return handler(route);
    }
    return route.abort("internetdisconnected");
  });
  await page.goto(path);
  return {
    endSession() {
      alive = false;
    },
  };
}

async function shot(page: Page, name: string) {
  if (SHOTS) {
    await page.screenshot({
      fullPage: true,
      path: `${SHOTS}/${test.info().project.name}-${name}.png`,
    });
  }
}

test("venda: com o carrinho montado, o 401 diz 'A venda não foi registrada.' e nunca grava (V-2)", async ({
  page,
}) => {
  let confirmCalls = 0;
  const screen = await openScreen(page, "/sales", {
    "inventory/listBalances": (route) =>
      route.fulfill(rpc({ entries: [SHIRT_ENTRY], nextCursor: null })),
    "paymentProfile/list": (route) => route.fulfill(rpc({ profiles: [] })),
    "sale/confirm": (route) => {
      confirmCalls += 1;
      screen.endSession();
      return route.fulfill(unauthorized);
    },
  });
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
  await page.getByRole("button", { name: "Confirmar venda" }).click();

  const notice = page.locator('[data-notice="session-ended"]');
  await expect(notice).toContainText(SENTENCE);
  await expect(notice).toContainText(WARNING);
  // the failure notice of the sale does not take the focus the session notice took
  await expect(notice).toBeFocused();
  await expect(page.getByRole("alert")).toContainText(
    "A venda não foi registrada."
  );
  await expect(page.getByRole("alert")).not.toContainText(SENTENCE);
  await expect(page.getByText("não foi confirmada")).toHaveCount(0);
  await expect(page.getByText(SENTENCE)).toHaveCount(1);
  expect(confirmCalls).toBe(1);
  await shot(page, "venda-401");
});

const CATEGORY = (index: number) => ({
  archivedAt: null,
  createdAt: "2026-10-14T12:00:00.000Z",
  deletedAt: null,
  id: `0199c2d0-0000-7000-8000-${String(index).padStart(12, "0")}`,
  name: `Categoria ${index}`,
  organizationId: ORGANIZATION.id,
  status: "active",
  updatedAt: "2026-10-14T12:00:00.000Z",
});

/** A long list, a short screen, and the page scrolled away from the top. */
async function openLongCategories(page: Page) {
  await page.setViewportSize({ height: 420, width: 390 });
  const screen = await openScreen(page, "/categories", {
    "category/create": (route) => {
      screen.endSession();
      return route.fulfill(unauthorized);
    },
    "category/list": (route) =>
      route.fulfill(
        rpc({
          categories: Array.from({ length: 40 }, (_, i) => CATEGORY(i + 1)),
        })
      ),
  });
  await expect(page.getByLabel("Nova categoria")).toBeVisible();
  return screen;
}

test("aviso com um campo ativo não rola a página nem tira o foco do campo (V-3)", async ({
  page,
}) => {
  await openLongCategories(page);
  const field = page.getByLabel("Nova categoria");
  await field.fill("Acessórios");
  await field.focus();
  await page.evaluate(() => window.scrollTo(0, 200));
  const before = await field.boundingBox();
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  // Enter submits with the field still active: the person is typing
  await page.keyboard.press("Enter");

  const notice = page.locator('[data-notice="session-ended"]');
  await expect(notice).toContainText(SENTENCE);
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("Acessórios");
  // the notice is inserted above the form: the browser keeps what the person is typing in place, and the
  // page is not scrolled to the notice (it would put the field out of the screen)
  await expect(field).toBeInViewport();
  const after = await field.boundingBox();
  expect(after?.y).toBeCloseTo(before?.y ?? 0, 0);
  await shot(page, "campo-ativo-401");
});

test("aviso sem campo ativo rola até ele e recebe o foco (V-3)", async ({
  page,
}) => {
  await openLongCategories(page);
  await page.getByLabel("Nova categoria").fill("Acessórios");
  const button = page.getByRole("button", { name: "Adicionar categoria" });
  await button.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo(0, 900));
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(300);
  await button.click();

  const notice = page.locator('[data-notice="session-ended"]');
  await expect(notice).toContainText(SENTENCE);
  await expect(notice).toBeFocused();
  await expect(notice).toBeInViewport();
});

async function openProducts(
  page: Page,
  extra: Record<string, (route: Route) => Promise<void>> = {}
) {
  const screen = await openScreen(page, "/products", {
    "category/list": (route) => route.fulfill(rpc({ categories: [] })),
    "product/getVariants": (route) => route.fulfill(rpc(CONFIGURATION)),
    "product/list": (route) => route.fulfill(rpc({ products: [PRODUCT] })),
    ...extra,
  });
  await expect(page.getByText("Camiseta do teste").first()).toBeVisible();
  return screen;
}

/** The actions of a product are in the menu of its row. */
async function openProductAction(page: Page, action: string) {
  await page
    .getByRole("button", { name: "Mais ações para Camiseta do teste" })
    .click();
  await page.getByRole("menuitem", { name: action }).click();
}

test("preço de variante digitado e 401: o aviso diz que o digitado pode se perder (V-4)", async ({
  page,
}) => {
  const screen = await openProducts(page, {
    "product/setVariantListPrice": (route) => {
      screen.endSession();
      return route.fulfill(unauthorized);
    },
  });
  await openProductAction(page, "Variantes");
  const price = page.getByLabel(PRICE_FIELD);
  await expect(price).toBeVisible();
  await price.fill("59,90");
  await page.getByRole("button", { name: "Salvar preço" }).click();

  const notice = page.locator('[data-notice="session-ended"]');
  await expect(notice).toContainText(SENTENCE);
  await expect(notice).toContainText(WARNING);
  await expect(page.getByText("O preço não foi salvo.")).toBeVisible();
  await expect(price).toHaveValue("59,90");
  await shot(page, "preco-variante-401");
});

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

test("foto do produto: o 401 do upload mostra o aviso com 'Entrar de novo' e 'A foto não foi enviada.' (V-1)", async ({
  page,
}) => {
  const screen = await openProducts(page);
  await page.route("**/api/products/*/media**", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        body: JSON.stringify({
          media: [],
          requestId: "0199c2d0-0000-7000-8000-0000000000aa",
        }),
        contentType: "application/json",
      });
    }
    screen.endSession();
    return route.fulfill({
      body: JSON.stringify({ error: { code: "session_required" } }),
      contentType: "application/json",
      status: 401,
    });
  });
  await openProductAction(page, "Imagens");
  await page.getByLabel("Escolher imagem").setInputFiles({
    buffer: PNG_1X1,
    mimeType: "image/png",
    name: "foto.png",
  });
  await page.getByRole("button", { name: "Enviar imagem" }).click();

  const notice = page.locator('[data-notice="session-ended"]');
  await expect(notice).toContainText(SENTENCE);
  await expect(
    notice.getByRole("button", { name: "Entrar de novo" })
  ).toBeVisible();
  await expect(notice).toContainText(WARNING);
  await expect(page.getByRole("alert")).toContainText(
    "A foto não foi enviada."
  );
  await expect(page.getByRole("alert")).not.toContainText(SENTENCE);
  await expect(page.getByText(SENTENCE)).toHaveCount(1);
  await shot(page, "foto-401");
});

test("resultado: o 401 da leitura diz só 'Não foi possível carregar o resultado.' (V-1)", async ({
  page,
}) => {
  const screen = await openScreen(page, "/dashboard", {
    "report/periodSummary": (route) => {
      screen.endSession();
      return route.fulfill(unauthorized);
    },
  });
  const notice = page.locator('[data-notice="session-ended"]');
  await expect(notice).toContainText(SENTENCE);
  await expect(
    page.getByText("Não foi possível carregar o resultado.")
  ).toBeVisible();
  await expect(page.getByText(SENTENCE)).toHaveCount(1);
  await shot(page, "resultado-401");
});
