/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { activateByKeyboard, expectFocusRing } from "./focus-ring";
import { mediaListBody, solidPng } from "./media-fixtures";
import { WORKER_MARK } from "./worker-mark";

/**
 * The keyboard side of `InlineConfirm` (src/ui/inline-confirm.tsx) on the images panel of the products screen: the
 * box takes the focus when it opens and the keyboard sees it, Esc keeps the image and gives the focus back to the
 * button that asked while the dialog of the product stays open. The remove flow itself is proved in
 * `product-media-screen.e2e.ts`.
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
