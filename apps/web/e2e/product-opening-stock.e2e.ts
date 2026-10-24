/// <reference lib="dom" />
import type { Locator, Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { WORKER_MARK } from "./worker-mark";

/**
 * A product with its price and its opening stock in one step (AC-24 to AC-26 of the Início), in the real route with
 * the API answered by the test (the server mode, no offline runtime):
 * - the three cases of the quantity and the cost (both, the quantity alone, a cost with no quantity) and what each
 *   sends to the server, in the one `product.create` call;
 * - the retry of a try whose answer was lost names the same product, variant and stock command;
 * - the number of actions from the button "Novo produto" to a product ready to sell (AC-25), counted the way the
 *   usability research of staging counted (one per tap, per field filled and per choice), recorded in the report
 *   of the test and held to 11 or less, half of the 22 measured then;
 * - a store with no product is taken from the sale to the form (AC-26);
 * - the open form, with its details open, holds in the width of a phone;
 * - from 768 px up the labels of the form stay on one line: the columns follow the width of the card.
 */
const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const QUANTITY_FOR_COST_TEXT = /Informe quantos você tem para guardar o custo/;
const NEW_PRODUCT_URL = /\/products\?novo=1$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The actions of the staging research that the AC-25 measure is compared to (F2, the first product). */
const STAGING_ACTIONS = 22;
const MAX_ACTIONS = STAGING_ACTIONS / 2;

const rpc = (json: unknown, status = 200) => ({
  body: JSON.stringify({ json, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
  status,
});

const createdProduct = (name: string, productId: string) => ({
  archivedAt: null,
  categoryId: null,
  createdAt: "2026-10-24T12:00:00.000Z",
  deletedAt: null,
  description: null,
  id: productId,
  name,
  organizationId: ORGANIZATION.id,
  status: "active",
  updatedAt: "2026-10-24T12:00:00.000Z",
  version: 1,
});

interface CreateBody {
  categoryId?: string | null;
  description?: string | null;
  initialStock?: {
    commandId: string;
    quantity: number;
    unitCost: string | null;
  } | null;
  listPrice?: string | null;
  name: string;
  productId?: string;
  variantId?: string;
}

interface ScreenOptions {
  /** What `product/create` does at each call, in order; the last one repeats. */
  creates?: ReadonlyArray<(route: Route, body: CreateBody) => Promise<void>>;
  path?: string;
}

/** Opens a screen with the session, the organization and an empty catalog answered here; records the creates. */
async function openScreen(
  page: Page,
  { creates = [], path = "/products" }: ScreenOptions = {}
) {
  const bodies: CreateBody[] = [];
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
    switch (procedure) {
      case "organization/listMine":
        return route.fulfill(rpc({ organizations: [ORGANIZATION] }));
      case "category/list":
        return route.fulfill(rpc({ categories: [] }));
      case "product/list":
        return route.fulfill(rpc({ products: [] }));
      case "inventory/listBalances":
        return route.fulfill(
          rpc({ entries: [], more: false, nextCursor: null })
        );
      case "paymentProfile/list":
        return route.fulfill(rpc({ profiles: [] }));
      case "product/create": {
        const { json } = route.request().postDataJSON() as { json: CreateBody };
        bodies.push(json);
        const create =
          creates[Math.min(bodies.length - 1, creates.length - 1)] ??
          ((answer: Route, body: CreateBody) =>
            answer.fulfill(
              rpc(createdProduct(body.name, body.productId ?? "p"))
            ));
        return create(route, json);
      }
      default:
        return route.abort("internetdisconnected");
    }
  });
  await page.goto(path);
  return bodies;
}

const lost = (route: Route) => route.abort("internetdisconnected");

async function openForm(page: Page) {
  await page.getByRole("button", { name: "Novo produto" }).first().click();
  await expect(page.getByLabel("Nome do produto")).toBeFocused();
}

const submit = (page: Page) =>
  page.getByRole("button", { name: "Cadastrar produto" });

const only = (items: CreateBody[]) => {
  expect(items).toHaveLength(1);
  return items[0] as CreateBody;
};

test("quantidade e custo: o produto, o preço e o estoque de abertura vão numa chamada só, com o custo", async ({
  page,
}) => {
  const bodies = await openScreen(page);
  await openForm(page);
  await page.getByLabel("Nome do produto").fill("Camiseta básica");
  await page.getByLabel("Preço de tabela").fill("49,90");
  await page.getByLabel("Quantos você tem agora").fill("10");
  await page.getByLabel("Custo de cada unidade").fill("12,5");
  await submit(page).click();
  await expect(
    page.getByText("Produto “Camiseta básica” cadastrado com 10 unidades.")
  ).toBeVisible();

  const body = only(bodies);
  expect(body).toMatchObject({
    categoryId: null,
    listPrice: "49.90",
    name: "Camiseta básica",
    organizationId: ORGANIZATION.id,
  });
  expect(body.initialStock).toEqual({
    commandId: expect.stringMatching(UUID),
    quantity: 10,
    unitCost: "12.5",
  });
  expect(body.productId).toMatch(UUID);
  expect(body.variantId).toMatch(UUID);
});

test("quantidade sem custo: o estoque abre com o custo desconhecido (custo nulo), sem erro", async ({
  page,
}) => {
  const bodies = await openScreen(page);
  await openForm(page);
  await page.getByLabel("Nome do produto").fill("Caneca");
  await page.getByLabel("Quantos você tem agora").fill("5");
  await submit(page).click();
  await expect(
    page.getByText("Produto “Caneca” cadastrado com 5 unidades.")
  ).toBeVisible();

  const body = only(bodies);
  expect(body.initialStock).toEqual({
    commandId: expect.stringMatching(UUID),
    quantity: 5,
    unitCost: null,
  });
  expect(body.listPrice).toBeNull();
});

test("quantidade e custo vazios (ou quantidade 0): só o produto, sem estoque", async ({
  page,
}) => {
  const bodies = await openScreen(page);
  await openForm(page);
  await page.getByLabel("Nome do produto").fill("Meia");
  await submit(page).click();
  await expect(page.getByText("Produto “Meia” cadastrado.")).toBeVisible();
  expect(only(bodies).initialStock).toBeNull();

  await openForm(page);
  await page.getByLabel("Nome do produto").fill("Cinto");
  await page.getByLabel("Quantos você tem agora").fill("0");
  await submit(page).click();
  await expect(page.getByText("Produto “Cinto” cadastrado.")).toBeVisible();
  expect(bodies[1]?.initialStock).toBeNull();
});

test("custo sem quantidade: o erro fica no campo da quantidade, o foco vai a ele e nada é enviado", async ({
  page,
}) => {
  const bodies = await openScreen(page);
  await openForm(page);
  await page.getByLabel("Nome do produto").fill("Boné");
  await page.getByLabel("Custo de cada unidade").fill("8");
  await submit(page).click();

  const quantity = page.getByLabel("Quantos você tem agora");
  await expect(
    page.getByText(
      "Informe quantos você tem para guardar o custo, ou apague o custo."
    )
  ).toBeVisible();
  await expect(quantity).toBeFocused();
  await expect(quantity).toHaveAttribute("aria-invalid", "true");
  await expect(quantity).toHaveAccessibleDescription(QUANTITY_FOR_COST_TEXT);
  expect(bodies).toHaveLength(0);

  // a quantity of 0 is no quantity: the cost still has nothing to belong to
  await quantity.fill("0");
  await submit(page).click();
  await expect(quantity).toBeFocused();
  expect(bodies).toHaveLength(0);

  // fixing it sends the product, with the cost
  await quantity.fill("3");
  await submit(page).click();
  await expect(
    page.getByText("Produto “Boné” cadastrado com 3 unidades.")
  ).toBeVisible();
  expect(only(bodies).initialStock).toMatchObject({
    quantity: 3,
    unitCost: "8",
  });
});

test("valores inválidos: cada campo diz o seu erro, o foco vai ao primeiro e nada é enviado", async ({
  page,
}) => {
  const bodies = await openScreen(page);
  await openForm(page);
  await page.getByLabel("Nome do produto").fill("Tênis");
  await page.getByLabel("Preço de tabela").fill("49,999");
  await page.getByLabel("Quantos você tem agora").fill("1,5");
  await page.getByLabel("Custo de cada unidade").fill("abc");
  await submit(page).click();

  await expect(
    page.getByText("Informe um valor em reais, como 59,90.")
  ).toBeVisible();
  await expect(
    page.getByText("Informe quantos você tem, só com números. Ex.: 10.")
  ).toBeVisible();
  await expect(
    page.getByText(
      "Use um valor em reais, com até 6 casas decimais. Ex.: 12,34."
    )
  ).toBeVisible();
  await expect(page.getByLabel("Preço de tabela")).toBeFocused();
  expect(bodies).toHaveLength(0);
});

test("a repetição de um envio sem resposta nomeia o mesmo produto, a mesma variante e o mesmo comando de estoque", async ({
  page,
}) => {
  const bodies = await openScreen(page, {
    creates: [
      lost,
      (route, body) =>
        route.fulfill(rpc(createdProduct(body.name, body.productId ?? "p"))),
    ],
  });
  await openForm(page);
  await page.getByLabel("Nome do produto").fill("Camiseta básica");
  await page.getByLabel("Quantos você tem agora").fill("10");
  await page.getByLabel("Custo de cada unidade").fill("12,5");
  await submit(page).click();
  // the first try had no answer: the form stays, with what was typed
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByLabel("Quantos você tem agora")).toHaveValue("10");
  await submit(page).click();
  await expect(
    page.getByText("Produto “Camiseta básica” cadastrado com 10 unidades.")
  ).toBeVisible();

  expect(bodies).toHaveLength(2);
  const [first, second] = bodies as [CreateBody, CreateBody];
  expect(second.productId).toBe(first.productId);
  expect(second.variantId).toBe(first.variantId);
  expect(second.initialStock?.commandId).toBe(first.initialStock?.commandId);

  // a new opening of the form is a new product
  await openForm(page);
  await page.getByLabel("Nome do produto").fill("Caneca");
  await submit(page).click();
  await expect(page.getByText("Produto “Caneca” cadastrado.")).toBeVisible();
  expect(bodies[2]?.productId).not.toBe(first.productId);
});

