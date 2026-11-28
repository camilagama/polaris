/// <reference lib="dom" />
import type { Locator, Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { activateByKeyboard, expectFocusRing } from "./focus-ring";
import { mediaListBody, solidPng } from "./media-fixtures";
import {
  assertNoEllipsis,
  assertNoPageScroll,
  assertNothingClipped,
  expectReflowFont,
  openReflowViewport,
  reflowTest,
  skipOutsideChromium,
} from "./reflow";
import { serveHealth, WORKER_MARK } from "./worker-mark";

/**
 * The keyboard side of `InlineConfirm` (src/ui/inline-confirm.tsx) on the images panel of the products screen: the
 * box takes the focus when it opens and the keyboard sees it, Esc keeps the image and gives the focus back to the
 * button that asked while the dialog of the product stays open. The remove flow itself is proved in
 * `product-media-screen.e2e.ts`. The last block reads the confirmation of Clientes and of Categorias at 320 px with
 * the browser font at 20 px, and Categorias with the command held on the server: the box stays and both answers are off.
 */
const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const NOW = new Date("2026-10-14T12:00:00-03:00");
const STAMP = NOW.toISOString();
const id = (n: number) => `0199c2d0-0000-7000-8000-0000000000${n}`;
const REQUEST_ID = "0199c2d0-0000-7000-8000-0000000000aa";
const IMAGE_CONFIRMATION = /^Confirmar (remoção|substituição) de imagem/;

const rpc = (json: unknown) => ({
  body: JSON.stringify({ json, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
});
const api = (body: unknown, status = 200) => ({
  body: typeof body === "string" ? body : JSON.stringify(body),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
  status,
});

const shirt = {
  archivedAt: null,
  categoryId: null,
  createdAt: STAMP,
  deletedAt: null,
  description: null,
  id: id(21),
  name: "Camiseta do teste",
  organizationId: ORGANIZATION.id,
  status: "active",
  updatedAt: STAMP,
  version: 1,
};

const VARIANTS = {
  configured: true,
  options: [],
  productVersion: 2,
  variants: [
    { id: id(31), isDefault: true, listPrice: null, sku: null, values: [] },
  ],
};

async function openMediaPanel(page: Page, onRemove: () => void) {
  await page.clock.setFixedTime(NOW);
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      body: JSON.stringify({ session: { id: "s" }, user: { id: "u" } }),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    })
  );
  await page.route("**/rpc/**", (route) => {
    const procedure = new URL(route.request().url()).pathname.replace(
      "/rpc/",
      ""
    );
    const answers: Record<string, unknown> = {
      "category/list": { categories: [] },
      "organization/listMine": { organizations: [ORGANIZATION] },
      "product/getVariants": VARIANTS,
      "product/list": { products: [shirt] },
    };
    return procedure in answers
      ? route.fulfill(rpc(answers[procedure]))
      : route.abort("internetdisconnected");
  });
  await page.route("**/api/media/**", (route) =>
    route.fulfill({
      body: solidPng(96, 96, [150, 160, 170]),
      contentType: "image/png",
    })
  );
  await page.route("**/api/products/*/media**", (route) => {
    const method = route.request().method();
    if (method === "GET") {
      return route.fulfill(api(mediaListBody(2)));
    }
    if (method === "DELETE") {
      onRemove();
      return route.fulfill(api({ removed: true, requestId: REQUEST_ID }));
    }
    return route.abort("internetdisconnected");
  });
  await page.goto("/products");
  await page
    .getByRole("button", { name: "Mais ações para Camiseta do teste" })
    .click();
  await page.getByRole("menuitem", { name: "Imagens" }).click();
  await expect(
    page.getByRole("heading", { level: 3, name: "Imagens associadas" })
  ).toBeVisible();
}

test("a confirmação aberta pelo teclado leva o foco à caixa, com o contorno, e nada é removido", async ({
  page,
}) => {
  let removed = 0;
  await openMediaPanel(page, () => {
    removed += 1;
  });
  await activateByKeyboard(
    page,
    page.getByRole("button", { name: "Remover imagem 2" })
  );
  const box = page.getByRole("group", { name: IMAGE_CONFIRMATION });
  await expect(box).toContainText("Remover a imagem 2?");
  await expectFocusRing(box);
  expect(removed).toBe(0);
});

