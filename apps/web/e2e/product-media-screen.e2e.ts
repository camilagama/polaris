/// <reference lib="dom" />
import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { activateByKeyboard, expectFocusRing } from "./focus-ring";
import { mediaAsset, mediaListBody, solidPng } from "./media-fixtures";
import { WORKER_MARK } from "./worker-mark";

/**
 * The images panel of the products screen on the components of src/ui (v5.1), in the real route with the API answered
 * by the test (the server mode, no offline runtime): it opens on the product's menu, in the tab "Imagens" of the product
 * dialog, and the tab takes the focus; the ends of
 * the list cannot move, a move sends the whole order and the focus stays on the same image, removing asks first and
 * then says what happened, a list that does not load is not an empty list, and a send without internet says so in the
 * words of the shop. The panel's own states are measured in the guardrails (`e2e-pwa/ui-product-states.ts`).
 */
const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const id = (n: number) => `0199c2d0-0000-7000-8000-0000000000${n}`;
const REQUEST_ID = "0199c2d0-0000-7000-8000-0000000000aa";

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
  createdAt: "2026-10-14T12:00:00.000Z",
  deletedAt: null,
  description: null,
  id: id(21),
  name: "Camiseta do teste",
  organizationId: ORGANIZATION.id,
  status: "active",
  updatedAt: "2026-10-14T12:00:00.000Z",
  version: 1,
};

const VARIANTS = {
  configured: true,
  options: [],
  productVersion: 2,
  variants: [
    { id: id(31), isDefault: true, listPrice: null, sku: null, values: [] },
    ...[
      [61, "Azul"],
      [62, "Preta"],
    ].map(([n, name]) => ({
      id: id(Number(n)),
      isDefault: false,
      listPrice: "50.00",
      sku: null,
      values: [
        { optionName: "color", optionValueId: id(40), optionValueName: name },
      ],
    })),
  ],
};

type Handler = (route: Route) => Promise<void>;

interface MediaApi {
  /** One answer per `GET /media`, in order; the last one repeats. */
  lists: Handler[];
  remove?: Handler;
  reorder?: Handler;
  upload?: Handler;
}

