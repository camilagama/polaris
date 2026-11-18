/// <reference lib="dom" />
import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { mediaAsset, mediaListBody, solidPng } from "./media-fixtures";
import { serveHealth, WORKER_MARK } from "./worker-mark";

/**
 * The warning that the Free plan's limit is close, where a store registers: the end of Produtos, under the buttons of
 * the variants form and under "Enviar imagem". The real route, with the API answered by the test: the numbers are the
 * plan read's, the line goes with the owner of a Free store only, and it is never next to the refusal.
 */
const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const id = (n: number) => `0199c2d0-0000-7000-8000-0000000000${n}`;
const NOW = "2026-10-14T12:00:00.000Z";
const DAY = 24 * 60 * 60 * 1000;
const ACCESS_ENDS_AT = new Date(Date.parse(NOW) + 40 * DAY).toISOString();
const SUBSCRIPTION = "/configuracoes?aba=assinatura";
const SUBSCRIPTION_ADDRESS = /\/configuracoes\?aba=assinatura$/;
const PRODUCTS_ADDRESS = /\/products$/;
const NEAR_LIMIT = "[data-near-limit]";
const FREEABLE = "[data-near-limit-freeable]";
/** The import sends one call per row, spaced by `IMPORT_CALL_INTERVAL_MS`; four rows took ~21 s in the run, so the wait and the test keep room over that. */
const IMPORT_ANSWER_TIMEOUT = 60_000;
const IMPORT_TEST_TIMEOUT = 100_000;

const rpc = (json: unknown, status = 200) => ({
  body: JSON.stringify({ json, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
  status,
});
const limitRefusal = rpc(
  {
    code: "CONFLICT",
    data: { reason: "entitlement_limit_reached" },
    defined: false,
    message: "Conflict",
    status: 409,
  },
  409
);

interface Use {
  freeable?: { products: number; variants: number };
  images: number;
  variants: number;
}

const planOf = (state: string, use: Use) => ({
  accessEndsAt: state === "free" ? null : ACCESS_ENDS_AT,
  cycleMonths: state === "free" ? null : 1,
  kept: { historyMonths: 3, products: 50, sales: 47 },
  limits: { goals: 1, images: 50, variants: 50 },
  method: state === "free" ? null : "card",
  nextCharge: null,
  offer: { methods: ["card"], prices: [{ amount: "24.90", cycleMonths: 1 }] },
  recovery: null,
  refund: null,
  refundPending: false,
  refundWindowEndedOn: null,
  renewalCancelled: false,
  resubscribeFrom: null,
  state,
  trialAvailable: false,
  usage: { goals: 0, ...use },
});

type Handler = (route: Route) => Promise<void>;

interface Store {
  answers?: Record<string, Handler>;
  /** What the plan read answers now; read at each call, so a test changes it between two reads. */
  plan?: () => Promise<Handler | null> | Handler | null;
  reads?: { plan: number };
  role?: string;
  state?: string;
  use: Use;
}

const reply =
  (json: unknown): Handler =>
  (route) =>
    route.fulfill(rpc(json));

const shirt = {
  archivedAt: null,
  categoryId: null,
  createdAt: NOW,
  deletedAt: null,
  description: null,
  id: id(21),
  name: "Camiseta do teste",
  organizationId: ORGANIZATION.id,
  status: "active",
  updatedAt: NOW,
  version: 1,
};

const UNCONFIGURED = {
  configured: false,
  optionValues: [],
  productId: id(21),
  productVersion: 1,
  variants: [
    {
      id: id(31),
      isDefault: true,
      listPrice: null,
      sku: null,
      values: [],
      version: 1,
    },
  ],
};

async function openApp(page: Page, path: string, store: Store) {
  await page.clock.setFixedTime(new Date(NOW));
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      body: JSON.stringify({ session: { id: "s" }, user: { id: "u" } }),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    })
  );
  await serveHealth(page);
  await page.route("**/rpc/**", async (route) => {
    const procedure = new URL(route.request().url()).pathname.replace(
      "/rpc/",
      ""
    );
    if (procedure === "organization/listMine") {
      return route.fulfill(
        rpc({
          billingSelfService: true,
          organizations: [{ ...ORGANIZATION, role: store.role ?? "owner" }],
        })
      );
    }
    if (procedure === "billing/readPlan") {
      if (store.reads) {
        store.reads.plan += 1;
      }
      if (store.state === "unread") {
        return route.abort("internetdisconnected");
      }
      const custom = await store.plan?.();
      return custom
        ? custom(route)
        : route.fulfill(rpc(planOf(store.state ?? "free", store.use)));
    }
    const handler = store.answers?.[procedure];
    return handler ? handler(route) : route.abort("internetdisconnected");
  });
  await page.goto(path);
  await page.evaluate(() => {
    (window as unknown as { polarisNoLoad: boolean }).polarisNoLoad = true;
  });
}

const stillTheSamePage = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { polarisNoLoad?: boolean }).polarisNoLoad === true
  );

const productAnswers = (): Record<string, Handler> => ({
  "category/list": reply({ categories: [] }),
  "product/configureVariants": (route) => route.fulfill(limitRefusal),
  "product/getVariants": reply(UNCONFIGURED),
  "product/list": reply({ products: [shirt] }),
});

const menuOf = (page: Page) =>
  page.getByRole("button", { name: "Mais ações para Camiseta do teste" });
const line = (page: Page) => page.locator(NEAR_LIMIT);
/** Inside the product dialog: the page behind it keeps its own line, out of the accessibility tree. */
const dialogLine = (page: Page) => page.getByRole("dialog").locator(NEAR_LIMIT);

