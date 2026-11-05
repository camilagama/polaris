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

const REFUSED = (route: Route) =>
  route.fulfill(api({ error: { code: "not_found" } }, 404));
const REFUSAL_TEXT =
  "Este produto ou esta imagem não foi encontrado. Recarregamos a lista.";

test("remover com recusa definitiva diz que a lista foi recarregada e leva o foco ao título da lista", async ({
  page,
}) => {
  await openMediaPanel(page, { lists: [list(2), list(1)], remove: REFUSED });
  await page.getByRole("button", { name: "Remover imagem 2" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Remover imagem" })
    .click();
  await expect(page.getByRole("alert")).toHaveText(REFUSAL_TEXT);
  await expect(page.getByText("Imagem 1 de 1")).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 3, name: "Imagens associadas" })
  ).toBeFocused();
});

async function confirmReplace(page: Page) {
  await page.getByRole("button", { name: "Substituir imagem 2" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Remover e escolher outra" })
    .click();
}

test("substituir uma imagem que já não existe diz que a lista foi recarregada e leva o foco ao título da lista", async ({
  page,
}) => {
  await openMediaPanel(page, { lists: [list(2), list(1)], remove: REFUSED });
  await confirmReplace(page);
  await expect(page.getByRole("alert")).toHaveText(REFUSAL_TEXT);
  await expect(page.getByText("Imagem 1 de 1")).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 3, name: "Imagens associadas" })
  ).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Escolher imagem" })
  ).not.toBeFocused();
  await expect(page.getByText("A imagem anterior foi removida.")).toHaveCount(
    0
  );
});

test("substituir com sucesso remove a imagem e leva o foco ao botão de escolher o arquivo", async ({
  page,
}) => {
  await openMediaPanel(page, {
    lists: [list(2), list(1)],
    remove: (route) =>
      route.fulfill(api({ removed: true, requestId: REQUEST_ID })),
  });
  await confirmReplace(page);
  await expect(page.getByText("A imagem anterior foi removida.")).toBeVisible();
  await expect(page.getByText("Imagem 1 de 1")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Escolher imagem" })
  ).toBeFocused();
});

test("mover com recusa definitiva diz que a lista foi recarregada e o foco fica no botão que foi usado", async ({
  page,
}) => {
  await openMediaPanel(page, { lists: [list(3), list(2)], reorder: REFUSED });
  await page
    .getByRole("button", { name: "Mover imagem 1 para depois" })
    .click();
  await expect(page.getByRole("alert")).toHaveText(REFUSAL_TEXT);
  await expect(page.getByText("Imagem 1 de 2")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Mover imagem 1 para depois" })
  ).toBeFocused();
});

test("remover sem internet anuncia o resultado incerto como alerta, mantém a lista e deixa o foco no botão de remover", async ({
  page,
}) => {
  await openMediaPanel(page, {
    lists: [list(2)],
    remove: (route) => route.abort("internetdisconnected"),
  });
  await page.getByRole("button", { name: "Remover imagem 2" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Remover imagem" })
    .click();
  await expect(page.getByRole("alert")).toHaveText(
    "Sem internet. Tente de novo quando a conexão voltar; repetir é seguro."
  );
  await expect(page.getByText("Imagem 1 de 2")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Remover imagem 2" })
  ).toBeFocused();
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

/** The width, height and type the browser decodes from a body the panel sent. */
function decodedSize(page: Page, body: Buffer) {
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes]));
    const size = { height: bitmap.height, width: bitmap.width };
    bitmap.close();
    return size;
  }, body.toString("base64"));
}

const created = api(
  { asset: mediaAsset(0), replayed: false, requestId: REQUEST_ID },
  201
);

test("envia o recorte já reduzido a 1200 px em JPEG, com o recorte da imagem inteira", async ({
  page,
}) => {
  const sent: { body: Buffer; crop: string | null; type: string | null }[] = [];
  await openMediaPanel(page, {
    lists: [list(0), list(1)],
    upload: (route) => {
      const request = route.request();
      sent.push({
        body: request.postDataBuffer() ?? Buffer.alloc(0),
        crop: request.headers()["x-media-crop"] ?? null,
        type: request.headers()["content-type"] ?? null,
      });
      return route.fulfill(created);
    },
  });
  await page.getByLabel("Escolher imagem").setInputFiles({
    buffer: solidPng(2400, 1600),
    mimeType: "image/png",
    name: "foto.png",
  });
  await page.getByRole("button", { name: "Enviar imagem" }).click();
  await expect(page.getByText("Imagem adicionada ao produto.")).toBeVisible();

  expect(sent).toHaveLength(1);
  const [upload] = sent;
  expect(upload?.type).toBe("image/jpeg");
  expect(JSON.parse(upload?.crop ?? "null")).toEqual({
    height: 1,
    width: 1,
    x: 0,
    y: 0,
  });
  // a JPEG starts with FF D8 FF
  expect([...(upload?.body.subarray(0, 3) ?? [])]).toEqual([0xff, 0xd8, 0xff]);
  await expect(
    decodedSize(page, upload?.body ?? Buffer.alloc(0))
  ).resolves.toEqual({
    height: 800,
    width: 1200,
  });
});

