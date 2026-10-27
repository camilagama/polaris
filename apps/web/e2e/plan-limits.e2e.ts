/// <reference lib="dom" />
import type { Locator, Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { mediaListBody, solidPng } from "./media-fixtures";
import { serveHealth, WORKER_MARK } from "./worker-mark";

/**
 * Corte 1.6: the plan's limits lead to the Pro, in the five places the 61b had left (L1 variants, L2 images of the
 * store, L3 images of a product, L4 public catalog, L5 goals), in the real route with the API answered by the test.
 * Each text is its own limit's; under it, by the one rule, "Conhecer o Pro" for the owner of a Free store (with "Você
 * usa N de M" when the plan has them), the way to the owner for the others, nothing on Pro. "Conhecer o Pro" opens the
 * Assinatura inside the app: no load of the page, and what was typed is there on "voltar" (AC-7).
 */
const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const id = (n: number) => `0199c2d0-0000-7000-8000-0000000000${n}`;
const NOW = "2026-10-14T12:00:00.000Z";
const ASK_OWNER = "Fale com o dono da loja para mudar o plano.";
const SUBSCRIPTION = "/configuracoes?aba=assinatura";
const SUBSCRIPTION_ADDRESS = /\/configuracoes\?aba=assinatura$/;
const PRODUCTS_ADDRESS = /\/products$/;
const CATALOG_ADDRESS = /\/configuracoes\?aba=catalogo-publico$/;
const GOALS_ADDRESS = /\/dashboard\?aba=metas$/;

const L1 = "Seu plano chegou ao limite de variantes. Nada foi alterado.";
const L2 =
  "Seu plano chegou ao limite de imagens da loja. Remova uma imagem para liberar um lugar e envie de novo.";
const L3 =
  "Este produto chegou ao limite de imagens do seu plano. Remova uma imagem dele para liberar um lugar e envie de novo.";
const L4 = "Seu plano não inclui o catálogo público.";
const L5 = "Seu plano chegou ao limite de metas em andamento. Nada foi criado.";
const L5_CANCEL = "Cancele uma meta para abrir lugar.";
const CREATE_LIMIT =
  "Seu plano chegou ao limite de variantes. Nada foi cadastrado.";

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

const planOf = (state: string) => ({
  accessEndsAt: state === "free" ? null : "2026-11-24T03:00:00.000Z",
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
  usage: { goals: 1, images: 50, variants: 50 },
});

type Handler = (route: Route) => Promise<void>;

interface Store {
  answers: Record<string, Handler>;
  billingSelfService?: boolean;
  role: string;
  state: string;
}

/** The app as a person of the store sees it; what has no answer is a network that failed. */
async function openApp(page: Page, path: string, store: Store) {
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
      return route.fulfill(
        rpc({
          billingSelfService: store.billingSelfService ?? true,
          organizations: [{ ...ORGANIZATION, role: store.role }],
        })
      );
    }
    if (procedure === "billing/readPlan") {
      return route.fulfill(rpc(planOf(store.state)));
    }
    const handler = store.answers[procedure];
    return handler ? handler(route) : route.abort("internetdisconnected");
  });
  await page.goto(path);
  // a load of the page would drop it: it proves that "Conhecer o Pro" opens the Assinatura inside the app
  await page.evaluate(() => {
    (window as unknown as { polarisNoLoad: boolean }).polarisNoLoad = true;
  });
}

const stillTheSamePage = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { polarisNoLoad?: boolean }).polarisNoLoad === true
  );

const upgradeIn = (scope: Locator) =>
  scope.getByRole("link", { name: "Conhecer o Pro" });

/** "Conhecer o Pro" opens the Assinatura in the same page, and "voltar" comes back to the screen. */
async function goToProAndBack(page: Page, link: Locator, back: RegExp) {
  await expect(link).toHaveAttribute("href", SUBSCRIPTION);
  await link.click();
  await expect(page).toHaveURL(SUBSCRIPTION_ADDRESS);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await stillTheSamePage(page)).toBe(true);
  await page.goBack();
  await expect(page).toHaveURL(back);
  expect(await stillTheSamePage(page)).toBe(true);
}

// ---- products: L1 and the 61b's create --------------------------------------------------------------------------

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

const reply =
  (json: unknown): Handler =>
  (route) =>
    route.fulfill(rpc(json));

