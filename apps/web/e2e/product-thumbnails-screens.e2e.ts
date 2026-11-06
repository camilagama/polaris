/// <reference lib="dom" />
import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { serveHealth, WORKER_MARK } from "./worker-mark";

/**
 * The capa of a product in Produtos, in Estoque and in the sale, on the real routes with the API answered here: with the
 * `mediaThumbs` of `organization.listMine` off nothing is asked and the rows are the ones from before; on, the box
 * is 40 px in Produtos and 32 px in the sale, as tall with a photo as with the marker, and a capa already shown is
 * never asked for again. The images are synthetic.
 */
const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const id = (n: number) => `0199c2d0-0000-7000-8000-0000000000${n}`;
const COVER_A = "0199c2d0-0000-7000-8000-000000000c01";
const COVER_MISSING = "0199c2d0-0000-7000-8000-000000000c03";
const VIEWPORTS = [
  { height: 740, name: "360", width: 360 },
  { height: 800, name: "1280", width: 1280 },
] as const;
const ONE_PIXEL = 1;
const MAX_IDS_PER_REQUEST = 5;

const rpc = (json: unknown, status = 200) => ({
  body: JSON.stringify({ json, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
  status,
});

const product = (n: number, name: string, coverAssetId: string | null) => ({
  archivedAt: null,
  categoryId: null,
  coverAssetId,
  createdAt: "2026-10-14T12:00:00.000Z",
  deletedAt: null,
  description: null,
  id: id(20 + n),
  name,
  organizationId: ORGANIZATION.id,
  status: "active",
  updatedAt: "2026-10-14T12:00:00.000Z",
  version: 1,
});

const PRODUCTS = [
  product(1, "Camiseta com foto", COVER_A),
  product(2, "Calça sem imagem", null),
  product(3, "Boné com capa ausente", COVER_MISSING),
  product(4, "Bolsa com a mesma foto", COVER_A),
];

const entry = (
  n: number,
  productName: string,
  color: string,
  coverAssetId: string | null | undefined
) => ({
  ...(coverAssetId === undefined ? {} : { coverAssetId }),
  isDefaultVariant: false,
  listPrice: "50.00",
  movingAverageCost: null,
  productId: id(20 + n),
  productName,
  productStatus: "active",
  quantity: 5,
  sku: `SKU-${n}${color}`,
  updatedAt: "2026-10-14T12:00:00.000Z",
  values: [{ optionName: "color", optionValueName: color }],
  variantId: id(40 + n + (color === "Azul" ? 0 : 10)),
  version: 1,
});

type ThumbsMode = "ok" | "unavailable";

interface Store {
  balanceRequests: string[];
  thumbBatches: string[][];
}

async function webp(page: Page, width: number, height: number) {
  const base64 = await page.evaluate(
    async ([w, h]) => {
      const canvas = new OffscreenCanvas(w as number, h as number);
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("no 2d context");
      }
      context.fillStyle = "rgb(60, 120, 200)";
      context.fillRect(0, 0, w as number, h as number);
      context.fillStyle = "rgb(250, 200, 60)";
      context.fillRect(0, 0, (w as number) / 2, (h as number) / 2);
      const blob = await canvas.convertToBlob({ type: "image/webp" });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (const byte of bytes) {
        binary += String.fromCharCode(byte);
      }
      return btoa(binary);
    },
    [width, height]
  );
  return Buffer.from(base64, "base64");
}

async function installStore(
  page: Page,
  options: {
    entries?: unknown[];
    mediaThumbs: boolean;
    mode?: () => ThumbsMode;
    thumbsStatus?: () => number | null;
    products?: unknown[];
  }
): Promise<Store> {
  await page.goto("about:blank");
  const photo = await webp(page, 320, 320);
  const store: Store = { balanceRequests: [], thumbBatches: [] };
  await serveHealth(page);
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      body: JSON.stringify({ session: { id: "s" }, user: { id: "u" } }),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    })
  );
  await page.route("**/api/media/thumbs**", (route) => {
    const ids = (new URL(route.request().url()).searchParams.get("ids") ?? "")
      .split(",")
      .filter(Boolean);
    store.thumbBatches.push(ids);
    const refused = options.thumbsStatus?.() ?? null;
    if (refused !== null) {
      return route.fulfill({
        body: "",
        headers: { ...WORKER_MARK },
        status: refused,
      });
    }
    if ((options.mode?.() ?? "ok") === "unavailable") {
      return route.fulfill({
        body: "",
        headers: { ...WORKER_MARK },
        status: 503,
      });
    }
    const found = ids.filter((each) => each !== COVER_MISSING);
    return route.fulfill({
      body: Buffer.concat(found.map(() => photo)),
      headers: {
        ...WORKER_MARK,
        "cache-control": "private, no-store",
        "content-type": "application/octet-stream",
        "x-polaris-thumbs": ids
          .map((each) =>
            each === COVER_MISSING
              ? `${each}:missing`
              : `${each}:${photo.length}`
          )
          .join(","),
      },
      status: 200,
    });
  });
  await page.route("**/rpc/**", (route: Route) => {
    const procedure = new URL(route.request().url()).pathname.replace(
      "/rpc/",
      ""
    );
    switch (procedure) {
      case "organization/listMine":
        return route.fulfill(
          rpc({
            billingSelfService: false,
            mediaThumbs: options.mediaThumbs,
            organizations: [ORGANIZATION],
          })
        );
      case "category/list":
        return route.fulfill(rpc({ categories: [] }));
      case "product/list":
        return route.fulfill(rpc({ products: options.products ?? [] }));
      case "inventory/listBalances":
        store.balanceRequests.push(route.request().postData() ?? "");
        return route.fulfill(
          rpc({ entries: options.entries ?? [], nextCursor: null })
        );
      case "paymentProfile/list":
        return route.fulfill(rpc({ profiles: [] }));
      default:
        return route.abort("internetdisconnected");
    }
  });
  return store;
}