test("o produto já cadastrado com outros dados diz isso e não culpa a categoria; o envio seguinte é um produto novo", async ({
  page,
}) => {
  const bodies = await openScreen(page, {
    creates: [
      (route) =>
        route.fulfill(
          rpc(
            {
              code: "CONFLICT",
              data: { reason: "product_create_conflict" },
              defined: false,
              message: "Conflict",
              status: 409,
            },
            409
          )
        ),
    ],
  });
  await openForm(page);
  await page.getByLabel("Nome do produto").fill("Camiseta");
  await submit(page).click();
  await expect(page.getByRole("alert")).toContainText(
    "Este produto já foi cadastrado, com outros dados."
  );
  await expect(page.getByRole("alert")).not.toContainText("categoria");
  await submit(page).click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]?.productId).not.toBe(bodies[0]?.productId);
});

test("Mais detalhes: a categoria e a descrição ficam fechadas, abrem sob pedido e a descrição digitada vai junto", async ({
  page,
}) => {
  const bodies = await openScreen(page);
  await openForm(page);
  const description = page.getByLabel("Descrição");
  const details = page.getByRole("button", { name: "Mais detalhes" });
  await expect(details).toHaveAttribute("aria-expanded", "false");
  await expect(description).toBeHidden();
  await details.click();
  await expect(details).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByRole("combobox", { exact: true, name: "Categoria" })
  ).toBeVisible();
  await description.fill("Algodão, corte reto.");
  // closing keeps what was typed
  await details.click();
  await expect(description).toBeHidden();
  await details.click();
  await expect(description).toHaveValue("Algodão, corte reto.");

  await page.getByLabel("Nome do produto").fill("Camiseta");
  await submit(page).click();
  await expect(page.getByText("Produto “Camiseta” cadastrado.")).toBeVisible();
  expect(only(bodies).description).toBe("Algodão, corte reto.");
});