test("Esc mantém a imagem, devolve o foco ao botão e deixa aberto o diálogo do produto", async ({
  page,
}) => {
  let removed = 0;
  await openMediaPanel(page, () => {
    removed += 1;
  });
  await activateByKeyboard(
    page,
    page.getByRole("button", { name: "Remover imagem 2" })
  );
  const box = page.getByRole("group", { name: IMAGE_CONFIRMATION });
  await expectFocusRing(box);
  await page.keyboard.press("Escape");
  await expect(box).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "Camiseta do teste" })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Remover imagem 2" })
  ).toBeFocused();
  expect(removed).toBe(0);

  await activateByKeyboard(
    page,
    page.getByRole("button", { name: "Remover imagem 2" })
  );
  await expectFocusRing(box);
  await box.getByRole("button", { name: "Manter imagem" }).click();
  await expect(box).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Remover imagem 2" })
  ).toBeFocused();
});

test("a confirmação aberta com o clique também leva o foco à caixa", async ({
  page,
}) => {
  await openMediaPanel(page, () => undefined);
  await page.getByRole("button", { name: "Remover imagem 2" }).click();
  await expect(
    page.getByRole("group", { name: IMAGE_CONFIRMATION })
  ).toBeFocused();
});

const REFLOW_TOUCH = 44;
const LONG_CUSTOMER = "Bruno Carvalho de Albuquerque Montenegro Filho";
const LONG_CATEGORY =
  "Acessórios para o verão com um nome bem longo que precisa quebrar sem estourar";

const customer = {
  anonymizedAt: null,
  archivedAt: null,
  createdAt: STAMP,
  email: "bruno.carvalho.albuquerque.montenegro@exemplo.com.br",
  id: id(61),
  name: LONG_CUSTOMER,
  notes: null,
  organizationId: ORGANIZATION.id,
  phone: "11 91234-5678",
  status: "active",
  updatedAt: STAMP,
  version: 1,
};

const category = (name: string) => ({
  archivedAt: null,
  createdAt: STAMP,
  deletedAt: null,
  id: id(41),
  name,
  organizationId: ORGANIZATION.id,
  status: "active",
  updatedAt: STAMP,
});

type Answer = (route: Route) => Promise<void>;

const answerWith =
  (json: unknown): Answer =>
  (route) =>
    route.fulfill(rpc(json));

async function openScreen(
  page: Page,
  path: string,
  heading: string,
  answers: Record<string, Answer>
) {
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      body: JSON.stringify({ session: { id: "s" }, user: { id: "u" } }),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    })
  );
  await serveHealth(page);
  await page.route("**/rpc/**", (route) => {
    const procedure = new URL(route.request().url()).pathname.replace(
      "/rpc/",
      ""
    );
    if (procedure === "organization/listMine") {
      return route.fulfill(rpc({ organizations: [ORGANIZATION] }));
    }
    const answer = answers[procedure];
    return answer ? answer(route) : route.abort("internetdisconnected");
  });
  await page.clock.setFixedTime(NOW);
  await page.goto(path);
  await expect(
    page.getByRole("heading", { exact: true, name: heading })
  ).toBeVisible();
}

const CUSTOMER_LIST = {
  "customer/list": answerWith({ customers: [customer] }),
};
const CATEGORY_LIST = {
  "category/list": answerWith({ categories: [category(LONG_CATEGORY)] }),
};

async function askCustomerConfirmation(page: Page) {
  await page
    .getByRole("button", { name: `Mais ações para ${LONG_CUSTOMER}` })
    .click();
  await page.getByRole("menuitem", { exact: true, name: "Anonimizar" }).click();
  return page.getByRole("group", {
    name: `Confirmar a anonimização de ${LONG_CUSTOMER}`,
  });
}

async function askCategoryConfirmation(page: Page) {
  await page
    .getByRole("button", { name: `Mais ações para ${LONG_CATEGORY}` })
    .click();
  await page.getByRole("menuitem", { exact: true, name: "Remover" }).click();
  return page.getByRole("group", {
    name: `Confirmar remoção de ${LONG_CATEGORY}`,
  });
}