const rows = (page: Page) => page.locator("li[data-product-id]");

async function geometry(page: Page) {
  return await page.evaluate(() =>
    [...document.querySelectorAll("li[data-product-id]")].map((row) => {
      const box = row.querySelector("[data-thumbnail]");
      const rect = box?.getBoundingClientRect();
      const circle = row.querySelector("span.rounded-full");
      return {
        circle: Boolean(circle),
        height: row.getBoundingClientRect().height,
        photo: box?.getAttribute("data-thumbnail") === "photo",
        thumb: rect ? { h: rect.height, w: rect.width } : null,
        thumbRadius: box ? getComputedStyle(box).borderTopLeftRadius : null,
      };
    })
  );
}

for (const viewport of VIEWPORTS) {
  test(`Produtos a ${viewport.name} px: chave desligada mostra o círculo de iniciais e não pede nenhuma miniatura`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const store = await installStore(page, {
      mediaThumbs: false,
      products: PRODUCTS,
    });
    await page.goto("/products");
    await expect(rows(page)).toHaveCount(PRODUCTS.length);
    const measured = await geometry(page);
    expect(measured.every((row) => row.circle && row.thumb === null)).toBe(
      true
    );
    await expect(page.locator("[data-thumbnail]")).toHaveCount(0);
    await page.waitForLoadState("networkidle");
    expect(store.thumbBatches).toEqual([]);
  });

  test(`Produtos a ${viewport.name} px: com a chave ligada a caixa é de 40 px e a linha tem a mesma altura com foto, sem imagem, com capa ausente e com o servidor fora`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    let mode: ThumbsMode = "ok";
    const store = await installStore(page, {
      mediaThumbs: true,
      mode: () => mode,
      products: PRODUCTS,
    });
    await page.goto("/products");
    await expect(rows(page)).toHaveCount(PRODUCTS.length);
    await expect
      .poll(
        async () => (await geometry(page)).filter((row) => row.photo).length
      )
      .toBe(2);

    const withPhotos = await geometry(page);
    expect(withPhotos.map((row) => row.photo)).toEqual([
      true,
      false,
      false,
      true,
    ]);
    for (const row of withPhotos) {
      expect(row.circle).toBe(false);
      expect(row.thumb).toEqual({ h: 40, w: 40 });
    }
    const heights = withPhotos.map((row) => row.height);
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(
      ONE_PIXEL
    );
    expect(new Set(withPhotos.map((row) => row.thumbRadius)).size).toBe(1);

    for (const batch of store.thumbBatches) {
      expect(batch.length).toBeLessThanOrEqual(MAX_IDS_PER_REQUEST);
    }
    expect(store.thumbBatches.flat().sort()).toEqual(
      [COVER_A, COVER_MISSING].sort()
    );

    mode = "unavailable";
    store.thumbBatches.length = 0;
    await page.reload();
    await expect(rows(page)).toHaveCount(PRODUCTS.length);
    await expect.poll(() => store.thumbBatches.length).toBeGreaterThan(0);
    const failed = await geometry(page);
    expect(failed.every((row) => !row.photo && row.thumb?.h === 40)).toBe(true);
    failed.forEach((row, index) => {
      expect(
        Math.abs(row.height - (withPhotos[index]?.height ?? 0))
      ).toBeLessThanOrEqual(ONE_PIXEL);
    });
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
}