const productAnswers = (writes: string[]): Record<string, Handler> => ({
  "category/list": reply({ categories: [] }),
  "product/configureVariants": (route) => {
    writes.push("configureVariants");
    return route.fulfill(limitRefusal);
  },
  "product/create": (route) => {
    writes.push("create");
    return route.fulfill(limitRefusal);
  },
  "product/getVariants": reply(UNCONFIGURED),
  "product/list": reply({ products: [shirt] }),
});

const menuOf = (page: Page) =>
  page.getByRole("button", { name: "Mais ações para Camiseta do teste" });

/** Opens the variants of the shirt, types two colors and a combination, and saves: the plan refuses it. */
async function configureAtLimit(page: Page) {
  await menuOf(page).click();
  await page.getByRole("menuitem", { name: "Variantes" }).click();
  await page.getByRole("checkbox", { name: "Cor" }).click();
  await page.getByLabel("Valores de Cor").fill("Azul\nPreta");
  await page.getByRole("button", { name: "Adicionar combinação" }).click();
  const color = page.getByRole("combobox", { exact: true, name: "Cor" });
  await color.click();
  await page.getByRole("option", { exact: true, name: "Azul" }).click();
  await page.getByRole("button", { name: "Salvar variantes" }).click();
  const alert = page.getByRole("dialog").getByRole("alert");
  await expect(alert).toContainText(L1);
  return alert;
}

