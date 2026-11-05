/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

/**
 * The thumbnails store of a namespace in a real browser: what lands in IndexedDB, the budget of 10 MB, and the
 * IndexedDB read again after each way out (logout, revocation, emptying the queue, switching stores). The server is
 * simulated by the lab; the images are synthetic.
 */
const BUDGET = 10 * 1024 * 1024;
const okPattern = (label: string) => new RegExp(`^${label}: ok`);
const KEY_PATTERN = /^Chave: ok \(([0-9a-f]{32})\)$/;
const FIRST_STORE_ASSET = "0199c2d0-0000-7000-8000-000000000a01";
const SECOND_STORE_ASSET = "0199c2d0-0000-7000-8000-000000000a02";
const BROKEN_ASSET = "0199c2d0-0000-7000-8000-000000000a0f";

async function openLab(page: Page, user: string, organization = "org-1") {
  await page.goto("/offline-thumbnails-lab");
  await expect(
    page.getByRole("heading", { name: "Miniaturas no aparelho" })
  ).toBeVisible();
  await page.getByLabel("Usuário").fill(user);
  await page.getByLabel("Organização").fill(organization);
}

async function click(page: Page, name: string) {
  await page.getByRole("button", { exact: true, name }).click();
  await expect(page.getByTestId("message")).toHaveText(okPattern(name), {
    timeout: 15_000,
  });
}

async function namespaceKey(page: Page): Promise<string> {
  await click(page, "Chave");
  const text = (await page.getByTestId("message").textContent()) ?? "";
  const key = KEY_PATTERN.exec(text)?.[1];
  expect(key, text).toBeTruthy();
  return key ?? "";
}

/** The IndexedDB of the page, read directly: the databases of thumbnails and what is in one of them. */
function readThumbnails(page: Page, key: string) {
  return page.evaluate(async (namespace) => {
    const name = `polaris-thumbnails-${namespace}`;
    const databases = (await indexedDB.databases())
      .map((database) => database.name ?? "")
      .filter((database) => database.startsWith("polaris-thumbnails-"));
    if (!databases.includes(name)) {
      return { databases, exists: false, ids: [] as string[], total: 0 };
    }
    const records = await new Promise<
      { assetId: string; lastUsed: number; size: number }[]
    >((resolve, reject) => {
      const opening = indexedDB.open(name);
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const database = opening.result;
        const reading = database
          .transaction("thumbnails", "readonly")
          .objectStore("thumbnails")
          .getAll();
        reading.onerror = () => reject(reading.error);
        reading.onsuccess = () => {
          database.close();
          resolve(reading.result);
        };
      };
    });
    return {
      databases,
      exists: true,
      ids: records.map((record) => record.assetId).sort(),
      total: records.reduce((sum, record) => sum + record.size, 0),
    };
  }, key);
}

async function writeThumbnails(page: Page, count: number, sizeKb: number) {
  await page.getByLabel("Quantidade").fill(String(count));
  await page.getByLabel("Tamanho em KB").fill(String(sizeKb));
  await click(page, "Gravar");
}

test("acima de 10 MB o store descarta as menos usadas e fica no orçamento", async ({
  page,
}) => {
  await openLab(page, `user-${crypto.randomUUID()}`);
  const key = await namespaceKey(page);
  await writeThumbnails(page, 30, 400);
  const stored = await readThumbnails(page, key);
  expect(stored.total).toBeLessThanOrEqual(BUDGET);
  expect(stored.ids).toHaveLength(25);
  expect(stored.ids).not.toContain("lab-0");
  expect(stored.ids).toContain("lab-29");
});

for (const [way, button] of [
  ["a saída", "Sair"],
  ["a revogação do acesso", "Revogar"],
  ["o esvaziamento da fila (clearOutbox)", "Esvaziar fila"],
] as const) {
  test(`${way} apaga o store de miniaturas do namespace e só ele`, async ({
    page,
  }) => {
    const user = `user-${crypto.randomUUID()}`;
    await openLab(page, user, "org-2");
    const otherKey = await namespaceKey(page);
    await writeThumbnails(page, 2, 25);
    await page.getByLabel("Organização").fill("org-1");
    const key = await namespaceKey(page);
    await writeThumbnails(page, 3, 25);
    expect((await readThumbnails(page, key)).ids).toHaveLength(3);

    await click(page, button);

    const after = await readThumbnails(page, key);
    expect(after.exists).toBe(false);
    expect(after.databases).not.toContain(`polaris-thumbnails-${key}`);
    expect((await readThumbnails(page, otherKey)).ids).toHaveLength(2);
  });
}