async function openVariants(page: Page) {
  await menuOf(page).click();
  await page.getByRole("menuitem", { name: "Variantes" }).click();
  await page.getByRole("checkbox", { name: "Cor" }).click();
  await page.getByLabel("Valores de Cor").fill("Azul\nPreta");
}

const top = async (locator: ReturnType<Page["locator"]>) =>
  (await locator.boundingBox())?.y ?? Number.NaN;

const TAB_PRESSES = 12;
const PRO_LINK_STOP = "A:Conhecer o Pro";

/**
 * Starts from the file field of the images dialog and presses Tab `presses` times, reporting what holds focus after each
 * press: enough presses to go past the line's link and the controls around it.
 */
async function tabStops(page: Page, presses: number) {
  await page.getByLabel("Escolher imagem").focus();
  const stops: string[] = [];
  for (let press = 0; press < presses; press += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each Tab moves from the control the one before left focused
    await page.keyboard.press("Tab");
    stops.push(
      await page.evaluate(() => {
        const active = document.activeElement;
        const named =
          active instanceof HTMLAnchorElement ||
          active instanceof HTMLButtonElement;
        return `${active?.tagName ?? "none"}:${named ? (active.textContent?.trim() ?? "") : ""}`;
      })
    );
  }
  return stops;
}

test.describe("Produtos", () => {
  test("44 de 50 não mostra nada; 45 e 49 dizem o uso; 50 diz que chegou; a linha fica depois do último produto", async ({
    page,
  }) => {
    const store: Store = {
      answers: productAnswers(),
      use: { images: 0, variants: 44 },
    };
    await openApp(page, "/products", store);
    await expect(page.getByText("Camiseta do teste").first()).toBeVisible();
    await expect(line(page)).toHaveCount(0);

    for (const [used, text] of [
      [45, "Você usa 45 de 50 variantes no plano Free."],
      [49, "Você usa 49 de 50 variantes no plano Free."],
      [50, "Você chegou ao limite de 50 variantes do plano Free."],
      [51, "Você chegou ao limite de 50 variantes do plano Free."],
    ] as const) {
      store.use = { images: 0, variants: used };
      // biome-ignore lint/performance/noAwaitInLoops: one reading after the other, on the same page
      await page.reload();
      await expect(line(page)).toContainText(text);
      await expect(line(page)).toContainText("Conhecer o Pro");
      expect(await line(page).getAttribute("role")).toBeNull();
      const row = page.getByText("Camiseta do teste").first();
      expect(await top(line(page))).toBeGreaterThan(await top(row));
    }
  });

  test("com o limite do Pro na leitura, 'No Pro: até 2.000 variantes.' vem antes do link", async ({
    page,
  }) => {
    await openApp(page, "/products", {
      answers: productAnswers(),
      plan: () => (route) =>
        route.fulfill(
          rpc({
            ...planOf("free", { images: 0, variants: 47 }),
            proLimits: { goals: 3, images: 5000, variants: 2000 },
          })
        ),
      use: { images: 0, variants: 47 },
    });
    await expect(line(page)).toContainText(
      "Você usa 47 de 50 variantes no plano Free. No Pro: até 2.000 variantes. Conhecer o Pro"
    );
  });

  test("a leitura atrasada não move a lista nem o rodapé: a linha entra no fim", async ({
    page,
  }) => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await openApp(page, "/products", {
      answers: productAnswers(),
      plan: async () => {
        await held;
        return null;
      },
      use: { images: 0, variants: 47 },
    });
    const row = page.getByText("Camiseta do teste").first();
    const imports = page.getByRole("button", { name: "Importar planilha" });
    await expect(row).toBeVisible();
    await expect(line(page)).toHaveCount(0);
    const before = [await top(row), await top(imports.last())];
    release();
    await expect(line(page)).toBeVisible();
    expect([await top(row), await top(imports.last())]).toEqual(before);
  });

  test("só o dono de loja Free: Pro, quem não gerencia a cobrança e plano não lido não veem a linha", async ({
    page,
  }) => {
    for (const store of [
      { role: "owner", state: "active" },
      { role: "cashier", state: "free" },
      { role: "owner", state: "unread" },
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one store after the other, on the same page
      await page.unrouteAll({ behavior: "ignoreErrors" });
      const reads = { plan: 0 };
      await openApp(page, "/products", {
        ...store,
        answers: productAnswers(),
        reads,
        use: { images: 50, variants: 50 },
      });
      await expect(page.getByText("Camiseta do teste").first()).toBeVisible();
      await expect(line(page)).toHaveCount(0);
      if (store.role === "cashier") {
        expect(reads.plan).toBe(0);
      }
    }
  });

  test("sem conexão a linha some, sem número velho, e volta com a conexão", async ({
    context,
    page,
  }) => {
    await openApp(page, "/products", {
      answers: productAnswers(),
      use: { images: 0, variants: 47 },
    });
    await expect(line(page)).toBeVisible();
    await context.setOffline(true);
    await expect(line(page)).toHaveCount(0);
    await context.setOffline(false);
    await expect(line(page)).toContainText("47 de 50 variantes");
  });

  test("sem conexão a página fica do mesmo tamanho que a de uma loja sem linha: não sobra vão onde ela estava", async ({
    context,
    page,
  }) => {
    const offlinePage = async (variants: number) => {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await context.setOffline(false);
      await openApp(page, "/products", {
        answers: productAnswers(),
        use: { images: 0, variants },
      });
      await expect(page.getByText("Camiseta do teste").first()).toBeVisible();
      const root = page.locator(".products-page");
      const online = await root.boundingBox();
      await context.setOffline(true);
      await expect(
        page.getByText("Importar planilha precisa de conexão.")
      ).toBeVisible();
      await expect(line(page)).toHaveCount(0);
      return { offline: await root.boundingBox(), online };
    };
    const withoutLine = await offlinePage(44);
    const withLine = await offlinePage(47);
    expect(withLine.online?.height).toBeGreaterThan(
      withoutLine.online?.height ?? Number.NaN
    );
    expect(withLine.offline).toEqual(withoutLine.offline);
  });

  test("a recusa do servidor ao cadastrar tira a linha: o aviso e a recusa não aparecem juntos", async ({
    page,
  }) => {
    await openApp(page, "/products", {
      answers: {
        ...productAnswers(),
        "product/create": (route) => route.fulfill(limitRefusal),
      },
      use: { images: 0, variants: 50 },
    });
    await expect(line(page)).toContainText(
      "Você chegou ao limite de 50 variantes do plano Free."
    );
    await page.getByRole("button", { name: "Novo produto" }).first().click();
    await page.getByLabel("Nome do produto").fill("Bolsa de couro");
    await page.getByRole("button", { name: "Cadastrar produto" }).click();
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
      "Seu plano chegou ao limite de variantes. Nada foi cadastrado."
    );
    await expect(line(page)).toHaveCount(0);
  });

  test("a recusa das variantes fica no formulário: a página de Produtos não ganha erro e mantém a sua linha", async ({
    page,
  }) => {
    await openApp(page, "/products", {
      answers: productAnswers(),
      use: { images: 0, variants: 50 },
    });
    await openVariants(page);
    await page.getByRole("button", { name: "Adicionar combinação" }).click();
    await page.getByRole("combobox", { exact: true, name: "Cor" }).click();
    await page.getByRole("option", { exact: true, name: "Azul" }).click();
    await page.getByRole("button", { name: "Salvar variantes" }).click();
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
      "Seu plano chegou ao limite de variantes. Nada foi alterado."
    );
    await expect(line(page)).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(line(page)).toContainText(
      "Você chegou ao limite de 50 variantes do plano Free."
    );
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("'Conhecer o Pro' leva à Assinatura sem recarregar e o rascunho do produto está lá na volta", async ({
    page,
  }) => {
    await openApp(page, "/products", {
      answers: productAnswers(),
      use: { images: 0, variants: 47 },
    });
    await page.getByRole("button", { name: "Novo produto" }).first().click();
    await page.getByLabel("Nome do produto").fill("Bolsa de couro");
    await page.keyboard.press("Escape");
    await page.getByRole("link", { name: "Conhecer o Pro" }).click();
    await expect(page).toHaveURL(SUBSCRIPTION_ADDRESS);
    expect(await stillTheSamePage(page)).toBe(true);
    await page.goBack();
    await expect(page).toHaveURL(PRODUCTS_ADDRESS);
    await page.getByRole("button", { name: "Novo produto" }).first().click();
    await expect(page.getByLabel("Nome do produto")).toHaveValue(
      "Bolsa de couro"
    );
  });
});