test("Produtos: a foto é decoração, o nome da linha não muda e o recorte é o centro da imagem", async ({
  page,
}) => {
  await page.setViewportSize({ height: 800, width: 1280 });
  await installStore(page, { mediaThumbs: true, products: PRODUCTS });
  await page.goto("/products");
  await expect(page.locator('[data-thumbnail="photo"]')).toHaveCount(2);
  const first = rows(page).first();
  await expect(
    first.getByRole("button", { name: "Editar Camiseta com foto" })
  ).toBeVisible();
  const picture = first.locator("[data-thumbnail] img");
  await expect(picture).toHaveAttribute("alt", "");
  expect(
    await picture.evaluate((node) => getComputedStyle(node).objectFit)
  ).toBe("cover");
  expect(
    await first
      .locator("[data-thumbnail]")
      .evaluate((node) => node.getAttribute("aria-hidden"))
  ).toBe("true");
});

const SHIRT = (cover: string | null | undefined) =>
  entry(1, "Camiseta com foto", "Azul", cover);
const SEARCH = /Camiseta com foto · Azul/;

test("Venda: chave desligada não pede capa, não acrescenta withCover e a busca é a de hoje", async ({
  page,
}) => {
  await page.setViewportSize({ height: 740, width: 360 });
  const store = await installStore(page, {
    entries: [SHIRT(undefined)],
    mediaThumbs: false,
  });
  await page.goto("/sales");
  await page.getByLabel("Produto ou variante").fill("camiseta");
  await page.getByRole("option", { name: SEARCH }).click();
  await expect(page.locator("[data-thumbnail]")).toHaveCount(0);
  await page.waitForLoadState("networkidle");
  expect(store.thumbBatches).toEqual([]);
  expect(store.balanceRequests.length).toBeGreaterThan(0);
  for (const body of store.balanceRequests) {
    expect(body).not.toContain("withCover");
  }
});

for (const viewport of VIEWPORTS) {
  test(`Venda a ${viewport.name} px: a busca e o item mostram a capa do produto em 32 px, a linha do item não muda e a capa já vista não é pedida de novo`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const store = await installStore(page, {
      entries: [
        SHIRT(COVER_A),
        entry(1, "Camiseta com foto", "Preta", COVER_A),
        entry(2, "Calça sem imagem", "Azul", null),
      ],
      mediaThumbs: true,
    });
    await page.goto("/sales");
    const search = page.getByLabel("Produto ou variante");
    await search.click();
    await expect(page.getByRole("option")).toHaveCount(3);
    await expect(page.locator('[data-thumbnail="photo"]')).toHaveCount(2);
    for (const box of await page.locator("[data-thumbnail]").all()) {
      // biome-ignore lint/performance/noAwaitInLoops: each box is measured on its own
      const rect = await box.evaluate((node) => {
        const { height, width } = node.getBoundingClientRect();
        return {
          height,
          radius: getComputedStyle(node).borderTopLeftRadius,
          width,
        };
      });
      expect(rect.width).toBe(32);
      expect(rect.height).toBe(32);
    }
    const options = await page
      .getByRole("option")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getBoundingClientRect().height)
      );
    expect(Math.max(...options) - Math.min(...options)).toBeLessThanOrEqual(
      ONE_PIXEL
    );
    expect(
      store.balanceRequests.some((body) => body.includes('"withCover":true'))
    ).toBe(true);
    const batchesAfterFirstOpen = store.thumbBatches.length;
    expect(store.thumbBatches.flat()).toEqual([COVER_A]);

    for (const text of "camiseta".split("")) {
      // biome-ignore lint/performance/noAwaitInLoops: one key at a time
      await search.press(text);
    }
    await expect(page.getByRole("option")).not.toHaveCount(0);
    expect(store.thumbBatches.length).toBe(batchesAfterFirstOpen);

    await page.getByRole("option", { name: SEARCH }).click();
    const item = page.getByRole("group", { exact: true, name: "Item 1" });
    await expect(item.locator("[data-thumbnail]")).toBeVisible();
    await expect(item.locator('[data-thumbnail="photo"]')).toBeVisible();
    const box = await item.locator("[data-thumbnail]").boundingBox();
    expect(box?.width).toBe(32);
    expect(box?.height).toBe(32);
    expect(store.thumbBatches.length).toBe(batchesAfterFirstOpen);
  });
}