async function expectAnswersWhole(page: Page, box: Locator, labels: string[]) {
  await expect(box).toBeVisible();
  const frame = await box.boundingBox();
  expect(frame).not.toBeNull();
  const left = (frame?.x ?? 0) - 0.5;
  const right = (frame?.x ?? 0) + (frame?.width ?? 0) + 0.5;
  const found = await Promise.all(
    labels.map((name) =>
      box.getByRole("button", { exact: true, name }).boundingBox()
    )
  );
  for (const [index, button] of found.entries()) {
    const name = labels[index];
    expect(button, name).not.toBeNull();
    expect(button?.height, name).toBeGreaterThanOrEqual(REFLOW_TOUCH);
    expect(button?.width, name).toBeGreaterThanOrEqual(REFLOW_TOUCH);
    expect(button?.x, name).toBeGreaterThanOrEqual(left);
    expect((button?.x ?? 0) + (button?.width ?? 0), name).toBeLessThanOrEqual(
      right
    );
  }
  await assertNothingClipped(box);
  await assertNoEllipsis(box);
  await assertNoPageScroll(page);
}

test("Categorias: enquanto a remoção corre, a caixa fica, Manter e Remover ficam desligados e Esc não fecha", async ({
  page,
}) => {
  const requests: unknown[] = [];
  let removed = false;
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await openScreen(page, "/categories", "Categorias", {
    "category/delete": async (route) => {
      requests.push((route.request().postDataJSON() as { json: unknown }).json);
      await held;
      removed = true;
      await route.fulfill(
        rpc({
          category: { ...category(LONG_CATEGORY), status: "deleted" },
          changed: true,
        })
      );
    },
    "category/list": async (route) => {
      const { json } = route.request().postDataJSON() as {
        json: { status: string };
      };
      await route.fulfill(
        rpc({
          categories:
            json.status === "active" && !removed
              ? [category(LONG_CATEGORY)]
              : [],
        })
      );
    },
  });
  const box = await askCategoryConfirmation(page);
  const keep = box.getByRole("button", { name: "Manter categoria" });
  const remove = box.getByRole("button", { name: "Remover categoria" });
  await expect(keep).toBeEnabled();
  await expect(remove).toBeEnabled();

  await remove.click();
  await expect.poll(() => requests.length).toBe(1);
  await expect(keep).toBeDisabled();
  await expect(remove).toBeDisabled();
  await expect(box).toBeFocused();

  await remove.click({ force: true });
  await keep.click({ force: true });
  await page.keyboard.press("Escape");
  await expect(box).toBeVisible();
  await expect(box).toBeFocused();
  expect(requests).toHaveLength(1);

  release();
  await expect(box).toHaveCount(0);
  await expect(page.getByText("removida;")).toBeVisible();
  await expect(
    page.getByRole("button", { name: `Mais ações para ${LONG_CATEGORY}` })
  ).toHaveCount(0);
  expect(requests).toHaveLength(1);
});

test.describe("a confirmação da linha a 320 px com a letra do navegador em 20 px", () => {
  skipOutsideChromium();

  reflowTest(
    "Clientes: Manter cliente e Anonimizar definitivamente cabem na caixa, inteiros e do tamanho do toque",
    async ({ page }) => {
      await openReflowViewport(page);
      await openScreen(page, "/customers", "Clientes", CUSTOMER_LIST);
      await expectReflowFont(page);
      const box = await askCustomerConfirmation(page);
      await expectAnswersWhole(page, box, [
        "Manter cliente",
        "Anonimizar definitivamente",
      ]);
    }
  );

  reflowTest(
    "Categorias: Manter categoria e Remover categoria cabem na caixa, inteiros e do tamanho do toque",
    async ({ page }) => {
      await openReflowViewport(page);
      await openScreen(page, "/categories", "Categorias", CATEGORY_LIST);
      await expectReflowFont(page);
      const box = await askCategoryConfirmation(page);
      await expectAnswersWhole(page, box, [
        "Manter categoria",
        "Remover categoria",
      ]);
    }
  );
});