test.describe("formulário de variantes", () => {
  test("a linha vem abaixo dos botões do formulário", async ({ page }) => {
    await openApp(page, "/products", {
      answers: productAnswers(),
      use: { images: 0, variants: 47 },
    });
    await openVariants(page);
    await expect(dialogLine(page)).toContainText("Você usa 47 de 50 variantes");
    const save = page.getByRole("button", { name: "Salvar variantes" });
    expect(await top(dialogLine(page))).toBeGreaterThan(await top(save));
  });

  test("a leitura atrasada não move o botão nem o campo que a pessoa toca", async ({
    page,
  }) => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await openApp(page, "/products", {
      answers: productAnswers(),
      plan: async () => {
        await held;
        return null;
      },
      use: { images: 0, variants: 47 },
    });
    await menuOf(page).click();
    await page.getByRole("menuitem", { name: "Variantes" }).click();
    await page.getByRole("checkbox", { name: "Cor" }).click();
    const values = page.getByLabel("Valores de Cor");
    const save = page.getByRole("button", { name: "Salvar variantes" });
    await expect(values).toBeVisible();
    await expect(dialogLine(page)).toHaveCount(0);
    const before = [await top(values), await top(save)];
    release();
    await expect(dialogLine(page)).toBeVisible();
    expect([await top(values), await top(save)]).toEqual(before);
  });

  test("a recusa do servidor tira a linha: o aviso e a recusa não aparecem juntos", async ({
    page,
  }) => {
    await openApp(page, "/products", {
      answers: productAnswers(),
      use: { images: 0, variants: 50 },
    });
    await openVariants(page);
    await page.getByRole("button", { name: "Adicionar combinação" }).click();
    await page.getByRole("combobox", { exact: true, name: "Cor" }).click();
    await page.getByRole("option", { exact: true, name: "Azul" }).click();
    await expect(dialogLine(page)).toContainText(
      "chegou ao limite de 50 variantes"
    );
    await page.getByRole("button", { name: "Salvar variantes" }).click();
    const alert = page.getByRole("dialog").getByRole("alert");
    await expect(alert).toContainText(
      "Seu plano chegou ao limite de variantes. Nada foi alterado."
    );
    await expect(alert).toContainText("Você usa 50 de 50 variantes");
    await expect(dialogLine(page)).toHaveCount(0);
    await expect(page.getByLabel("Valores de Cor")).toHaveValue("Azul\nPreta");
  });

  test("sem conexão não há linha no formulário, e o quadro do diálogo não muda", async ({
    context,
    page,
  }) => {
    await openApp(page, "/products", {
      answers: productAnswers(),
      use: { images: 0, variants: 47 },
    });
    await openVariants(page);
    await expect(dialogLine(page)).toContainText("Você usa 47 de 50 variantes");
    const frame = page.getByRole("dialog");
    const before = await frame.boundingBox();
    await context.setOffline(true);
    await expect(dialogLine(page)).toHaveCount(0);
    expect(await frame.boundingBox()).toEqual(before);
    await context.setOffline(false);
    await expect(dialogLine(page)).toContainText("Você usa 47 de 50 variantes");
    expect(await frame.boundingBox()).toEqual(before);
  });

  test("'Conhecer o Pro' fecha o diálogo guardando as variantes, sem recarregar", async ({
    page,
  }) => {
    await openApp(page, "/products", {
      answers: productAnswers(),
      use: { images: 0, variants: 47 },
    });
    await openVariants(page);
    await page.getByRole("link", { name: "Conhecer o Pro" }).click();
    await expect(page).toHaveURL(SUBSCRIPTION_ADDRESS);
    expect(await stillTheSamePage(page)).toBe(true);
    await page.goBack();
    await expect(page).toHaveURL(PRODUCTS_ADDRESS);
    await menuOf(page).click();
    await page.getByRole("menuitem", { name: "Variantes" }).click();
    await expect(page.getByLabel("Valores de Cor")).toHaveValue("Azul\nPreta");
    await expect(
      page.getByRole("link", { name: "Conhecer o Pro" })
    ).toHaveAttribute("href", SUBSCRIPTION);
  });
});