test("L1: configurar variantes no limite diz o limite, não 'o produto mudou', com o caminho certo a cada papel", async ({
  page,
}) => {
  const writes: string[] = [];
  await openApp(page, "/products", {
    answers: productAnswers(writes),
    role: "owner",
    state: "free",
  });
  const alert = await configureAtLimit(page);
  await expect(alert).toBeFocused();
  await expect(alert).not.toContainText("O produto mudou");
  await expect(alert).toContainText(
    "Você usa 50 de 50 variantes no plano Free."
  );
  await expect(upgradeIn(alert)).toBeVisible();
  // nothing was read again: the form stays as typed
  await expect(page.getByLabel("Valores de Cor")).toHaveValue("Azul\nPreta");
  expect(writes).toEqual(["configureVariants"]);

  for (const store of [
    { role: "cashier", state: "free", text: `${L1}${ASK_OWNER}` },
    { role: "owner", state: "active", text: L1 },
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: one store after the other, on the same page
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await openApp(page, "/products", {
      answers: productAnswers([]),
      role: store.role,
      state: store.state,
    });
    const other = await configureAtLimit(page);
    await expect(other).toHaveText(store.text);
    await expect(upgradeIn(other)).toHaveCount(0);
  }
});

test("AC-7 no L1: 'Conhecer o Pro' fecha o Dialog guardando as variantes, sem recarregar, e elas voltam", async ({
  page,
}) => {
  await openApp(page, "/products", {
    answers: productAnswers([]),
    role: "owner",
    state: "free",
  });
  const alert = await configureAtLimit(page);
  await goToProAndBack(page, upgradeIn(alert), PRODUCTS_ADDRESS);
  await menuOf(page).click();
  await page.getByRole("menuitem", { name: "Variantes" }).click();
  await expect(page.getByRole("checkbox", { name: "Cor" })).toBeChecked();
  await expect(page.getByLabel("Valores de Cor")).toHaveValue("Azul\nPreta");
  await expect(
    page.getByRole("combobox", { exact: true, name: "Cor" })
  ).toContainText("Azul");
});

test("AC-7 no cadastro (61b): o produto digitado continua lá depois da Assinatura, sem recarregar", async ({
  page,
}) => {
  await openApp(page, "/products", {
    answers: productAnswers([]),
    role: "owner",
    state: "free",
  });
  await page.getByRole("button", { name: "Novo produto" }).first().click();
  await page.getByLabel("Nome do produto").fill("Bolsa de couro");
  await page.getByRole("button", { name: "Cadastrar produto" }).click();
  const alert = page.getByRole("dialog").getByRole("alert");
  await expect(alert).toContainText(CREATE_LIMIT);
  await expect(alert).toContainText(
    "Você usa 50 de 50 variantes no plano Free."
  );
  await goToProAndBack(page, upgradeIn(alert), PRODUCTS_ADDRESS);
  await page.getByRole("button", { name: "Novo produto" }).first().click();
  await expect(page.getByLabel("Nome do produto")).toHaveValue(
    "Bolsa de couro"
  );
});

// ---- images: L2 and L3 --------------------------------------------------------------------------------------------

/** The images of the shirt, with a photo picked and sent: the Worker answers `answer`. */
async function sendImage(
  page: Page,
  store: Omit<Store, "answers">,
  answer: { body: unknown; status: number }
) {
  let uploads = 0;
  await page.route("**/api/products/*/media**", (route) => {
    if (route.request().method() === "POST") {
      uploads += 1;
      return route.fulfill({
        body: JSON.stringify(answer.body),
        contentType: "application/json",
        headers: { ...WORKER_MARK },
        status: answer.status,
      });
    }
    return route.fulfill({
      body: mediaListBody(0),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    });
  });
  await openApp(page, "/products", {
    ...store,
    answers: {
      ...productAnswers([]),
      "product/getVariants": reply({ ...UNCONFIGURED, configured: true }),
    },
  });
  await menuOf(page).click();
  await page.getByRole("menuitem", { name: "Imagens" }).click();
  await page.getByLabel("Escolher imagem").setInputFiles({
    buffer: solidPng(480, 320),
    mimeType: "image/png",
    name: "foto.png",
  });
  await page.getByRole("button", { name: "Enviar imagem" }).click();
  const alert = page.getByRole("dialog").getByRole("alert");
  await expect(alert).toBeVisible();
  // the photo is not taken as sent: it stays, to send once a place is free
  await expect(
    page.getByRole("button", { name: "Enviar imagem" })
  ).toBeEnabled();
  return { alert, uploads: () => uploads };
}

const imageLimit = (limit: string) => ({
  body: { error: { code: "entitlement_limit_reached", limit } },
  status: 409,
});

test("L2 e L3: o limite da loja e o do produto dizem cada um o seu, com o caminho até o Pro; o teto técnico não", async ({
  page,
}) => {
  const owner = { role: "owner", state: "free" };
  const store = await sendImage(page, owner, imageLimit("images.active.max"));
  await expect(store.alert).toHaveText(
    `${L2}Você usa 50 de 50 imagens no plano Free.Conhecer o Pro`
  );
  await expect(store.alert).toBeFocused();
  expect(store.uploads()).toBe(1);

  await page.unrouteAll({ behavior: "ignoreErrors" });
  const product = await sendImage(
    page,
    owner,
    imageLimit("images.per_product.max")
  );
  // no "N de M" for one product: the plan's read has no number per product
  await expect(product.alert).toHaveText(`${L3}Conhecer o Pro`);
  await expect(product.alert).not.toContainText("máximo");

  await page.unrouteAll({ behavior: "ignoreErrors" });
  const ceiling = await sendImage(page, owner, {
    body: { error: { code: "product_media_limit" } },
    status: 409,
  });
  await expect(ceiling.alert).toHaveText(
    "Este produto já tem o máximo de imagens. Remova uma imagem para liberar um lugar e envie de novo."
  );
  await expect(upgradeIn(ceiling.alert)).toHaveCount(0);

  await page.unrouteAll({ behavior: "ignoreErrors" });
  const cashier = await sendImage(
    page,
    { role: "cashier", state: "free" },
    imageLimit("images.per_product.max")
  );
  await expect(cashier.alert).toHaveText(`${L3}${ASK_OWNER}`);
});

// ---- public catalog: L4 -------------------------------------------------------------------------------------------

const catalogAnswers: Record<string, Handler> = {
  "product/list": reply({ products: [] }),
  "publicCatalog/setup": reply({
    enabled: false,
    profile: null,
    publicOrigin: "https://catalogo.example",
    publishedProductIds: [],
  }),
};

test("L4: fora do plano, o aviso do catálogo leva o dono ao Pro e os outros ao dono; os campos seguem desligados", async ({
  page,
}) => {
  await openApp(page, "/public-catalog", {
    answers: catalogAnswers,
    role: "owner",
    state: "free",
  });
  const notice = page.getByRole("status").filter({ hasText: L4 });
  await expect(notice).toContainText("faz parte do plano Pro");
  await expect(
    page.getByRole("button", { name: "Salvar perfil" })
  ).toHaveAttribute("aria-disabled", "true");
  await goToProAndBack(page, upgradeIn(notice), CATALOG_ADDRESS);

  for (const store of [
    { billingSelfService: true, role: "cashier", text: ASK_OWNER },
    { billingSelfService: false, role: "owner", text: null },
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: one store after the other, on the same page
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await openApp(page, "/public-catalog", {
      answers: catalogAnswers,
      billingSelfService: store.billingSelfService,
      role: store.role,
      state: "free",
    });
    const other = page.getByRole("status").filter({ hasText: L4 });
    await expect(other).toBeVisible();
    await expect(upgradeIn(other)).toHaveCount(0);
    if (store.text) {
      await expect(other).toContainText(store.text);
    } else {
      await expect(other).not.toContainText(ASK_OWNER);
    }
  }
});

// ---- goals: L5 and the goal paused by the plan --------------------------------------------------------------------

const goalOf = (n: number, extra: Record<string, unknown> = {}) => ({
  achievedValue: null,
  createdAt: "2026-10-01T12:00:00.000Z",
  endsOn: "2026-10-31",
  id: id(70 + n),
  kind: "net_sales",
  name: `Meta ${n}`,
  organizationId: ORGANIZATION.id,
  paused: false,
  progress: {
    percent: "10.0",
    periodEnded: false,
    reached: false,
    value: "100.00",
  },
  settledAt: null,
  startsOn: "2026-10-01",
  status: "active",
  target: "1000.00",
  updatedAt: "2026-10-01T12:00:00.000Z",
  version: 1,
  ...extra,
});

const goalAnswers = (
  goals: unknown[],
  writes: string[] = []
): Record<string, Handler> => ({
  "goal/create": (route) => {
    writes.push("create");
    return route.fulfill(limitRefusal);
  },
  "goal/list": reply({ goals }),
});

const GOALS = "/dashboard?aba=metas";

async function createGoalAtLimit(page: Page) {
  await page.getByRole("button", { name: "Nova meta" }).click();
  await page.locator("#goal-create-target").fill("2.000,00");
  await page
    .getByRole("dialog", { name: "Nova meta" })
    .getByRole("button", { name: "Criar meta" })
    .click();
  const alert = page
    .getByRole("dialog", { name: "Nova meta" })
    .getByRole("alert");
  await expect(alert).toContainText(L5);
  return alert;
}

test("L5: criar meta no limite diz o limite, nunca 'Tente novamente', fica no formulário e leva ao Pro", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date(NOW));
  const writes: string[] = [];
  await openApp(page, GOALS, {
    answers: goalAnswers([goalOf(1)], writes),
    role: "owner",
    state: "free",
  });
  const alert = await createGoalAtLimit(page);
  await expect(alert).toHaveText(
    `${L5}${L5_CANCEL}Você usa 1 de 1 meta em andamento no plano Free.Conhecer o Pro`
  );
  await expect(alert).not.toContainText("Tente novamente");
  await expect(alert).toBeFocused();
  expect(writes).toEqual(["create"]);

  // AC-7: the form closes as Esc does, the Assinatura opens in the same page, and the target typed comes back
  await goToProAndBack(page, upgradeIn(alert), GOALS_ADDRESS);
  await page.getByRole("button", { name: "Nova meta" }).click();
  await expect(page.locator("#goal-create-target")).toHaveValue("2.000,00");
});

test("L5: sem meta que dê para cancelar, a frase de cancelar não aparece; quem não é dono lê o caminho até o dono", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date(NOW));
  await openApp(page, GOALS, {
    answers: goalAnswers([goalOf(1, { status: "cancelled" })]),
    role: "cashier",
    state: "free",
  });
  const alert = await createGoalAtLimit(page);
  await expect(alert).toHaveText(`${L5}${ASK_OWNER}`);
});

test("a meta pausada pelo plano mantém o texto e ganha o caminho até o Pro", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date(NOW));
  await openApp(page, GOALS, {
    answers: goalAnswers([
      goalOf(1),
      goalOf(2, { paused: true, progress: null }),
    ]),
    role: "owner",
    state: "free_over_limit",
  });
  const paused = page.locator("[data-slot=card]").filter({
    has: page.getByRole("heading", { exact: true, name: "Meta 2" }),
  });
  await expect(paused).toContainText("esta meta está pausada");
  await expect(upgradeIn(paused)).toBeVisible();
  const running = page.locator("[data-slot=card]").filter({
    has: page.getByRole("heading", { exact: true, name: "Meta 1" }),
  });
  await expect(upgradeIn(running)).toHaveCount(0);
});