async function openMediaPanel(page: Page, media: MediaApi) {
  let reads = 0;
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
    const { pathname } = new URL(route.request().url());
    if (method === "GET") {
      const answer = media.lists[Math.min(reads, media.lists.length - 1)];
      reads += 1;
      return answer ? answer(route) : route.abort("internetdisconnected");
    }
    const handler = pathname.endsWith("/order")
      ? media.reorder
      : { DELETE: media.remove, POST: media.upload }[method];
    return handler ? handler(route) : route.abort("internetdisconnected");
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

const list =
  (count: number): Handler =>
  (route) =>
    route.fulfill(api(mediaListBody(count)));

test("abre pelo menu na aba Imagens do produto, com o foco na aba, com as imagens vistas e as pontas da lista sem movimento", async ({
  page,
}) => {
  await openMediaPanel(page, { lists: [list(3)] });
  // the dialog of the product opens on its tab "Imagens", which takes the focus
  await expect(
    page.getByRole("dialog", { name: "Camiseta do teste" })
  ).toBeVisible();
  await expect(page.getByRole("tab", { name: "Imagens" })).toBeFocused();
  await expect(page.getByText("Imagem 1 de 3")).toBeVisible();
  await expect(page.getByText("1000 × 800 · 0,3 MB").first()).toBeVisible();
  const first = page.getByRole("img", { name: "Camiseta do teste, imagem 1" });
  await expect(first).toBeVisible();
  await expect
    .poll(() => first.evaluate((node: HTMLImageElement) => node.naturalWidth))
    .toBeGreaterThan(0);
  await expect(
    page.getByRole("button", { name: "Mover imagem 1 para antes" })
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Mover imagem 1 para depois" })
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Mover imagem 3 para depois" })
  ).toBeDisabled();
  // the variants the image can be tied to are choices, not text
  await expect(page.getByRole("checkbox", { name: "Azul" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Preta" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Enviar imagem" })
  ).toBeDisabled();
  // Fechar gives the focus back to the menu of the product
  await page.getByRole("button", { name: "Fechar" }).click();
  await expect(
    page.getByRole("button", { name: "Mais ações para Camiseta do teste" })
  ).toBeFocused();
});

test("mover envia a ordem inteira, diz o resultado e deixa o foco na mesma imagem", async ({
  page,
}) => {
  let sent: unknown = null;
  await openMediaPanel(page, {
    lists: [list(3)],
    reorder: (route) => {
      sent = route.request().postDataJSON();
      const order = [1, 0, 2].map((n) => mediaAsset(n));
      return route.fulfill(api({ media: order, requestId: REQUEST_ID }));
    },
  });
  await page
    .getByRole("button", { name: "Mover imagem 1 para depois" })
    .click();
  await expect(
    page.getByText("Imagem 1 movida para a posição 2.")
  ).toBeVisible();
  expect(sent).toEqual({
    assetIds: [1, 0, 2].map((n) => mediaAsset(n).assetId),
  });
  // the image that moved is the second now, and its button is the one with the focus
  await expect(
    page.getByRole("button", { name: "Mover imagem 2 para depois" })
  ).toBeFocused();
});

test("remover pergunta antes, diz o que acontece e o que fica, e depois leva o foco ao título da lista", async ({
  page,
}) => {
  let removed = 0;
  await openMediaPanel(page, {
    lists: [list(2), list(1)],
    remove: (route) => {
      removed += 1;
      return route.fulfill(api({ removed: true, requestId: REQUEST_ID }));
    },
  });
  await page.getByRole("button", { name: "Remover imagem 2" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Remover a imagem 2?");
  await expect(dialog).toContainText(
    "Para voltar a usá-la, será preciso enviar o arquivo de novo."
  );
  // the safe answer takes the focus
  await expect(
    dialog.getByRole("button", { name: "Manter imagem" })
  ).toBeFocused();
  expect(removed).toBe(0);
  await dialog.getByRole("button", { name: "Manter imagem" }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Remover imagem 2" })
  ).toBeFocused();

  await page.getByRole("button", { name: "Remover imagem 2" }).click();
  await activateByKeyboard(
    page,
    page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Remover imagem" })
  );
  await expect(
    page.getByText(
      "Imagem 2 removida do produto. Um lugar foi liberado no plano."
    )
  ).toBeVisible();
  expect(removed).toBe(1);
  await expect(page.getByText("Imagem 1 de 1")).toBeVisible();
  // the heading of the list takes the focus, and the keyboard sees it
  await expectFocusRing(
    page.getByRole("heading", { level: 3, name: "Imagens associadas" })
  );
});

test("a lista de imagens que não carrega diz o motivo e oferece 'Tentar novamente', nunca o vazio", async ({
  page,
}) => {
  await openMediaPanel(page, {
    lists: [
      (route) =>
        route.fulfill(
          api({ error: { code: "media_processing_unavailable" } }, 503)
        ),
      list(1),
    ],
  });
  const alert = page.getByRole("alert");
  await expect(alert).toContainText(
    "O processamento de imagens está indisponível."
  );
  await expect(
    page.getByText("Ainda não há imagens neste produto.")
  ).toHaveCount(0);
  await alert.getByRole("button", { name: "Tentar novamente" }).click();
  await expect(page.getByText("Imagem 1 de 1")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("sem imagem, o painel diz o próximo passo", async ({ page }) => {
  await openMediaPanel(page, { lists: [list(0)] });
  await expect(
    page.getByText("Ainda não há imagens neste produto.")
  ).toBeVisible();
  await expect(page.getByText("Escolha uma acima para enviar.")).toBeVisible();
});

test("enviar sem internet diz 'Sem internet' e que repetir é seguro, e a imagem escolhida fica", async ({
  page,
}) => {
  await openMediaPanel(page, { lists: [list(0)] });
  await page.getByLabel("Escolher imagem").setInputFiles({
    buffer: solidPng(480, 320),
    mimeType: "image/png",
    name: "foto.png",
  });
  await expect(
    page.getByRole("button", {
      name: "Área de recorte. Arraste ou use as setas para ajustar.",
    })
  ).toBeVisible();
  await page.getByRole("button", { name: "Enviar imagem" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Sem internet. Tente de novo quando a conexão voltar; repetir é seguro."
  );
  // nothing was lost: the crop area and the button are still there for the next try
  await expect(
    page.getByRole("button", { name: "Enviar imagem" })
  ).toBeEnabled();
});

/** No box of the panel ends beyond the right edge of the window (the page may hide it, so boxes are measured). */
async function expectNoSidewaysScroll(page: Page) {
  const found = await page.evaluate(() => {
    const panel = document.querySelector(
      '[role="tabpanel"][data-slot="tabs-content"]:not([hidden])'
    );
    const limit = window.innerWidth + 0.5;
    const boxes = [...(panel?.querySelectorAll("*") ?? [])].map((element) => ({
      right: element.getBoundingClientRect().right,
      text: (element.textContent ?? "").trim().slice(0, 40),
    }));
    return {
      measured: boxes.length,
      past: boxes.filter((box) => box.right > limit),
    };
  });
  // nothing passes vacuously: the panel is there and was measured
  expect(found.measured).toBeGreaterThan(30);
  expect(found.past).toEqual([]);
}

test("a 320 px nada transborda no painel aberto: a lista, a confirmação de remover e a imagem escolhida", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name.includes("mobile"),
    "the test sets its own width"
  );
  await page.setViewportSize({ height: 740, width: 320 });
  await openMediaPanel(page, { lists: [list(2)] });
  await expectNoSidewaysScroll(page);

  await page.getByRole("button", { name: "Remover imagem 2" }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await expectNoSidewaysScroll(page);
  // the answers of the confirmation are controls of the shop's size, side by side or stacked, never cut
  const answers = ["Manter imagem", "Remover imagem"].map((name) =>
    page
      .getByRole("alertdialog")
      .getByRole("button", { exact: true, name })
      .boundingBox()
  );
  for (const box of await Promise.all(answers)) {
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(32);
  }
  await page.getByRole("button", { name: "Manter imagem" }).click();

  await page.getByLabel("Escolher imagem").setInputFiles({
    buffer: solidPng(900, 600),
    mimeType: "image/png",
    name: "foto.png",
  });
  await page.getByRole("button", { name: "Ajustar com o dedo" }).click();
  await expect(
    page.getByRole("button", { name: "Concluir ajuste" })
  ).toHaveAttribute("aria-pressed", "true");
  await expectNoSidewaysScroll(page);
});