const savedConfiguration = {
  configuration: {
    ...UNCONFIGURED,
    configured: true,
    productVersion: 2,
    variants: [
      {
        id: id(32),
        isDefault: false,
        listPrice: null,
        sku: null,
        values: [{ optionName: "Cor", optionValueName: "Azul" }],
        version: 1,
      },
    ],
  },
  product: { ...shirt, version: 2 },
};

test.describe("o número acompanha o que a pessoa grava", () => {
  /** The page behind the product dialog comes first in the document; the dialog's own line is the last. */
  const behindTheDialog = (page: Page) => line(page).first();

  test("salvar variantes lê o uso de novo no diálogo e na lista de Produtos, sem recarregar", async ({
    page,
  }) => {
    const store: Store = {
      answers: {
        ...productAnswers(),
        "product/configureVariants": (route) => {
          store.use = { images: 0, variants: 48 };
          return route.fulfill(rpc(savedConfiguration));
        },
      },
      use: { images: 0, variants: 47 },
    };
    await openApp(page, "/products", store);
    await openVariants(page);
    await expect(dialogLine(page)).toContainText("Você usa 47 de 50 variantes");
    await expect(behindTheDialog(page)).toContainText(
      "Você usa 47 de 50 variantes"
    );
    await page.getByRole("button", { name: "Adicionar combinação" }).click();
    await page.getByRole("combobox", { exact: true, name: "Cor" }).click();
    await page.getByRole("option", { exact: true, name: "Azul" }).click();
    await page.getByRole("button", { name: "Salvar variantes" }).click();
    await expect(behindTheDialog(page)).toContainText(
      "Você usa 48 de 50 variantes"
    );
    // the form gives way to the saved variants: the dialog has no line left, the list's is the one that moved
    await expect(
      page.getByText("Variantes configuradas e salvas.")
    ).toBeVisible();
    await expect(dialogLine(page)).toHaveCount(0);
    expect(await stillTheSamePage(page)).toBe(true);
  });

  test("cadastrar um produto lê o uso de novo na linha de Produtos", async ({
    page,
  }) => {
    const store: Store = {
      answers: {
        ...productAnswers(),
        "product/create": (route) => {
          store.use = { images: 0, variants: 48 };
          return route.fulfill(rpc(shirt));
        },
      },
      use: { images: 0, variants: 47 },
    };
    await openApp(page, "/products", store);
    await expect(line(page)).toContainText("Você usa 47 de 50 variantes");
    await page.getByRole("button", { name: "Novo produto" }).first().click();
    await page.getByLabel("Nome do produto").fill("Camiseta do teste");
    await page.getByRole("button", { name: "Cadastrar produto" }).click();
    await expect(
      page.getByText("Produto “Camiseta do teste” cadastrado.")
    ).toBeVisible();
    await expect(line(page)).toContainText("Você usa 48 de 50 variantes");
    expect(await stillTheSamePage(page)).toBe(true);
  });

  test("importar uma planilha lê o uso de novo: de 46 a 50 a linha passa a dizer que chegou ao limite", async ({
    page,
  }) => {
    test.setTimeout(IMPORT_TEST_TIMEOUT);
    const store: Store = {
      answers: {
        ...productAnswers(),
        "product/importBatch": (route) => {
          const body = route.request().postDataJSON() as {
            json: { rows: { productId: string; rowNumber: number }[] };
          };
          store.use = { images: 0, variants: store.use.variants + 1 };
          return route.fulfill(
            rpc({
              results: body.json.rows.map((row) => ({
                productId: row.productId,
                rowNumber: row.rowNumber,
                status: "created",
              })),
            })
          );
        },
        "product/namesExisting": reply({ names: [] }),
      },
      use: { images: 0, variants: 46 },
    };
    await openApp(page, "/products", store);
    await expect(line(page)).toContainText("Você usa 46 de 50 variantes");
    await page
      .getByRole("button", { name: "Importar planilha" })
      .first()
      .click();
    const dialog = page.getByRole("dialog", { name: "Importar planilha" });
    await dialog.locator('input[type="file"]').setInputFiles({
      buffer: Buffer.from(
        "Nome;Preço de tabela\r\nBoné;10\r\nMeia;12\r\nCinto;30\r\nBolsa;80\r\n",
        "utf8"
      ),
      mimeType: "text/csv",
      name: "produtos.csv",
    });
    await dialog.getByRole("button", { name: "Ver a prévia" }).click();
    await dialog.getByRole("button", { name: "Importar 4 produtos" }).click();
    await expect(
      dialog.getByRole("status").filter({ hasText: "Importamos 4 produtos." })
    ).toBeVisible({ timeout: IMPORT_ANSWER_TIMEOUT });
    await expect(line(page)).toContainText(
      "Você chegou ao limite de 50 variantes do plano Free."
    );
    expect(await stillTheSamePage(page)).toBe(true);
  });
});

