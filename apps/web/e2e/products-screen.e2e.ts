/// <reference lib="dom" />
import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  productionPolicy,
  serveUnderProductionCsp,
  watchCspViolations,
} from "./csp-fixture";
import { WORKER_MARK, serveLabWorker } from "./worker-mark";

/**
 * The products screen on the components of src/ui (v5.1, third migrated screen):
 * - in the lab of the offline screens (the device's collections, a seeded catalog): every control opens and changes
 *   state under the production Content-Security-Policy with zero violations, in the light and in the dark theme,
 *   and at 320 px nothing goes past the window;
 * - in the real route, with the API answered by the test (the server mode, no offline runtime): the list failing and
 *   being read again, the search, the name that is required, a product created and archived with the result said
 *   and focused, and the field of the search not taking the border of the old shell (`.ui-root input`).
 */
const DARK = /\bdark\b/;
const NOT_DARK = /^(?!.*\bdark\b).*$/;
const THEMES = [
  { dark: false, name: "claro", stored: "claro" },
  { dark: true, name: "escuro", stored: "escuro" },
] as const;

const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const id = (n: number) => `0199c2d0-0000-7000-8000-0000000000${n}`;

const rpc = (json: unknown, status = 200) => ({
  body: JSON.stringify({ json, meta: [] }),
  headers: { ...WORKER_MARK },
  contentType: "application/json",
  status,
});
const unavailable = rpc(
  {
    code: "SERVICE_UNAVAILABLE",
    data: undefined,
    defined: false,
    message: "Unavailable",
    status: 503,
  },
  503
);

const product = (n: number, name: string, status = "active") => ({
  archivedAt: null,
  categoryId: null,
  createdAt: "2026-10-14T12:00:00.000Z",
  deletedAt: null,
  description: null,
  id: id(20 + n),
  name,
  organizationId: ORGANIZATION.id,
  status,
  updatedAt: "2026-10-14T12:00:00.000Z",
  version: 1,
});