test("AC-25: do botão 'Novo produto' a um produto pronto para vender são 6 ações, menos da metade das 22 da pesquisa", async ({
  page,
}, testInfo) => {
  const bodies = await openScreen(page);
  // the count follows the method of the staging research: one action per tap, per field filled and per choice
  let actions = 0;
  const tap = async (locator: Locator) => {
    actions += 1;
    await locator.click();
  };
  const fill = async (locator: Locator, text: string) => {
    actions += 1;
    await locator.fill(text);
  };

  await tap(page.getByRole("button", { name: "Novo produto" }).first());
  await fill(page.getByLabel("Nome do produto"), "Camiseta básica");
  await fill(page.getByLabel("Preço de tabela"), "49,90");
  await fill(page.getByLabel("Quantos você tem agora"), "10");
  await fill(page.getByLabel("Custo de cada unidade"), "12,5");
  await tap(submit(page));
  await expect(
    page.getByText("Produto “Camiseta básica” cadastrado com 10 unidades.")
  ).toBeVisible();

  // ready to sell: it has a price and a stock, with nothing left to open (variants, SKU and receipt are not needed)
  const body = only(bodies);
  expect(body.listPrice).toBe("49.90");
  expect(body.initialStock?.quantity).toBe(10);

  testInfo.annotations.push({
    description: `${actions} ações (pesquisa de staging: ${STAGING_ACTIONS})`,
    type: "AC-25",
  });
  await testInfo.attach("AC-25-contagem-de-acoes.json", {
    body: JSON.stringify(
      {
        acoes: actions,
        limite: MAX_ACTIONS,
        medidoNaPesquisaDeStaging: STAGING_ACTIONS,
        metodo: "um toque, um campo preenchido ou uma escolha = uma ação",
        passos: [
          "tocar em Novo produto",
          "nome",
          "preço de venda",
          "quantos você tem agora",
          "custo de cada unidade",
          "tocar em Cadastrar produto",
        ],
      },
      null,
      2
    ),
    contentType: "application/json",
  });
  console.log(
    `AC-25: ${actions} ações (limite ${MAX_ACTIONS}, pesquisa ${STAGING_ACTIONS})`
  );
  expect(actions).toBeLessThanOrEqual(MAX_ACTIONS);
});