test("Venda: com o servidor de miniaturas fora (marcador) o item tem a mesma altura da linha com foto", async ({
  page,
}) => {
  await page.setViewportSize({ height: 740, width: 360 });
  let mode: ThumbsMode = "ok";
  await installStore(page, {
    entries: [SHIRT(COVER_A)],
    mediaThumbs: true,
    mode: () => mode,
  });
  const item = page.getByRole("group", { exact: true, name: "Item 1" });
  await page.goto("/sales");
  await page.getByLabel("Produto ou variante").click();
  await page.getByRole("option", { name: SEARCH }).click();
  await expect(item.locator('[data-thumbnail="photo"]')).toBeVisible();
  const withPhoto = (await item.boundingBox())?.height ?? 0;

  // the cart comes back from the tab's draft: the capa is read again with the balances of its lines, and fails
  mode = "unavailable";
  await page.reload();
  await expect(item.locator('[data-thumbnail="marker"]')).toBeVisible();
  await expect(
    item.getByText("Camiseta com foto · Azul", { exact: true })
  ).toBeVisible();
  const withMarker = (await item.boundingBox())?.height ?? 0;
  expect(Math.abs(withPhoto - withMarker)).toBeLessThanOrEqual(ONE_PIXEL);
});

const STOCK_ENTRIES = [
  entry(1, "Camiseta com foto", "Azul", COVER_A),
  entry(1, "Camiseta com foto", "Preta", COVER_A),
  entry(2, "Calça sem imagem", "Azul", null),
  entry(3, "Boné com capa ausente", "Azul", COVER_MISSING),
  entry(4, "Bolsa sem a capa na resposta", "Azul", undefined),
].map((each) => ({ ...each, movingAverageCost: "12.000000" }));

const CLOSE_PANEL = /^(Cancelar|Fechar)$/;

const stockItems = (page: Page) =>
  page.locator('ul[aria-label="Saldos por variante"] > li');

async function stockGeometry(page: Page) {
  return await page.evaluate(() =>
    [
      ...document.querySelectorAll('ul[aria-label="Saldos por variante"] > li'),
    ].map((row) => {
      const box = row.querySelector("[data-thumbnail]");
      const rect = box?.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      return {
        height: rowRect.height,
        photo: box?.getAttribute("data-thumbnail") === "photo",
        thumb: rect
          ? { h: rect.height, w: rect.width, x: rect.left - rowRect.left }
          : null,
        thumbRadius: box ? getComputedStyle(box).borderTopLeftRadius : null,
      };
    })
  );
}