test("a saída com a miniatura na tela fecha a conexão aberta e apaga o banco sem ficar bloqueada", async ({
  page,
}) => {
  await openLab(page, `user-${crypto.randomUUID()}`);
  const key = await namespaceKey(page);
  await click(page, "Mostrar");
  const first = page.locator(`[data-asset-id="${FIRST_STORE_ASSET}"] span`);
  await expect(first).toHaveAttribute("data-thumbnail", "photo");
  await expect
    .poll(async () => (await readThumbnails(page, key)).ids)
    .toEqual([FIRST_STORE_ASSET, BROKEN_ASSET]);

  await click(page, "Sair");

  expect((await readThumbnails(page, key)).exists).toBe(false);
});

test("trocar de loja apaga as miniaturas da anterior e nenhuma delas aparece na nova", async ({
  page,
}) => {
  await openLab(page, `user-${crypto.randomUUID()}`);
  const firstKey = await namespaceKey(page);
  await click(page, "Mostrar");
  const first = page.locator(`[data-asset-id="${FIRST_STORE_ASSET}"] span`);
  const second = page.locator(`[data-asset-id="${SECOND_STORE_ASSET}"] span`);
  await expect(first).toHaveAttribute("data-thumbnail", "photo");
  await expect(second).toHaveAttribute("data-thumbnail", "marker");
  await expect
    .poll(async () => (await readThumbnails(page, firstKey)).ids)
    .toEqual([FIRST_STORE_ASSET, BROKEN_ASSET]);

  await page.getByLabel("Organização").fill("org-2");
  const secondKey = await namespaceKey(page);
  await click(page, "Mostrar");

  await expect(second).toHaveAttribute("data-thumbnail", "photo");
  await expect(first).toHaveAttribute("data-thumbnail", "marker");
  await expect(first.locator("img")).toHaveCount(0);
  await expect
    .poll(async () => (await readThumbnails(page, firstKey)).exists)
    .toBe(false);
  expect((await readThumbnails(page, secondKey)).ids).toEqual([
    SECOND_STORE_ASSET,
    BROKEN_ASSET,
  ]);
});

test("bytes que não são imagem deixam o marcador, sem imagem quebrada na caixa", async ({
  page,
}) => {
  await openLab(page, `user-${crypto.randomUUID()}`);
  await click(page, "Mostrar");
  const first = page.locator(`[data-asset-id="${FIRST_STORE_ASSET}"] span`);
  const broken = page.locator(`[data-asset-id="${BROKEN_ASSET}"] span`);
  await expect(first).toHaveAttribute("data-thumbnail", "photo");
  await expect(broken.locator("img")).toHaveCount(0);
  await expect(broken).toHaveAttribute("data-thumbnail", "marker");
  await expect(broken).toHaveText("CA");
  const [firstBox, brokenBox] = await Promise.all(
    [first, broken].map((box) => box.boundingBox())
  );
  expect([brokenBox?.width, brokenBox?.height]).toEqual([
    firstBox?.width,
    firstBox?.height,
  ]);
});

test("sem cópia offline a miniatura aparece e nada vai ao IndexedDB", async ({
  page,
}) => {
  await openLab(page, `user-${crypto.randomUUID()}`);
  const key = await namespaceKey(page);
  await page
    .getByRole("button", { exact: true, name: "Mostrar sem cópia" })
    .click();
  const first = page.locator(`[data-asset-id="${FIRST_STORE_ASSET}"] span`);
  await expect(first).toHaveAttribute("data-thumbnail", "photo");
  const stored = await readThumbnails(page, key);
  expect(stored.databases).toEqual([]);
});

test("IndexedDB negado: a miniatura aparece da memória e a tela segue", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function open(
      this: IDBFactory,
      name: string,
      version?: number
    ) {
      if (name.startsWith("polaris-thumbnails-")) {
        throw new DOMException("negado", "SecurityError");
      }
      return original.call(this, name, version);
    };
  });
  await openLab(page, `user-${crypto.randomUUID()}`);
  await click(page, "Mostrar");
  const first = page.locator(`[data-asset-id="${FIRST_STORE_ASSET}"] span`);
  await expect(first).toHaveAttribute("data-thumbnail", "photo");
  await expect(page.getByRole("button", { name: "Sair" })).toBeEnabled();
});