test("AC-26: a Venda sem produto diz 'Cadastre um produto para vender.' e leva ao cadastro com um botão", async ({
  page,
}) => {
  await openScreen(page, { path: "/sales" });
  await expect(
    page.getByText("Cadastre um produto para vender.")
  ).toBeVisible();
  // the text no longer sends the person to the catalog and to the stock, in two steps
  await expect(page.getByText("dê entrada no estoque")).toHaveCount(0);
  const button = page.getByRole("link", { name: "Cadastrar produto" });
  await expect(button).toHaveAttribute("href", "/products?novo=1");
  await button.click();
  await expect(page).toHaveURL(NEW_PRODUCT_URL);
  // the address opens the form of a new product, with the focus on its title
  await expect(
    page.getByRole("heading", { exact: true, name: "Novo produto" })
  ).toBeVisible();
  await expect(page.getByLabel("Nome do produto")).toBeVisible();
});

test("AC-25 pela Venda: do botão 'Cadastrar produto' da Venda a um produto pronto para vender são 6 ações", async ({
  page,
}, testInfo) => {
  const bodies = await openScreen(page, { path: "/sales" });
  let actions = 0;
  const tap = async (locator: Locator) => {
    actions += 1;
    await locator.click();
  };
  const fill = async (locator: Locator, text: string) => {
    actions += 1;
    await locator.fill(text);
  };

  await tap(page.getByRole("link", { name: "Cadastrar produto" }));
  await expect(page.getByLabel("Nome do produto")).toBeVisible();
  await fill(page.getByLabel("Nome do produto"), "Camiseta básica");
  await fill(page.getByLabel("Preço de tabela"), "49,90");
  await fill(page.getByLabel("Quantos você tem agora"), "10");
  await fill(page.getByLabel("Custo de cada unidade"), "12,5");
  await tap(submit(page));
  await expect(
    page.getByText("Produto “Camiseta básica” cadastrado com 10 unidades.")
  ).toBeVisible();
  expect(only(bodies).initialStock?.quantity).toBe(10);

  testInfo.annotations.push({
    description: `${actions} ações (pesquisa de staging: ${STAGING_ACTIONS})`,
    type: "AC-25 pela Venda",
  });
  console.log(
    `AC-25 pela Venda: ${actions} ações (limite ${MAX_ACTIONS}, pesquisa ${STAGING_ACTIONS})`
  );
  expect(actions).toBeLessThanOrEqual(MAX_ACTIONS);
});