for (const viewport of VIEWPORTS) {
  test(`Estoque a ${viewport.name} px: chave desligada é a tela de hoje, sem caixa, sem withCover e sem pedido de miniatura`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const store = await installStore(page, {
      entries: STOCK_ENTRIES.map((each) => {
        const { coverAssetId: _omitted, ...rest } = each as {
          coverAssetId?: string | null;
        };
        return rest;
      }),
      mediaThumbs: false,
    });
    await page.goto("/inventory");
    await expect(stockItems(page)).toHaveCount(STOCK_ENTRIES.length);
    await expect(page.locator("[data-thumbnail]")).toHaveCount(0);
    await page.waitForLoadState("networkidle");
    expect(store.thumbBatches).toEqual([]);
    expect(store.balanceRequests.length).toBeGreaterThan(0);
    for (const body of store.balanceRequests) {
      expect(body).not.toContain("withCover");
    }
  });

  test(`Estoque a ${viewport.name} px: a caixa é de 40 px e a linha tem a mesma altura com foto, marcador, capa ausente, servidor de miniaturas fora e chave desligada`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const first = await installStore(page, {
      entries: STOCK_ENTRIES,
      mediaThumbs: false,
    });
    await page.goto("/inventory");
    await expect(stockItems(page)).toHaveCount(STOCK_ENTRIES.length);
    const off = await stockGeometry(page);
    expect(off.every((row) => row.thumb === null)).toBe(true);

    await page.waitForLoadState("networkidle");
    expect(first.thumbBatches).toEqual([]);
    await page.unrouteAll({ behavior: "ignoreErrors" });
    const second = await installStore(page, {
      entries: STOCK_ENTRIES,
      mediaThumbs: true,
    });
    await page.goto("/inventory");
    await expect(stockItems(page)).toHaveCount(STOCK_ENTRIES.length);
    await expect
      .poll(
        async () =>
          (await stockGeometry(page)).filter((row) => row.photo).length
      )
      .toBe(2);
    const on = await stockGeometry(page);
    expect(on.map((row) => row.photo)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
    for (const row of on) {
      expect(row.thumb?.h).toBe(40);
      expect(row.thumb?.w).toBe(40);
    }
    expect(new Set(on.map((row) => row.thumb?.x)).size).toBe(1);
    expect(new Set(on.map((row) => row.thumbRadius)).size).toBe(1);
    const heights = on.map((row) => row.height);
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(
      ONE_PIXEL
    );
    on.forEach((row, index) => {
      expect(
        Math.abs(row.height - (off[index]?.height ?? 0))
      ).toBeLessThanOrEqual(ONE_PIXEL);
    });

    // the list is read once, asking for the capas; the two counts of the strip are the other reads, and none
    // reads a product on its own
    const listReads = second.balanceRequests.filter((body) =>
      body.includes('"limit":50')
    );
    expect(listReads).toHaveLength(1);
    expect(listReads[0]).toContain('"withCover":true');
    expect(
      second.balanceRequests.some((body) => body.includes("variantIds"))
    ).toBe(false);
    for (const batch of second.thumbBatches) {
      expect(batch.length).toBeLessThanOrEqual(MAX_IDS_PER_REQUEST);
    }
    // the capa of the two variants of one product is asked once; the fourth row may sit just below the fold
    const asked = second.thumbBatches.flat();
    expect(new Set(asked).size).toBe(asked.length);
    expect(asked).toContain(COVER_A);
    expect(
      asked.every((each) => each === COVER_A || each === COVER_MISSING)
    ).toBe(true);
  });
}

for (const refused of [401, 403, 429, 503]) {
  test(`Estoque: miniaturas recusadas com ${refused} deixam o marcador na mesma altura e não impedem abrir Receber, Contar e Baixar`, async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    const store = await installStore(page, {
      entries: STOCK_ENTRIES,
      mediaThumbs: true,
      thumbsStatus: () => refused,
    });
    await page.goto("/inventory");
    await expect(stockItems(page)).toHaveCount(STOCK_ENTRIES.length);
    await expect.poll(() => store.thumbBatches.length).toBeGreaterThan(0);
    const measured = await stockGeometry(page);
    expect(measured.every((row) => !row.photo && row.thumb?.h === 40)).toBe(
      true
    );
    const heights = measured.map((row) => row.height);
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(
      ONE_PIXEL
    );
    await expect(page.getByRole("alert")).toHaveCount(0);
    for (const action of ["Receber", "Contar", "Baixar"]) {
      // biome-ignore lint/performance/noAwaitInLoops: one panel at a time
      await page
        .getByRole("button", {
          name: new RegExp(`^${action} estoque de Calça sem imagem`),
        })
        .click();
      await expect(
        page.getByRole("button", { name: CLOSE_PANEL }).first()
      ).toBeVisible();
      await page.getByRole("button", { name: CLOSE_PANEL }).first().click();
    }
  });
}