const CONFIGURATION = {
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

// ---- the lab: the device's collections, a seeded catalog ----------------------------------------------------

async function openProductsLab(page: Page, stored = "claro") {
  await page.addInitScript((theme) => {
    window.localStorage.setItem("polaris-tema", theme);
  }, stored);
  await page.route("**/rpc/product/getVariants", (route) =>
    route.fulfill(rpc(CONFIGURATION))
  );
  await serveLabWorker(page);
  await page.goto("/offline-screens-lab?screen=products&catalog=seeded");
  await page.getByLabel("Usuário").fill(`user-${crypto.randomUUID()}`);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await expect(page.getByTestId("message")).toContainText(
    "Iniciar: ok (ready)",
    { timeout: 20_000 }
  );
  await expect(
    page.getByRole("heading", { exact: true, name: "Produtos" })
  ).toBeVisible();
  await expect(page.getByText("Calça jeans")).toBeVisible();
}

const menuOf = (page: Page, name: string) =>
  page.getByRole("button", { name: `Mais ações para ${name}` });

async function useEveryControl(page: Page) {
  // the menu of a row, and the form of an edit with its category
  await menuOf(page, "Camiseta do teste").click();
  await expect(page.getByRole("menuitem", { name: "Imagens" })).toBeVisible();
  await page.getByRole("menuitem", { exact: true, name: "Editar" }).click();
  const name = page.getByLabel("Nome do produto");
  await expect(name).toHaveValue("Camiseta do teste");
  await expect(name).toBeFocused();
  const category = page.getByRole("combobox", {
    exact: true,
    name: "Categoria",
  });
  await expect(category).toContainText("Roupas");
  await category.click();
  await page.getByRole("option", { exact: true, name: "Acessórios" }).click();
  await expect(category).toContainText("Acessórios");
  await page.getByLabel("Descrição").fill("Algodão, corte reto, azul.");
  await page.getByRole("button", { name: "Cancelar" }).click();
  // closing the form gives the focus back to the menu of the product that was edited
  await expect(menuOf(page, "Camiseta do teste")).toBeFocused();

  // the variants: the options, the values and a combination
  await menuOf(page, "Camiseta do teste").click();
  await page.getByRole("menuitem", { name: "Variantes" }).click();
  // the panel opens away from the row: the focus goes to the block that names the product
  await expect(
    page.locator(":focus").filter({
      has: page.getByRole("heading", { level: 2, name: "Camiseta do teste" }),
    })
  ).toHaveCount(1);
  await page.getByRole("checkbox", { name: "Cor" }).click();
  await page.getByLabel("Valores de Cor").fill("Azul\nPreta");
  await page.getByRole("button", { name: "Adicionar combinação" }).click();
  const color = page.getByRole("combobox", { exact: true, name: "Cor" });
  await color.click();
  await page.getByRole("option", { exact: true, name: "Azul" }).click();
  await expect(color).toContainText("Azul");
  await page.getByRole("button", { name: "Remover combinação 1" }).click();
  await page.getByRole("button", { name: "Fechar" }).click();
  await expect(menuOf(page, "Camiseta do teste")).toBeFocused();

  // the search and the archived list
  await page.getByLabel("Buscar produto").fill("CALCA");
  await expect(page.getByText("Calça jeans")).toBeVisible();
  await expect(page.getByText("Boné aba reta")).toHaveCount(0);
  await page.getByLabel("Buscar produto").fill("");
  await page.getByRole("button", { name: "Arquivados" }).click();
  await expect(page.getByText("Jaqueta de inverno")).toBeVisible();
  await expect(page.getByRole("button", { name: "Novo produto" })).toHaveCount(
    0
  );
}

/**
 * The two projects of the config differ by the pointer and the viewport only, and the CI job that runs them has a
 * limit of 30 minutes: what is about the policy of the page or sets its own width runs once, on the desktop one.
 */
const onlyDesktop = (projectName: string) =>
  test.skip(
    projectName.includes("mobile"),
    "same page, set by the test itself"
  );

for (const theme of THEMES) {
  test(`tema ${theme.name}: Produtos abre e cada controle muda de estado sob a CSP de produção sem nenhuma violação`, async ({
    page,
  }, testInfo) => {
    onlyDesktop(testInfo.project.name);
    // the policy really is the strict one: no inline style may slip through
    expect(productionPolicy).toContain("style-src 'self'");
    expect(productionPolicy).not.toContain("unsafe-inline");
    await serveUnderProductionCsp(page);
    const csp = await watchCspViolations(page);
    await openProductsLab(page, theme.stored);
    await expect(page.locator("html")).toHaveClass(
      theme.dark ? DARK : NOT_DARK
    );
    await useEveryControl(page);
    expect(csp.violations()).toEqual([]);
  });
}

/** No box of the screen ends beyond the right edge of the window (the page may hide it, so boxes are measured). */
async function expectNoSidewaysScroll(page: Page) {
  const found = await page.evaluate(() => {
    const root = document.querySelector(".products-page [data-ui]");
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
  // nothing passes vacuously: the screen is there and was measured
  expect(found.measured).toBeGreaterThan(30);
  expect(found.past).toEqual([]);
}

test("a 320 px nada transborda: a lista, o formulário com erro, as variantes e a pendência sem conexão", async ({
  page,
}, testInfo) => {
  onlyDesktop(testInfo.project.name);
  await page.setViewportSize({ height: 740, width: 320 });
  await openProductsLab(page);
  await expectNoSidewaysScroll(page);

  await page.getByRole("button", { name: "Novo produto" }).first().click();
  await page.getByRole("button", { name: "Cadastrar produto" }).click();
  await expect(page.getByText("Informe o nome do produto.")).toBeVisible();
  await expectNoSidewaysScroll(page);
  await page.getByRole("button", { name: "Cancelar" }).click();

  await menuOf(page, "Camiseta do teste").click();
  await page.getByRole("menuitem", { name: "Variantes" }).click();
  await page.getByRole("checkbox", { name: "Cor" }).click();
  await page.getByLabel("Valores de Cor").fill("Azul\nPreta");
  await page.getByRole("button", { name: "Adicionar combinação" }).click();
  await expectNoSidewaysScroll(page);
  await page.getByRole("button", { name: "Fechar" }).click();

  await page.getByLabel("Rede disponível").uncheck();
  await page.getByRole("button", { name: "Novo produto" }).first().click();
  await page
    .getByLabel("Nome do produto")
    .fill(
      "Cinto de couro legítimo com fivela dourada, tamanho único ajustável"
    );
  await page.getByRole("button", { name: "Cadastrar produto" }).click();
  await expect(page.getByText("Aguardando envio")).toBeVisible();
  await expectNoSidewaysScroll(page);
});

// ---- the real route, with the API answered here ---------------------------------------------------------------

interface ServerOptions {
  /** One answer per call of `product/list`, in order; the last one repeats. */
  lists: ReadonlyArray<(route: Route) => Promise<void>>;
  others?: Record<string, (route: Route) => Promise<void>>;
}

async function openServerScreen(page: Page, { lists, others }: ServerOptions) {
  let calls = 0;
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      body: JSON.stringify({ session: { id: "s" }, user: { id: "u" } }),
      headers: { ...WORKER_MARK },
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
    if (procedure === "category/list") {
      return route.fulfill(rpc({ categories: [] }));
    }
    if (procedure === "product/list") {
      const answer = lists[Math.min(calls, lists.length - 1)];
      calls += 1;
      return answer ? answer(route) : route.abort("internetdisconnected");
    }
    const handler = others?.[procedure];
    return handler ? handler(route) : route.abort("internetdisconnected");
  });
  await page.goto("/products");
  await expect(
    page.getByRole("heading", { exact: true, name: "Produtos" })
  ).toBeVisible();
}

const answer = (products: unknown[]) => (route: Route) =>
  route.fulfill(rpc({ products }));

test("a lista que não carrega diz o motivo, oferece 'Tentar novamente' e some quando a leitura dá certo", async ({
  page,
}) => {
  await openServerScreen(page, {
    lists: [
      (route) => route.fulfill(unavailable),
      answer([product(1, "Camiseta do teste")]),
    ],
  });
  const alert = page.getByRole("alert");
  await expect(alert).toContainText(
    "O catálogo está temporariamente indisponível."
  );
  // an error is not an empty catalog
  await expect(page.getByText("Nenhum produto ainda")).toHaveCount(0);
  await alert.getByRole("button", { name: "Tentar novamente" }).click();
  await expect(page.getByText("Camiseta do teste")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("sem produto, a tela convida a cadastrar o primeiro, e o botão abre o formulário com o cursor no nome", async ({
  page,
}) => {
  await openServerScreen(page, { lists: [answer([])] });
  await expect(
    page.getByText("Cadastre o primeiro para vender.")
  ).toBeVisible();
  await page.getByRole("button", { name: "Novo produto" }).last().click();
  await expect(page.getByLabel("Nome do produto")).toBeFocused();
});

test("o campo de busca da tela não herda a borda nem a altura do CSS antigo do shell (.ui-root input)", async ({
  page,
}) => {
  await openServerScreen(page, { lists: [answer([])] });
  const style = await page.getByLabel("Buscar produto").evaluate((node) => {
    const computed = getComputedStyle(node);
    return {
      border: computed.borderTopWidth,
      minHeight: computed.minHeight,
    };
  });
  // the field says nothing about its border or min-height: no border, and the browser's `auto` (the old shell gave it 2.8rem)
  expect(style).toEqual({ border: "0px", minHeight: "auto" });
});

test("a busca ignora maiúsculas e acentos, diz quando nada casa e o número acompanha", async ({
  page,
}) => {
  await openServerScreen(page, {
    lists: [
      answer([
        product(1, "Camiseta do teste"),
        product(2, "Calça jeans"),
        product(3, "Boné aba reta"),
      ]),
    ],
  });
  await expect(page.getByText("3 produtos")).toBeVisible();
  const search = page.getByLabel("Buscar produto");
  await search.fill("CALCA");
  await expect(page.getByText("Calça jeans")).toBeVisible();
  await expect(page.getByText("Camiseta do teste")).toHaveCount(0);
  await expect(page.getByText("1 de 3")).toBeVisible();
  await search.fill("tenis");
  await expect(page.getByText("Nenhum produto com “tenis”.")).toBeVisible();
  await search.fill("");
  await expect(page.getByText("3 produtos")).toBeVisible();
});

test("o nome é obrigatório: o erro fica no campo, o foco volta a ele e nada é enviado", async ({
  page,
}) => {
  let created = 0;
  await openServerScreen(page, {
    lists: [answer([])],
    others: {
      "product/create": (route) => {
        created += 1;
        return route.abort("internetdisconnected");
      },
    },
  });
  await page.getByRole("button", { name: "Novo produto" }).first().click();
  const name = page.getByLabel("Nome do produto");
  await name.fill("   ");
  await page.getByRole("button", { name: "Cadastrar produto" }).click();
  await expect(page.getByText("Informe o nome do produto.")).toBeVisible();
  await expect(name).toBeFocused();
  await expect(name).toHaveAttribute("aria-invalid", "true");
  expect(created).toBe(0);
});

test("cadastrar: o formulário fecha, o resultado é dito e recebe o foco, e a lista é lida de novo", async ({
  page,
}) => {
  const created = product(1, "Bolsa de couro");
  await openServerScreen(page, {
    lists: [answer([]), answer([created])],
    others: {
      "product/create": (route) => route.fulfill(rpc(created)),
    },
  });
  await page.getByRole("button", { name: "Novo produto" }).first().click();
  await page.getByLabel("Nome do produto").fill("Bolsa de couro");
  await page.getByRole("button", { name: "Cadastrar produto" }).click();
  const notice = page.getByText("Produto “Bolsa de couro” cadastrado.");
  await expect(notice).toBeVisible();
  await expect(page.locator(":focus").filter({ has: notice })).toHaveCount(1);
  await expect(page.getByLabel("Nome do produto")).toHaveCount(0);
  await expect(page.locator("[data-product-id]")).toContainText(
    "Bolsa de couro"
  );
});

test("arquivar pelo menu: 'Arquivando…' na linha, o resultado dito e focado e a lista lida de novo", async ({
  page,
}) => {
  const shirt = product(1, "Camiseta do teste");
  let releaseArchive: () => void = () => undefined;
  const archiveCanAnswer = new Promise<void>((resolve) => {
    releaseArchive = resolve;
  });
  await openServerScreen(page, {
    lists: [answer([shirt]), answer([])],
    others: {
      "product/archive": async (route) => {
        await archiveCanAnswer;
        return route.fulfill(
          rpc({
            changed: true,
            product: { ...shirt, status: "archived", version: 2 },
          })
        );
      },
    },
  });
  await menuOf(page, "Camiseta do teste").click();
  await page.getByRole("menuitem", { name: "Arquivar" }).click();
  await expect(page.locator("[data-product-id]")).toContainText("Arquivando…");
  await expect(menuOf(page, "Camiseta do teste")).toBeDisabled();
  releaseArchive();
  const notice = page.getByText("Produto “Camiseta do teste” arquivado.");
  await expect(notice).toBeVisible();
  await expect(page.locator(":focus").filter({ has: notice })).toHaveCount(1);
  await expect(page.getByText("Nenhum produto ainda")).toBeVisible();
});

test("desfazer o arquivamento restaura o produto pela mesma chamada do Restaurar e o aviso do restaurado não tem botão", async ({
  page,
}) => {
  const shirt = product(1, "Camiseta do teste");
  const archived = { ...shirt, status: "archived", version: 2 };
  let restored: unknown;
  await openServerScreen(page, {
    lists: [answer([shirt]), answer([]), answer([shirt])],
    others: {
      "product/archive": (route) =>
        route.fulfill(rpc({ changed: true, product: archived })),
      "product/restore": (route) => {
        restored = (route.request().postDataJSON() as { json: unknown }).json;
        return route.fulfill(
          rpc({
            changed: true,
            product: { ...shirt, status: "active", version: 3 },
          })
        );
      },
    },
  });
  await menuOf(page, "Camiseta do teste").click();
  await page.getByRole("menuitem", { name: "Arquivar" }).click();
  await expect(
    page.getByText("Produto “Camiseta do teste” arquivado.")
  ).toBeVisible();
  await page.getByRole("button", { name: "Desfazer" }).click();
  await expect(
    page.getByText("Produto “Camiseta do teste” restaurado.")
  ).toBeVisible();
  expect(restored).toMatchObject({
    expectedVersion: 2,
    id: shirt.id,
    organizationId: ORGANIZATION.id,
  });
  await expect(page.getByRole("button", { name: "Desfazer" })).toHaveCount(0);
  await expect(page.locator("[data-product-id]")).toContainText(
    "Camiseta do teste"
  );
});

test("o desfazer que o servidor recusa diz o erro e o botão continua para tentar de novo", async ({
  page,
}) => {
  const shirt = product(1, "Camiseta do teste");
  let restores = 0;
  await openServerScreen(page, {
    lists: [answer([shirt]), answer([]), answer([]), answer([shirt])],
    others: {
      "product/archive": (route) =>
        route.fulfill(
          rpc({
            changed: true,
            product: { ...shirt, status: "archived", version: 2 },
          })
        ),
      "product/restore": (route) => {
        restores += 1;
        return restores === 1
          ? route.fulfill(unavailable)
          : route.fulfill(
              rpc({
                changed: true,
                product: { ...shirt, status: "active", version: 3 },
              })
            );
      },
    },
  });
  await menuOf(page, "Camiseta do teste").click();
  await page.getByRole("menuitem", { name: "Arquivar" }).click();
  await page.getByRole("button", { name: "Desfazer" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "O catálogo está temporariamente indisponível."
  );
  const undo = page.getByRole("button", { name: "Desfazer" });
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(
    page.getByText("Produto “Camiseta do teste” restaurado.")
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Desfazer" })).toHaveCount(0);
});

test("arquivar que o servidor recusa: o erro é dito e focado e a linha continua na lista", async ({
  page,
}) => {
  await openServerScreen(page, {
    lists: [answer([product(1, "Camiseta do teste")])],
    others: { "product/archive": (route) => route.fulfill(unavailable) },
  });
  await menuOf(page, "Camiseta do teste").click();
  await page.getByRole("menuitem", { name: "Arquivar" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText(
    "O catálogo está temporariamente indisponível."
  );
  await expect(page.locator(":focus").filter({ has: alert })).toHaveCount(1);
  await expect(page.locator("[data-product-id]")).toContainText(
    "Camiseta do teste"
  );
  // the menu is back for another try
  await expect(menuOf(page, "Camiseta do teste")).toBeEnabled();
});

test("editar: o formulário abre com os dados, salva pelo servidor com a versão lida e diz o resultado", async ({
  page,
}) => {
  const shirt = { ...product(1, "Camiseta do teste"), description: "Azul" };
  let sent: unknown;
  await openServerScreen(page, {
    lists: [answer([shirt])],
    others: {
      "product/update": (route) => {
        sent = (route.request().postDataJSON() as { json: unknown }).json;
        return route.fulfill(
          rpc({
            changed: true,
            product: { ...shirt, name: "Camiseta nova", version: 2 },
          })
        );
      },
    },
  });
  await menuOf(page, "Camiseta do teste").click();
  await page.getByRole("menuitem", { exact: true, name: "Editar" }).click();
  await expect(page.getByLabel("Descrição")).toHaveValue("Azul");
  await page.getByLabel("Nome do produto").fill("Camiseta nova");
  await page.getByRole("button", { name: "Salvar alterações" }).click();
  await expect(
    page.getByText("Produto “Camiseta nova” atualizado.")
  ).toBeVisible();
  expect(sent).toMatchObject({
    categoryId: null,
    description: "Azul",
    expectedVersion: 1,
    id: shirt.id,
    name: "Camiseta nova",
  });
  await expect(page.getByLabel("Nome do produto")).toHaveCount(0);
});

test("restaurar pelo menu de um produto arquivado diz o resultado", async ({
  page,
}) => {
  const jacket = product(1, "Jaqueta de inverno", "archived");
  await openServerScreen(page, {
    lists: [answer([]), answer([jacket]), answer([])],
    others: {
      "product/restore": (route) =>
        route.fulfill(
          rpc({ changed: true, product: { ...jacket, status: "active" } })
        ),
    },
  });
  await page.getByRole("button", { name: "Arquivados" }).click();
  await menuOf(page, "Jaqueta de inverno").click();
  await page.getByRole("menuitem", { name: "Restaurar" }).click();
  await expect(
    page.getByText("Produto “Jaqueta de inverno” restaurado.")
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Desfazer" })).toHaveCount(0);
});

test("o menu de um produto arquivado tem Restaurar e não tem Imagens nem Arquivar", async ({
  page,
}) => {
  await openServerScreen(page, {
    lists: [answer([product(1, "Jaqueta de inverno", "archived")])],
  });
  await page.getByRole("button", { name: "Arquivados" }).click();
  await menuOf(page, "Jaqueta de inverno").click();
  await expect(page.getByRole("menuitem", { name: "Restaurar" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Variantes" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Imagens" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Arquivar" })).toHaveCount(0);
});

test("SKU repetido: o erro aparece no campo, diz qual SKU e não se confunde com o produto que mudou (U-14)", async ({
  page,
}) => {
  let skuAnswer: "duplicate" | "version" = "duplicate";
  await openServerScreen(page, {
    lists: [answer([product(1, "Camiseta do teste")])],
    others: {
      "product/getVariants": (route) => route.fulfill(rpc(CONFIGURATION)),
      "product/setVariantSku": (route) =>
        route.fulfill(
          rpc(
            {
              code: "CONFLICT",
              data: {
                reason:
                  skuAnswer === "duplicate"
                    ? "duplicate_sku"
                    : "product_version_conflict",
              },
              defined: true,
              message: "Conflict",
              status: 409,
            },
            409
          )
        ),
    },
  });
  await menuOf(page, "Camiseta do teste").click();
  await page.getByRole("menuitem", { name: "Variantes" }).click();
  const skuSection = page.getByRole("region", { name: "SKU das variantes" });
  const field = skuSection.getByRole("textbox");
  await field.fill("CAM-001");
  await skuSection.getByRole("button", { name: "Salvar SKU" }).click();

  // at the field, naming the SKU, tied to it; no alert at the end of the section and no "Atualizar variantes"
  const message =
    "O SKU CAM-001 já está em uso por outra variante. Use outro código.";
  await expect(skuSection.getByText(message)).toBeVisible();
  await expect(field).toHaveAttribute("aria-invalid", "true");
  const describedBy = await field.getAttribute("aria-describedby");
  await expect(page.locator(`[id="${describedBy}"]`)).toHaveText(message);
  await expect(field).toHaveValue("CAM-001");
  // the focus goes to the field of the variant that was refused (P-6), not to a block around it
  await expect(field).toBeFocused();
  await expect(
    skuSection.getByRole("button", { name: "Atualizar variantes" })
  ).toHaveCount(0);

  // typing another code takes the message away
  await field.fill("CAM-002");
  await expect(skuSection.getByText(message)).toHaveCount(0);
  await expect(field).not.toHaveAttribute("aria-invalid", "true");

  // a product that changed is another message, with its way out
  skuAnswer = "version";
  await skuSection.getByRole("button", { name: "Salvar SKU" }).click();
  await expect(skuSection.getByRole("alert")).toContainText(
    "O produto mudou. Atualize as variantes"
  );
  await expect(
    skuSection.getByRole("button", { name: "Atualizar variantes" })
  ).toBeVisible();
});

test("variantes: o aviso do SKU só com opção marcada, linhas vazias não são repetidas, e os rótulos e o exemplo do preço cabem em 360 px", async ({
  page,
}, testInfo) => {
  onlyDesktop(testInfo.project.name);
  await page.setViewportSize({ height: 740, width: 360 });
  await openServerScreen(page, {
    lists: [answer([product(1, "Camiseta do teste")])],
    others: {
      "product/getVariants": (route) =>
        route.fulfill(
          rpc({
            ...CONFIGURATION,
            variants: [{ ...CONFIGURATION.variants[0], sku: "CAM-1" }],
          })
        ),
    },
  });
  await menuOf(page, "Camiseta do teste").click();
  await page.getByRole("menuitem", { name: "Variantes" }).click();

  // P-11 and P-8: the label has a middle dot, and the example of the price is short
  const skuSection = page.getByRole("region", { name: "SKU das variantes" });
  await expect(
    skuSection.getByRole("textbox", { name: "SKU · Variante padrão" })
  ).toHaveValue("CAM-1");
  const priceSection = page.getByRole("region", {
    name: "Preço de tabela das variantes",
  });
  await expect(
    priceSection.getByRole("textbox", {
      name: "Preço de tabela · Variante padrão",
    })
  ).toHaveAttribute("placeholder", "Ex.: 49,90");

  // P-7: the default variant has a SKU, but nobody asked for options yet: no warning
  const warning = page.getByText("Limpe o SKU da variante padrão");
  await expect(warning).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Cor" }).click();
  await expect(warning).toBeVisible();

  // P-5: two rows that still have no color are not a repeated combination
  const repeated = page.getByText("Cada combinação precisa ser única.");
  await page.getByLabel("Valores de Cor").fill("Azul\nPreta");
  await page.getByRole("button", { name: "Adicionar combinação" }).click();
  await page.getByRole("button", { name: "Adicionar combinação" }).click();
  await expect(page.getByText("Combinação 2")).toBeVisible();
  await expect(repeated).toHaveCount(0);
  // the same color in both is
  const colors = page.getByRole("combobox", { exact: true, name: "Cor" });
  await colors.nth(0).click();
  await page.getByRole("option", { exact: true, name: "Azul" }).click();
  await page.getByRole("listbox").waitFor({ state: "detached" });
  await colors.nth(1).click();
  await page.getByRole("option", { exact: true, name: "Azul" }).click();
  await expect(repeated).toBeVisible();
});

test("o erro de 'Salvar SKU' e de 'Salvar preço' é um alerta com texto e ícone; o sucesso é status e o conflito oferece 'Atualizar variantes'", async ({
  page,
}) => {
  let skuAnswer: "conflict" | "ok" | "unavailable" = "unavailable";
  await openServerScreen(page, {
    lists: [answer([product(1, "Camiseta do teste")])],
    others: {
      "product/getVariants": (route) => route.fulfill(rpc(CONFIGURATION)),
      "product/setVariantListPrice": (route) => route.fulfill(unavailable),
      "product/setVariantSku": (route) => {
        if (skuAnswer === "ok") {
          return route.fulfill(
            rpc({
              changed: true,
              configuration: {
                ...CONFIGURATION,
                variants: [{ ...CONFIGURATION.variants[0], sku: "CAM-1" }],
              },
              product: product(1, "Camiseta do teste"),
            })
          );
        }
        return route.fulfill(
          skuAnswer === "conflict"
            ? rpc(
                {
                  code: "CONFLICT",
                  data: undefined,
                  defined: false,
                  message: "Conflict",
                  status: 409,
                },
                409
              )
            : unavailable
        );
      },
    },
  });
  await menuOf(page, "Camiseta do teste").click();
  await page.getByRole("menuitem", { name: "Variantes" }).click();
  const skuSection = page.getByRole("region", { name: "SKU das variantes" });
  await skuSection.getByRole("textbox").fill("CAM-1");
  await skuSection.getByRole("button", { name: "Salvar SKU" }).click();
  const skuAlert = skuSection.getByRole("alert");
  await expect(skuAlert).toContainText(
    "O catálogo está temporariamente indisponível."
  );
  await expect(skuAlert.locator("svg")).toHaveCount(1);
  await expect(skuSection.getByRole("status")).toHaveCount(0);

  const priceSection = page.getByRole("region", {
    name: "Preço de tabela das variantes",
  });
  await priceSection.getByRole("textbox").fill("59,90");
  await priceSection.getByRole("button", { name: "Salvar preço" }).click();
  await expect(priceSection.getByRole("alert")).toContainText(
    "Não foi possível salvar o preço."
  );
  await expect(priceSection.getByRole("alert").locator("svg")).toHaveCount(1);

  skuAnswer = "conflict";
  await skuSection.getByRole("button", { name: "Salvar SKU" }).click();
  await expect(
    skuSection.getByRole("button", { name: "Atualizar variantes" })
  ).toBeVisible();

  skuAnswer = "ok";
  await skuSection.getByRole("button", { name: "Salvar SKU" }).click();
  await expect(skuSection.getByRole("status")).toHaveText("SKU salvo.");
  await expect(skuSection.getByRole("alert")).toHaveCount(0);
});