test.describe("painel de imagens", () => {
  interface ImageMedia {
    /** The answer to the next upload, in place of the success. */
    uploadRefusal?: { body: unknown; status: number };
  }

  async function openImages(
    page: Page,
    store: Store,
    stored: number,
    options: ImageMedia = {}
  ) {
    let uploads = 0;
    /** How many images the list holds now; a removal lowers it. */
    const media = { stored, uploadRefusal: options.uploadRefusal };
    await page.route("**/api/products/*/media**", (route) => {
      const method = route.request().method();
      if (method === "POST") {
        uploads += 1;
        if (media.uploadRefusal) {
          return route.fulfill({
            body: JSON.stringify(media.uploadRefusal.body),
            contentType: "application/json",
            headers: { ...WORKER_MARK },
            status: media.uploadRefusal.status,
          });
        }
        return route.fulfill({
          body: JSON.stringify({
            asset: mediaAsset(0),
            replayed: false,
            requestId: id(90),
          }),
          contentType: "application/json",
          headers: { ...WORKER_MARK },
        });
      }
      if (method === "DELETE") {
        media.stored -= 1;
        store.use = { ...store.use, images: store.use.images - 1 };
        return route.fulfill({
          body: JSON.stringify({ removed: true, requestId: id(91) }),
          contentType: "application/json",
          headers: { ...WORKER_MARK },
        });
      }
      return route.fulfill({
        body: mediaListBody(media.stored),
        contentType: "application/json",
        headers: { ...WORKER_MARK },
      });
    });
    // the same object: a test changes `use` between two reads
    store.answers = {
      ...productAnswers(),
      "product/getVariants": reply({ ...UNCONFIGURED, configured: true }),
    };
    await openApp(page, "/products", store);
    await menuOf(page).click();
    await page.getByRole("menuitem", { name: "Imagens" }).click();
    return { uploads: () => uploads };
  }

  const upload = async (page: Page) => {
    await page.getByLabel("Escolher imagem").setInputFiles({
      buffer: solidPng(480, 320),
      mimeType: "image/png",
      name: "foto.png",
    });
    await page.getByRole("button", { name: "Enviar imagem" }).click();
  };

  test("a linha de imagens vem abaixo de 'Enviar imagem' e o uso novo aparece depois de enviar, sem recarregar", async ({
    page,
  }) => {
    const store: Store = { use: { images: 47, variants: 0 } };
    const sent = await openImages(page, store, 0);
    await expect(dialogLine(page)).toContainText("Você usa 47 de 50 imagens");
    const send = page.getByRole("button", { name: "Enviar imagem" });
    expect(await top(dialogLine(page))).toBeGreaterThan(await top(send));
    store.use = { images: 48, variants: 0 };
    await upload(page);
    await expect(page.getByText("Imagem adicionada ao produto.")).toBeVisible();
    await expect(dialogLine(page)).toContainText("Você usa 48 de 50 imagens");
    expect(sent.uploads()).toBe(1);
    expect(await stillTheSamePage(page)).toBe(true);
  });

  test("a 50 de 50 diz que chegou; a 44 nada", async ({ page }) => {
    await openImages(page, { use: { images: 44, variants: 0 } }, 0);
    await expect(
      page.getByRole("button", { name: "Enviar imagem" })
    ).toBeVisible();
    await expect(dialogLine(page)).toHaveCount(0);
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await openImages(page, { use: { images: 50, variants: 0 } }, 0);
    await expect(dialogLine(page)).toContainText(
      "Você chegou ao limite de 50 imagens do plano Free."
    );
  });

  test("sem conexão não há linha no painel de imagens, e o botão não muda de lugar no diálogo", async ({
    context,
    page,
  }) => {
    const store: Store = { use: { images: 47, variants: 0 } };
    await openImages(page, store, 0);
    await expect(dialogLine(page)).toBeVisible();
    const send = page.getByRole("button", { name: "Enviar imagem" });
    const frame = page.getByRole("dialog");
    const inTheDialog = async () => (await top(send)) - (await top(frame));
    const before = await inTheDialog();
    const frameTop = await top(frame);
    await context.setOffline(true);
    await expect(dialogLine(page)).toHaveCount(0);
    expect(await inTheDialog()).toBeCloseTo(before, 1);
    expect(await top(frame)).toBeCloseTo(frameTop, 1);
    let release: () => void = () => undefined;
    const reading = new Promise<void>((resolve) => {
      release = resolve;
    });
    store.plan = async () => {
      await reading;
      return null;
    };
    await context.setOffline(false);
    await expect(dialogLine(page)).toHaveCount(0);
    expect(await top(frame)).toBeCloseTo(frameTop, 1);
    release();
    await expect(dialogLine(page)).toContainText("Você usa 47 de 50 imagens");
    expect(await inTheDialog()).toBeCloseTo(before, 1);
    expect(await top(frame)).toBeCloseTo(frameTop, 1);
  });

  test("o link de 'Conhecer o Pro' do vão não recebe foco no Tab; o da linha à mostra recebe", async ({
    context,
    page,
  }) => {
    await openImages(page, { use: { images: 47, variants: 0 } }, 0);
    await expect(dialogLine(page)).toContainText("Você usa 47 de 50 imagens");
    const heldLink = page
      .getByRole("dialog")
      .locator('[aria-hidden="true"] a[href$="aba=assinatura"]');
    await expect(heldLink).toHaveCount(0);

    const shown = await tabStops(page, TAB_PRESSES);
    expect(shown[0]).toBe(PRO_LINK_STOP);

    await context.setOffline(true);
    await expect(dialogLine(page)).toHaveCount(0);
    await expect(heldLink).toHaveCount(1);
    const held = await tabStops(page, TAB_PRESSES);
    expect(held).not.toContain(PRO_LINK_STOP);
    expect(held[0]).toBe(shown[1]);
  });

  test("sem linha antes de ficar offline, o quadro do diálogo não ganha espaço vazio", async ({
    context,
    page,
  }) => {
    await openImages(page, { use: { images: 44, variants: 0 } }, 0);
    const send = page.getByRole("button", { name: "Enviar imagem" });
    await expect(send).toBeVisible();
    await expect(dialogLine(page)).toHaveCount(0);
    const frame = page.getByRole("dialog");
    const before = await frame.boundingBox();
    await context.setOffline(true);
    await page.waitForFunction(() => !navigator.onLine);
    await page.evaluate(
      () =>
        new Promise<void>((done) => {
          requestAnimationFrame(() => requestAnimationFrame(() => done()));
        })
    );
    expect(await frame.boundingBox()).toEqual(before);
  });

  test("a recusa do servidor ao enviar tira a linha: o aviso e a recusa não aparecem juntos", async ({
    page,
  }) => {
    const media: ImageMedia = {
      uploadRefusal: {
        body: { error: { code: "entitlement_limit_reached" } },
        status: 409,
      },
    };
    await openImages(page, { use: { images: 50, variants: 0 } }, 0, media);
    await expect(dialogLine(page)).toContainText(
      "Você chegou ao limite de 50 imagens do plano Free."
    );
    await upload(page);
    const alert = page.getByRole("dialog").getByRole("alert");
    await expect(alert).toContainText(
      "Seu plano chegou ao limite de imagens da loja."
    );
    await expect(dialogLine(page)).toHaveCount(0);
  });

  test("remover uma imagem lê o uso de novo: de 48 a 47, sem recarregar", async ({
    page,
  }) => {
    const store: Store = { use: { images: 48, variants: 0 } };
    await openImages(page, store, 2);
    await expect(dialogLine(page)).toContainText("Você usa 48 de 50 imagens");
    await page.getByRole("button", { name: "Remover imagem 2" }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Remover imagem" })
      .click();
    await expect(
      page.getByText(
        "Imagem 2 removida do produto. Um lugar foi liberado no plano."
      )
    ).toBeVisible();
    await expect(dialogLine(page)).toContainText("Você usa 47 de 50 imagens");
    expect(await stillTheSamePage(page)).toBe(true);
  });
});

const jacket = {
  ...shirt,
  archivedAt: NOW,
  id: id(22),
  name: "Jaqueta de inverno",
  status: "archived",
  version: 2,
};

/** The list by status as the server answers it, from what `catalog` holds now. */
const listByStatus =
  (catalog: { active: unknown[]; archived: unknown[] }): Handler =>
  (route) => {
    const { status } = (
      route.request().postDataJSON() as {
        json: { status: string };
      }
    ).json;
    return route.fulfill(
      rpc({
        products: status === "archived" ? catalog.archived : catalog.active,
      })
    );
  };

const freeableLine = (page: Page) => page.locator(FREEABLE);
const dialogFreeable = (page: Page) =>
  page.getByRole("dialog").locator(FREEABLE);
const archivedTab = (page: Page) =>
  page.getByRole("tab", { name: "Arquivados" });

const freeableStore = (
  products: number,
  variants = 47
): Store & { catalog: { active: unknown[]; archived: unknown[] } } => {
  const catalog = { active: [shirt], archived: [jacket] };
  return {
    answers: { ...productAnswers(), "product/list": listByStatus(catalog) },
    catalog,
    use: { freeable: { products, variants: products }, images: 0, variants },
  };
};

test.describe("a segunda linha: arquivados sem estoque", () => {
  test("com 3 arquivados sem estoque: um parágrafo à parte, depois do aviso, com o link 'Ver arquivados'", async ({
    page,
  }) => {
    await openApp(page, "/products", freeableStore(3));
    await expect(line(page)).toContainText("Você usa 47 de 50 variantes");
    await expect(freeableLine(page)).toHaveText(
      "Você tem 3 produtos arquivados sem estoque. Excluir libera vaga. Ver arquivados"
    );
    expect(await freeableLine(page).getAttribute("role")).toBeNull();
    expect(await top(freeableLine(page))).toBeGreaterThan(
      await top(line(page))
    );
    await expect(
      freeableLine(page).getByRole("link", { name: "Ver arquivados" })
    ).toHaveAttribute("href", "/products?arquivados=1");
  });

  test("com 1 o texto vai ao singular; com 0 ou sem o campo, nenhuma segunda linha; abaixo de 90%, nada", async ({
    page,
  }) => {
    await openApp(page, "/products", freeableStore(1));
    await expect(freeableLine(page)).toContainText(
      "Você tem 1 produto arquivado sem estoque. Excluir libera vaga."
    );
    for (const use of [
      { freeable: { products: 0, variants: 0 }, images: 0, variants: 47 },
      { images: 0, variants: 47 },
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one store after the other, on the same page
      await page.unrouteAll({ behavior: "ignoreErrors" });
      const store = freeableStore(1);
      await openApp(page, "/products", { ...store, use });
      await expect(line(page)).toContainText("Você usa 47 de 50 variantes");
      await expect(freeableLine(page)).toHaveCount(0);
    }
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await openApp(page, "/products", {
      ...freeableStore(3),
      use: { freeable: { products: 3, variants: 3 }, images: 0, variants: 44 },
    });
    await expect(page.getByText("Camiseta do teste").first()).toBeVisible();
    await expect(line(page)).toHaveCount(0);
    await expect(freeableLine(page)).toHaveCount(0);
  });

  test("só o dono de loja Free: Pro e quem não gerencia a cobrança não veem a segunda linha", async ({
    page,
  }) => {
    for (const store of [
      { role: "owner", state: "active" },
      { role: "cashier", state: "free" },
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one store after the other, on the same page
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await openApp(page, "/products", { ...freeableStore(3), ...store });
      await expect(page.getByText("Camiseta do teste").first()).toBeVisible();
      await expect(freeableLine(page)).toHaveCount(0);
    }
  });

  test("'Ver arquivados' abre a aba Arquivados sem recarregar, com o foco na aba, e a linha fica sem o link", async ({
    page,
  }) => {
    await openApp(page, "/products", freeableStore(3));
    await page.getByRole("link", { name: "Ver arquivados" }).click();
    await expect(archivedTab(page)).toHaveAttribute("aria-selected", "true");
    await expect(archivedTab(page)).toBeFocused();
    await expect(page.getByText("Jaqueta de inverno").first()).toBeVisible();
    expect(await stillTheSamePage(page)).toBe(true);
    await expect(page).toHaveURL(PRODUCTS_ADDRESS);
    await expect(freeableLine(page)).toContainText(
      "Você tem 3 produtos arquivados sem estoque. Excluir libera vaga."
    );
    await expect(freeableLine(page).getByRole("link")).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Ver arquivados" })
    ).toHaveCount(0);
    await expect(line(page)).toContainText("Conhecer o Pro");
  });

  test("o endereço ?arquivados=1 abre Produtos já em Arquivados, com o foco na aba, e o valor não aparece na tela", async ({
    page,
  }) => {
    await openApp(page, "/products?arquivados=1", freeableStore(3));
    await expect(archivedTab(page)).toHaveAttribute("aria-selected", "true");
    await expect(archivedTab(page)).toBeFocused();
    await expect(page.getByText("Jaqueta de inverno").first()).toBeVisible();
    await expect(page.locator("body")).not.toContainText("arquivados=1");
  });

  test("um valor inválido do endereço deixa a lista de Ativos", async ({
    page,
  }) => {
    await openApp(page, "/products?arquivados=sim", freeableStore(3));
    await expect(page.getByText("Camiseta do teste").first()).toBeVisible();
    await expect(page.getByRole("tab", { name: "Ativos" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  test("no formulário de variantes a linha também tem o link, que fecha o diálogo e abre Arquivados", async ({
    page,
  }) => {
    await openApp(page, "/products", freeableStore(3));
    await openVariants(page);
    await expect(dialogFreeable(page)).toContainText(
      "Você tem 3 produtos arquivados sem estoque. Excluir libera vaga."
    );
    const save = page.getByRole("button", { name: "Salvar variantes" });
    expect(await top(dialogFreeable(page))).toBeGreaterThan(await top(save));
    await dialogFreeable(page)
      .getByRole("link", { name: "Ver arquivados" })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(archivedTab(page)).toHaveAttribute("aria-selected", "true");
    expect(await stillTheSamePage(page)).toBe(true);
  });

  test("'Ver arquivados' dentro do diálogo leva o foco à aba e guarda as variantes digitadas para a volta a Ativos", async ({
    page,
  }) => {
    await openApp(page, "/products", freeableStore(3));
    await openVariants(page);
    await dialogFreeable(page)
      .getByRole("link", { name: "Ver arquivados" })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(archivedTab(page)).toHaveAttribute("aria-selected", "true");
    await expect(archivedTab(page)).toBeFocused();
    await page.getByRole("tab", { name: "Ativos" }).click();
    await menuOf(page).click();
    await page.getByRole("menuitem", { name: "Variantes" }).click();
    await expect(page.getByLabel("Valores de Cor")).toHaveValue("Azul\nPreta");
  });

  test("o diálogo de variantes de um produto arquivado traz a linha sem o link", async ({
    page,
  }) => {
    await openApp(page, "/products?arquivados=1", freeableStore(3));
    await page
      .getByRole("button", { name: "Mais ações para Jaqueta de inverno" })
      .click();
    await page.getByRole("menuitem", { name: "Variantes" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog").locator(NEAR_LIMIT)).toBeVisible();
    await expect(dialogFreeable(page)).toContainText(
      "Você tem 3 produtos arquivados sem estoque."
    );
    await expect(dialogFreeable(page).getByRole("link")).toHaveCount(0);
  });

  test("arquivar e restaurar leem o plano de novo: a linha acompanha, sem recarregar", async ({
    page,
  }) => {
    const store = freeableStore(0);
    store.catalog.archived = [];
    store.use = { ...store.use, freeable: { products: 0, variants: 0 } };
    store.answers = {
      ...store.answers,
      "product/archive": (route) => {
        store.catalog.active = [];
        store.catalog.archived = [{ ...shirt, status: "archived", version: 2 }];
        store.use = { ...store.use, freeable: { products: 1, variants: 1 } };
        return route.fulfill(
          rpc({
            changed: true,
            product: { ...shirt, status: "archived", version: 2 },
          })
        );
      },
      "product/restore": (route) => {
        store.catalog.active = [shirt];
        store.catalog.archived = [];
        store.use = { ...store.use, freeable: { products: 0, variants: 0 } };
        return route.fulfill(
          rpc({ changed: true, product: { ...shirt, version: 3 } })
        );
      },
    };
    await openApp(page, "/products", store);
    await expect(line(page)).toContainText("Você usa 47 de 50 variantes");
    await expect(freeableLine(page)).toHaveCount(0);
    await menuOf(page).click();
    await page.getByRole("menuitem", { name: "Arquivar" }).click();
    await expect(freeableLine(page)).toContainText(
      "Você tem 1 produto arquivado sem estoque."
    );
    await archivedTab(page).click();
    await menuOf(page).click();
    await page.getByRole("menuitem", { name: "Restaurar" }).click();
    await expect(freeableLine(page)).toHaveCount(0);
    expect(await stillTheSamePage(page)).toBe(true);
  });

  test("depois de excluir pela tela a linha lê o plano de novo: o número cai e some em zero, sem recarregar", async ({
    page,
  }) => {
    const parka = { ...jacket, id: id(23), name: "Parka de inverno" };
    const store = freeableStore(2);
    store.catalog.archived = [jacket, parka];
    store.answers = {
      ...store.answers,
      "product/delete": (route) => {
        const sent = (
          route.request().postDataJSON() as {
            json: { id: string };
          }
        ).json;
        const gone = store.catalog.archived.find(
          (item) => (item as { id: string }).id === sent.id
        );
        store.catalog.archived = store.catalog.archived.filter(
          (item) => item !== gone
        );
        const left = store.catalog.archived.length;
        store.use = {
          ...store.use,
          freeable: { products: left, variants: left },
        };
        return route.fulfill(
          rpc({
            changed: true,
            product: { ...(gone as object), status: "deleted", version: 3 },
          })
        );
      },
    };
    await openApp(page, "/products", store);
    await expect(freeableLine(page)).toContainText("2 produtos arquivados");
    await page.getByRole("link", { name: "Ver arquivados" }).click();
    for (const name of ["Jaqueta de inverno", "Parka de inverno"]) {
      // biome-ignore lint/performance/noAwaitInLoops: one deletion after the other, on the same page
      await page
        .getByRole("button", { name: `Mais ações para ${name}` })
        .click();
      await page.getByRole("menuitem", { name: "Excluir…" }).click();
      const dialog = page.getByRole("dialog", {
        name: `Excluir produto “${name}”?`,
      });
      await dialog
        .getByLabel("Digite o nome do produto para confirmar")
        .fill(name);
      await dialog.getByRole("button", { name: "Excluir produto" }).click();
      await expect(page.getByText(`Produto “${name}” excluído.`)).toBeVisible();
      if (name === "Jaqueta de inverno") {
        await expect(freeableLine(page)).toContainText(
          "Você tem 1 produto arquivado sem estoque."
        );
      }
    }
    await expect(freeableLine(page)).toHaveCount(0);
    await expect(line(page)).toContainText("Você usa 47 de 50 variantes");
    expect(await stillTheSamePage(page)).toBe(true);
  });

  // A página sem conexão fica do tamanho da de uma loja que nunca teve a segunda linha.
  test("sem conexão a segunda linha some com o aviso, sem deixar vão", async ({
    context,
    page,
  }) => {
    const offlinePage = async (freeable: number) => {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await context.setOffline(false);
      await openApp(page, "/products", freeableStore(freeable));
      await expect(line(page)).toContainText("Você usa 47 de 50 variantes");
      if (freeable > 0) {
        await expect(freeableLine(page)).toBeVisible();
      }
      const root = page.locator(".products-page");
      const online = await root.boundingBox();
      await context.setOffline(true);
      await expect(
        page.getByText("Importar planilha precisa de conexão.")
      ).toBeVisible();
      await expect(freeableLine(page)).toHaveCount(0);
      await expect(line(page)).toHaveCount(0);
      return { offline: await root.boundingBox(), online };
    };
    const withoutSecond = await offlinePage(0);
    const withSecond = await offlinePage(3);
    expect(withSecond.online?.height).toBeGreaterThan(
      withoutSecond.online?.height ?? Number.NaN
    );
    expect(withSecond.offline).toEqual(withoutSecond.offline);
    await context.setOffline(false);
    await expect(freeableLine(page)).toBeVisible();
  });

  for (const surface of [
    "na lista de Produtos",
    "no formulário de variantes",
  ]) {
    for (const width of [360, 320]) {
      test(`no toque, a 20 px de letra e ${width} px, ${surface}, as áreas de 44 px dos dois links não se sobrepõem e nada passa da janela`, async ({
        browser,
      }) => {
        const context = await browser.newContext({
          hasTouch: true,
          viewport: { height: 740, width },
        });
        const page = await context.newPage();
        await page.addInitScript(() => {
          document.addEventListener("DOMContentLoaded", () => {
            document.documentElement.style.fontSize = "20px";
          });
        });
        await openApp(page, "/products", freeableStore(3));
        const inDialog = surface === "no formulário de variantes";
        if (inDialog) {
          await openVariants(page);
        }
        const scope = inDialog ? page.getByRole("dialog") : page;
        await expect(scope.locator(FREEABLE)).toBeVisible();
        const area = async (name: string) => {
          const box = await scope
            .getByRole("link", { name })
            .first()
            .boundingBox();
          if (!box) {
            throw new Error(`sem caixa para ${name}`);
          }
          const height = Math.max(box.height, 44);
          const center = box.y + box.height / 2;
          return { bottom: center + height / 2, top: center - height / 2 };
        };
        const pro = await area("Conhecer o Pro");
        const archived = await area("Ver arquivados");
        expect(archived.top).toBeGreaterThanOrEqual(pro.bottom);
        const overflow = await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth
        );
        expect(overflow).toBeLessThanOrEqual(0);
        if (inDialog) {
          const dialogOverflow = await page
            .getByRole("dialog")
            .evaluate((node) => node.scrollWidth - node.clientWidth);
          expect(dialogOverflow).toBeLessThanOrEqual(0);
        }
        await context.close();
      });
    }
  }
});