test("AC-26: uma busca sem resultado não oferece o cadastro", async ({
  page,
}) => {
  await openScreen(page, { path: "/sales" });
  const search = page.getByLabel("Produto ou variante");
  await search.fill("zzz");
  await expect(
    page.getByText("Nenhuma variante encontrada para “zzz”.")
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Cadastrar produto" })
  ).toHaveCount(0);
});

/** No box of the screen ends beyond the right edge of the window. */
async function expectNoSidewaysScroll(page: Page) {
  const found = await page.evaluate(() => {
    const root = document.querySelector(".products-page");
    const limit = window.innerWidth + 0.5;
    const boxes = [...(root?.querySelectorAll("*") ?? [])].map((element) => ({
      right: element.getBoundingClientRect().right,
      text: (element.textContent ?? "").trim().slice(0, 40),
    }));
    return {
      measured: boxes.length,
      past: boxes.filter((box) => box.right > limit),
    };
  });
  expect(found.measured).toBeGreaterThan(20);
  expect(found.past).toEqual([]);
}

for (const width of [360, 320]) {
  test(`a ${width} px o formulário aberto, com os detalhes abertos e com erro, cabe na janela e os campos têm altura de toque`, async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name.includes("mobile"),
      "the width is set by the test itself"
    );
    await page.setViewportSize({ height: 740, width });
    await openScreen(page);
    await openForm(page);
    await page.getByRole("button", { name: "Mais detalhes" }).click();
    await expectNoSidewaysScroll(page);

    // the open state is what is measured: every field of the open form is at least 32 px tall (36 with touch)
    for (const label of [
      "Nome do produto",
      "Preço de tabela",
      "Quantos você tem agora",
      "Custo de cada unidade",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each field is measured on its own
      const box = await page.getByLabel(label).boundingBox();
      expect(box?.height ?? 0, label).toBeGreaterThanOrEqual(32);
    }
    const category = await page
      .getByRole("combobox", { exact: true, name: "Categoria" })
      .boundingBox();
    expect(category?.height ?? 0).toBeGreaterThanOrEqual(32);

    // with every error drawn at once
    await page
      .getByLabel("Nome do produto")
      .fill("Tênis com nome bem comprido para a janela estreita de um celular");
    await page.getByLabel("Preço de tabela").fill("abc");
    await page.getByLabel("Quantos você tem agora").fill("1,5");
    await page.getByLabel("Custo de cada unidade").fill("abc");
    await submit(page).click();
    await expect(
      page.getByText("Informe um valor em reais, como 59,90.")
    ).toBeVisible();
    await expectNoSidewaysScroll(page);
  });
}

/** Window width, and how many fields of the opening stock share a row (the columns follow the card, not the window). */
const COLUMNS_BY_WIDTH = [
  { columns: 1, width: 768 },
  { columns: 2, width: 900 },
  { columns: 3, width: 1024 },
  { columns: 3, width: 1280 },
] as const;
const FIELD_IDS = [
  "product-list-price",
  "product-quantity",
  "product-unit-cost",
];
/** A label of one line is about 19 px tall; two lines are 39. */
const ONE_LINE = 28;

for (const { columns, width } of COLUMNS_BY_WIDTH) {
  test(`a ${width} px os rótulos do cadastro ficam em uma linha, em ${columns} coluna(s) conforme a largura do cartão`, async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name.includes("mobile"),
      "the width is set by the test itself"
    );
    await page.setViewportSize({ height: 800, width });
    await openScreen(page);
    await openForm(page);

    const boxes = await page.evaluate(
      (ids) =>
        ids.map((id) => {
          const label = document
            .querySelector(`label[for="${id}"]`)
            ?.getBoundingClientRect();
          const field = document.getElementById(id)?.getBoundingClientRect();
          return {
            id,
            labelHeight: label?.height ?? 0,
            top: Math.round(field?.top ?? 0),
          };
        }),
      FIELD_IDS
    );
    for (const box of boxes) {
      expect(box.labelHeight, box.id).toBeGreaterThan(0);
      expect(box.labelHeight, box.id).toBeLessThan(ONE_LINE);
    }
    const rows = new Set(boxes.map((box) => box.top));
    expect(rows.size).toBe(Math.ceil(FIELD_IDS.length / columns));
    await expectNoSidewaysScroll(page);
  });
}