test("Estoque: a foto é decoração, o nome do botão da linha não muda e a linha não tem foco extra", async ({
  page,
}) => {
  await page.setViewportSize({ height: 800, width: 1280 });
  await installStore(page, { entries: STOCK_ENTRIES, mediaThumbs: true });
  await page.goto("/inventory");
  await expect(page.locator('[data-thumbnail="photo"]')).toHaveCount(2);
  const first = stockItems(page).first();
  await expect(
    first.getByRole("button", {
      name: "Receber estoque de Camiseta com foto, Azul",
    })
  ).toBeVisible();
  const picture = first.locator("[data-thumbnail] img");
  await expect(picture).toHaveAttribute("alt", "");
  expect(
    await first
      .locator("[data-thumbnail]")
      .evaluate((node) => node.getAttribute("aria-hidden"))
  ).toBe("true");
  expect(
    await first
      .locator("[data-thumbnail]")
      .evaluate((node) => node.querySelectorAll("a, button, [tabindex]").length)
  ).toBe(0);
});

const MANY = 30;
const manyCover = (n: number) =>
  `0199c2d0-0000-7000-8000-0000000d${String(n).padStart(4, "0")}`;

test("Estoque: rolar uma lista longa pede só as linhas vistas, em lotes de até 5, uma capa nunca duas vezes", async ({
  page,
}) => {
  await page.setViewportSize({ height: 740, width: 360 });
  const many = Array.from({ length: MANY }, (_, index) => ({
    ...entry(index + 1, `Produto ${index + 1}`, "Azul", manyCover(index + 1)),
    movingAverageCost: "12.000000",
  }));
  const store = await installStore(page, { entries: many, mediaThumbs: true });
  await page.goto("/inventory");
  await expect(stockItems(page)).toHaveCount(MANY);
  await expect.poll(() => store.thumbBatches.length).toBeGreaterThan(0);
  await page.waitForLoadState("networkidle");
  const askedAtTop = store.thumbBatches.flat().length;
  expect(askedAtTop).toBeGreaterThan(0);
  expect(askedAtTop).toBeLessThan(MANY);

  // a jump to the end would never show the rows in between: the list is rolled row by row, top to bottom
  for (const row of await stockItems(page).all()) {
    // biome-ignore lint/performance/noAwaitInLoops: one row after the other, as a thumb rolls
    await row.scrollIntoViewIfNeeded();
  }
  await expect
    .poll(() => new Set(store.thumbBatches.flat()).size, { timeout: 20_000 })
    .toBe(MANY);
  const asked = store.thumbBatches.flat();
  expect(asked).toHaveLength(MANY);
  for (const batch of store.thumbBatches) {
    expect(batch.length).toBeLessThanOrEqual(MAX_IDS_PER_REQUEST);
  }
  expect(
    store.balanceRequests.every((body) => !body.includes("variantIds"))
  ).toBe(true);
});

test("Estoque a 320 px: com o selo Arquivado e nome longo a linha tem a mesma altura com a chave ligada e desligada", async ({
  page,
}) => {
  await page.setViewportSize({ height: 700, width: 320 });
  const long = [
    {
      ...entry(
        1,
        "Camiseta de algodão egípcio manga longa edição especial",
        "Azul",
        COVER_A
      ),
      movingAverageCost: "12.000000",
      productStatus: "archived",
    },
    {
      ...entry(2, "Calça de sarja com nome comprido sem imagem", "Azul", null),
      movingAverageCost: "12.000000",
    },
  ];
  const off = await installStore(page, { entries: long, mediaThumbs: false });
  await page.goto("/inventory");
  await expect(stockItems(page)).toHaveCount(long.length);
  const without = await stockGeometry(page);
  expect(off.thumbBatches).toEqual([]);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await installStore(page, { entries: long, mediaThumbs: true });
  await page.goto("/inventory");
  await expect(stockItems(page)).toHaveCount(long.length);
  await expect(page.locator('[data-thumbnail="photo"]')).toHaveCount(1);
  const withThumbs = await stockGeometry(page);
  withThumbs.forEach((row, index) => {
    expect(row.thumb?.h).toBe(40);
    expect(row.thumb?.w).toBe(40);
    expect(
      Math.abs(row.height - (without[index]?.height ?? 0))
    ).toBeLessThanOrEqual(ONE_PIXEL);
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
});