/** A JPEG photo of `width` × `height`, encoded by the browser: two colors split at the middle, to see the crop. */
async function photoJpeg(page: Page, width: number, height: number) {
  const base64 = await page.evaluate(
    async ([w, h]) => {
      const canvas = new OffscreenCanvas(w, h);
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("no 2d context");
      }
      context.fillStyle = "rgb(30 90 200)";
      context.fillRect(0, 0, w, h);
      context.fillStyle = "rgb(220 60 40)";
      context.fillRect(0, h / 2, w, h / 2);
      const blob = await canvas.convertToBlob({
        quality: 0.92,
        type: "image/jpeg",
      });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (const byte of bytes) {
        binary += String.fromCharCode(byte);
      }
      return btoa(binary);
    },
    [width, height] as const
  );
  return Buffer.from(base64, "base64");
}

test("uma foto JPEG em retrato com recorte sai só com o recorte, reduzido a 1200 px no lado maior", async ({
  page,
}) => {
  const sent: Buffer[] = [];
  await openMediaPanel(page, {
    lists: [list(0), list(1)],
    upload: (route) => {
      sent.push(route.request().postDataBuffer() ?? Buffer.alloc(0));
      return route.fulfill(created);
    },
  });
  await page.getByLabel("Escolher imagem").setInputFiles({
    buffer: await photoJpeg(page, 3000, 4000),
    mimeType: "image/jpeg",
    name: "retrato.jpg",
  });
  const area = page.getByRole("button", {
    name: "Área de recorte. Arraste ou use as setas para ajustar.",
  });
  await expect(area).toBeVisible();
  const box = await area.boundingBox();
  if (!box) {
    throw new Error("the crop area has no box");
  }
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.5, {
    steps: 4,
  });
  await page.mouse.up();
  await page.getByRole("button", { name: "Enviar imagem" }).click();
  await expect(page.getByText("Imagem adicionada ao produto.")).toBeVisible();

  expect(sent).toHaveLength(1);
  const size = await decodedSize(page, sent[0] ?? Buffer.alloc(0));
  // the whole photo would be 900 × 1200; the crop of 1500 × 1000 is 1200 × 800 (the drag lands within a pixel or two)
  expect(size.width).toBe(1200);
  expect(Math.abs(size.height - 800)).toBeLessThanOrEqual(3);
});

test("a nova tentativa depois de cair a conexão envia os mesmos bytes, com o mesmo comando", async ({
  page,
}) => {
  const sent: { body: Buffer; uploadId: string | null }[] = [];
  await openMediaPanel(page, {
    lists: [list(0), list(1)],
    upload: (route) => {
      const request = route.request();
      sent.push({
        body: request.postDataBuffer() ?? Buffer.alloc(0),
        uploadId: request.headers()["x-upload-id"] ?? null,
      });
      return sent.length === 1
        ? route.abort("internetdisconnected")
        : route.fulfill(created);
    },
  });
  await page.getByLabel("Escolher imagem").setInputFiles({
    buffer: solidPng(1600, 1200, [200, 120, 90]),
    mimeType: "image/png",
    name: "foto.png",
  });
  await page.getByRole("button", { name: "Enviar imagem" }).click();
  await expect(page.getByRole("alert")).toContainText("Sem internet.");
  await page.getByRole("button", { name: "Enviar imagem" }).click();
  await expect(page.getByText("Imagem adicionada ao produto.")).toBeVisible();

  expect(sent).toHaveLength(2);
  const [first, retry] = sent;
  expect(retry?.uploadId).toBe(first?.uploadId);
  expect(retry?.body.equals(first?.body ?? Buffer.alloc(0))).toBe(true);
  await expect(
    decodedSize(page, retry?.body ?? Buffer.alloc(0))
  ).resolves.toEqual({
    height: 900,
    width: 1200,
  });
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
