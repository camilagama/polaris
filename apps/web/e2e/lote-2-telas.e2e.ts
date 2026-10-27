/// <reference lib="dom" />
import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  expectFormDialogLayout,
  expectKeyboardKeepsMainButton,
  FORM_WIDTHS,
  sizeFor,
} from "./form-dialog-checks";
import { activateByKeyboard, expectFocusRing } from "./focus-ring";
import { expectTabsKeyboard } from "./tabs-keyboard";
import { serveHealth, WORKER_MARK } from "./worker-mark";

/**
 * Categorias, Clientes and the public catalog of the ERP on the interface v5.1 (t235, lot 2 of the migration): the
 * real route, with the API answered by the test (the server mode, no offline runtime). What the lab of the screens
 * already proves for Clientes and for the catalog is in `offline-screens.e2e.ts` and `usabilidade-lote-1.e2e.ts`; here
 * is Categorias (the whole screen), the strip of the screens that need a connection (U-54), the states a server
 * answer makes, and the focus after each action.
 */
const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const id = (n: number) => `0199c2d0-0000-7000-8000-0000000000${n}`;
const DAY = "2026-10-14T12:00:00.000Z";

const rpc = (json: unknown, status = 200) => ({
  body: JSON.stringify({ json, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
  status,
});
const refusal = (code: string, status: number) =>
  rpc({ code, data: undefined, defined: false, message: code, status }, status);
const unavailable = refusal("SERVICE_UNAVAILABLE", 503);

type Handler = (route: Route) => Promise<void>;
const reply =
  (json: unknown): Handler =>
  (route) =>
    route.fulfill(rpc(json));

/** The app as someone signed in sees it, with one answer per procedure; what has none is a network that failed. */
/** The addresses of the screens that became tabs (map of navigation, § 6). */
const TAB_PATHS = ["/categories", "/public-catalog"];

async function openScreen(
  page: Page,
  path: string,
  heading: string,
  answers: Record<string, Handler>
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
    const handler = answers[procedure];
    return handler ? handler(route) : route.abort("internetdisconnected");
  });
  await page.goto(path);
  // Categorias and Catálogo público are tabs now (of Produtos and of Configurações): their title is an h2 there
  const level = TAB_PATHS.includes(path) ? 2 : 1;
  await expect(
    page.getByRole("heading", { exact: true, level, name: heading })
  ).toBeVisible();
}

const STRIP = "Esta tela precisa de conexão.";
const PLAN_NOTICE = /faz parte do plano Pro/;
const SIDEWAYS = 1;

/** Nothing past the window, sideways: the page does not scroll and no element's right edge is beyond it. */
async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThan(SIDEWAYS);
}

// ---- Categorias -----------------------------------------------------------------------------------------------

const category = (n: number, name: string, status = "active") => ({
  archivedAt: status === "archived" ? DAY : null,
  createdAt: DAY,
  deletedAt: status === "deleted" ? DAY : null,
  id: id(40 + n),
  name,
  organizationId: ORGANIZATION.id,
  status,
  updatedAt: DAY,
});

/** `category/list` answers by the status the screen asks for. */
const listByStatus =
  (rows: Record<string, unknown[]>): Handler =>
  (route) => {
    const { json } = route.request().postDataJSON() as {
      json: { status: string };
    };
    return route.fulfill(rpc({ categories: rows[json.status] ?? [] }));
  };

const menuOf = (page: Page, name: string) =>
  page.getByRole("button", { name: `Mais ações para ${name}` });

test("Categorias: a lista, o selo de estado com texto e a falta de código na tela", async ({
  page,
}) => {
  await openScreen(page, "/categories", "Categorias", {
    "category/list": reply({
      categories: [category(1, "Camisetas"), category(2, "Calçados")],
    }),
  });
  const row = page.locator("[data-category-id]", { hasText: "Camisetas" });
  await expect(row).toContainText("Ativa");
  await expect(row).toContainText("Atualizada em");
  await expect(row).not.toContainText(id(41).slice(0, 8));
  await expect(page.getByText(STRIP)).toHaveCount(0);
});

test("Categorias sem internet: a faixa diz que a tela precisa de conexão, o que foi digitado fica e ela some ao voltar (U-54)", async ({
  page,
}) => {
  await openScreen(page, "/categories", "Categorias", {
    "category/list": reply({ categories: [category(1, "Camisetas")] }),
  });
  await page.getByLabel("Nova categoria").fill("Acessórios");
  await page.context().setOffline(true);
  const strip = page.getByRole("status").filter({ hasText: "Sem internet." });
  await expect(strip).toContainText(STRIP);
  await expect(strip).toContainText("O que você digitou fica aqui");
  await expect(page.getByLabel("Nova categoria")).toHaveValue("Acessórios");
  await page.context().setOffline(false);
  await expect(page.getByText(STRIP)).toHaveCount(0);
  await expect(page.getByLabel("Nova categoria")).toHaveValue("Acessórios");
});

test("Categorias: a lista que não carrega diz o motivo, não é uma lista vazia e 'Tentar novamente' lê de novo", async ({
  page,
}) => {
  let reads = 0;
  await openScreen(page, "/categories", "Categorias", {
    "category/list": (route) => {
      reads += 1;
      return reads === 1
        ? route.fulfill(unavailable)
        : route.fulfill(rpc({ categories: [category(1, "Camisetas")] }));
    },
  });
  const alert = page.getByRole("alert");
  await expect(alert).toContainText(
    "O catálogo está temporariamente indisponível."
  );
  await expect(page.getByText("Nenhuma categoria ativa.")).toHaveCount(0);
  await alert.getByRole("button", { name: "Tentar novamente" }).click();
  await expect(page.getByText("Camisetas")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("Categorias: criar deixa o cursor no campo, que se esvazia, e diz o resultado; sem nome o campo diz o que falta", async ({
  page,
}) => {
  const created: unknown[] = [];
  await openScreen(page, "/categories", "Categorias", {
    "category/create": (route) => {
      created.push((route.request().postDataJSON() as { json: unknown }).json);
      return route.fulfill(rpc(category(3, "Acessórios")));
    },
    "category/list": reply({ categories: [] }),
  });
  const field = page.getByLabel("Nova categoria");
  await page.getByRole("button", { name: "Adicionar categoria" }).click();
  await expect(page.getByText("Informe o nome da categoria.")).toBeVisible();
  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute("aria-invalid", "true");
  expect(created).toEqual([]);

  await field.fill("Acessórios");
  await expect(page.getByText("Informe o nome da categoria.")).toHaveCount(0);
  await field.press("Enter");
  await expect(page.getByText("Categoria “Acessórios” criada.")).toBeVisible();
  expect(created).toEqual([
    { name: "Acessórios", organizationId: ORGANIZATION.id },
  ]);
  await expect(field).toHaveValue("");
  await expect(field).toBeFocused();
});

test("Categorias: nome repetido é dito junto do campo de cima e o que foi digitado fica", async ({
  page,
}) => {
  await openScreen(page, "/categories", "Categorias", {
    "category/create": (route) => route.fulfill(refusal("CONFLICT", 409)),
    "category/list": reply({ categories: [category(1, "Camisetas")] }),
  });
  await page.getByLabel("Nova categoria").fill("Camisetas");
  await page.getByRole("button", { name: "Adicionar categoria" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Já existe uma categoria com esse nome nesta loja."
  );
  await expect(page.getByLabel("Nova categoria")).toHaveValue("Camisetas");
});

test("Categorias: renomear na própria linha leva o cursor ao campo, 'Cancelar' volta ao menu e Enter salva", async ({
  page,
}) => {
  const renamed: unknown[] = [];
  await openScreen(page, "/categories", "Categorias", {
    "category/list": reply({ categories: [category(1, "Camisetas")] }),
    "category/rename": (route) => {
      renamed.push((route.request().postDataJSON() as { json: unknown }).json);
      return route.fulfill(
        rpc({ category: category(1, "Camisetas de algodão"), changed: true })
      );
    },
  });
  await menuOf(page, "Camisetas").click();
  await page.getByRole("menuitem", { exact: true, name: "Renomear" }).click();
  const field = page.getByLabel("Novo nome para Camisetas");
  await expect(field).toHaveValue("Camisetas");
  await expect(field).toBeFocused();
  await expect(page.getByText("9/100 caracteres")).toBeVisible();

  await field.fill("Camisetas de algodão");
  await field.press("Enter");
  const notice = page.getByText(
    "Categoria renomeada para “Camisetas de algodão”."
  );
  await expect(notice).toBeVisible();
  // the row that had the field is gone: the focus goes to what was done
  await expect(page.locator(":focus").filter({ has: notice })).toHaveCount(1);
  expect(renamed).toEqual([
    {
      id: id(41),
      name: "Camisetas de algodão",
      organizationId: ORGANIZATION.id,
    },
  ]);
});

test("Categorias: o nome passa de 100 caracteres, o campo diz quantos e nada é enviado", async ({
  page,
}) => {
  await openScreen(page, "/categories", "Categorias", {
    "category/list": reply({ categories: [] }),
  });
  await page.getByLabel("Nova categoria").fill("a".repeat(101));
  await expect(
    page.getByText("Limite de 100 caracteres excedido (101).")
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Adicionar categoria" })
  ).toBeDisabled();
});

test("Categorias: remover pede confirmação na linha, 'Cancelar' desiste e confirmar remove dizendo o que fica", async ({
  page,
}) => {
  const removed: unknown[] = [];
  await openScreen(page, "/categories", "Categorias", {
    "category/delete": (route) => {
      removed.push((route.request().postDataJSON() as { json: unknown }).json);
      return route.fulfill(
        rpc({ category: category(1, "Camisetas", "deleted"), changed: true })
      );
    },
    "category/list": listByStatus({
      active: [category(1, "Camisetas")],
      deleted: [category(1, "Camisetas", "deleted")],
    }),
  });
  await menuOf(page, "Camisetas").click();
  await activateByKeyboard(
    page,
    page.getByRole("menuitem", { exact: true, name: "Remover" })
  );
  const confirmation = page.getByRole("group", {
    name: "Confirmar remoção de Camisetas",
  });
  // the confirmation of the row takes the focus, and the keyboard sees it (t439)
  await expectFocusRing(confirmation);
  await expect(confirmation).toContainText(
    "O histórico de vendas continua igual."
  );
  await confirmation.getByRole("button", { name: "Cancelar" }).click();
  await expect(confirmation).toHaveCount(0);
  expect(removed).toEqual([]);

  await menuOf(page, "Camisetas").click();
  await page.getByRole("menuitem", { exact: true, name: "Remover" }).click();
  await page.getByRole("button", { name: "Remover categoria" }).click();
  await expect(page.getByText("Categoria “Camisetas” removida;")).toBeVisible();
  expect(removed).toHaveLength(1);

  // a removed category is only read: no menu, and the reason in words
  await page.getByRole("tab", { name: "Removidas" }).click();
  await expect(page.getByText("não pode ser restaurada")).toBeVisible();
  await expect(menuOf(page, "Camisetas")).toHaveCount(0);
});

test("Categorias: arquivar pelo menu diz o resultado e a aba de arquivadas oferece Restaurar", async ({
  page,
}) => {
  await openScreen(page, "/categories", "Categorias", {
    "category/archive": reply({
      category: category(1, "Camisetas", "archived"),
      changed: true,
    }),
    "category/list": listByStatus({
      active: [category(1, "Camisetas")],
      archived: [category(1, "Camisetas", "archived")],
    }),
  });
  await menuOf(page, "Camisetas").click();
  await page.getByRole("menuitem", { exact: true, name: "Arquivar" }).click();
  await expect(
    page.getByText("Categoria “Camisetas” arquivada.")
  ).toBeVisible();

  await page.getByRole("tab", { name: "Arquivadas" }).click();
  const row = page.locator("[data-category-id]", { hasText: "Camisetas" });
  await expect(row).toContainText("Arquivada");
  await menuOf(page, "Camisetas").click();
  await expect(
    page.getByRole("menuitem", { exact: true, name: "Restaurar" })
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { exact: true, name: "Arquivar" })
  ).toHaveCount(0);
});

test("Categorias: as abas de estado têm setas, Tab sai do grupo e o leitor de tela lê aba selecionada", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium-desktop",
    "o teclado é o do desktop"
  );
  await openScreen(page, "/categories", "Categorias", {
    "category/list": listByStatus({
      active: [category(1, "Camisetas")],
      archived: [category(2, "Calçados", "archived")],
    }),
  });
  await expectTabsKeyboard(page, "Estado das categorias", [
    "Ativas",
    "Arquivadas",
  ]);
  // the tabs of the state, inside the tab Categorias of Produtos
  await expect(
    page
      .getByRole("tablist", { name: "Estado das categorias" })
      .getByRole("tab")
  ).toHaveText(["Ativas", "Arquivadas", "Removidas"]);
});

test("Categorias a 320 px: nada transborda na lista, na confirmação de remover e no nome longo", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop", "uma largura basta");
  await page.setViewportSize({ height: 740, width: 320 });
  await openScreen(page, "/categories", "Categorias", {
    "category/list": reply({
      categories: [
        category(
          1,
          "Acessórios para o verão com um nome bem longo que precisa quebrar sem estourar"
        ),
      ],
    }),
  });
  await expectNoSidewaysScroll(page);
  await menuOf(page, "Acessórios").click();
  await page.getByRole("menuitem", { exact: true, name: "Remover" }).click();
  await expect(page.getByRole("group")).toBeVisible();
  await expectNoSidewaysScroll(page);
});

// ---- Clientes -------------------------------------------------------------------------------------------------

const BRUNO_MENU = /Mais ações para Bruno/;

const customer = (n: number, name: string, extra: object = {}) => ({
  anonymizedAt: null,
  archivedAt: null,
  createdAt: DAY,
  email: null,
  id: id(60 + n),
  name,
  notes: null,
  organizationId: ORGANIZATION.id,
  phone: "11 91234-5678",
  status: "active",
  updatedAt: DAY,
  version: 1,
  ...extra,
});

test("Clientes: as abas de estado têm setas, Tab sai do grupo e o leitor de tela lê aba selecionada", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium-desktop",
    "o teclado é o do desktop"
  );
  await openScreen(page, "/customers", "Clientes", {
    "customer/findPossibleDuplicates": reply({ matches: [] }),
    "customer/list": reply({ customers: [] }),
  });
  await expectTabsKeyboard(page, "Estado dos clientes", [
    "Ativos",
    "Arquivados",
  ]);
});

test("Clientes: sem nome o campo diz o que falta, com o cursor nele, e nada é enviado", async ({
  page,
}) => {
  let looked = 0;
  await openScreen(page, "/customers", "Clientes", {
    "customer/findPossibleDuplicates": (route) => {
      looked += 1;
      return route.fulfill(rpc({ matches: [] }));
    },
    "customer/list": reply({ customers: [] }),
  });
  await page.getByRole("button", { name: "Novo cliente" }).click();
  await page.getByLabel("Telefone").fill("11900000001");
  await page.getByRole("button", { name: "Cadastrar cliente" }).click();
  await expect(page.getByText("Informe o nome do cliente.")).toBeVisible();
  await expect(page.getByLabel("Nome", { exact: true })).toBeFocused();
  await expect(page.getByLabel("Nome", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true"
  );
  expect(looked).toBe(0);
});

test("Clientes: cadastrar um cliente fecha o formulário, diz o resultado e o próximo abre vazio", async ({
  page,
}) => {
  await openScreen(page, "/customers", "Clientes", {
    "customer/create": reply(customer(2, "Bia Souza")),
    "customer/findPossibleDuplicates": reply({ matches: [] }),
    "customer/list": reply({ customers: [] }),
  });
  const name = page.getByLabel("Nome", { exact: true });
  await page.getByRole("button", { name: "Novo cliente" }).click();
  await name.fill("Bia Souza");
  await page.getByLabel("Telefone").fill("11900000002");
  await page.getByRole("button", { name: "Cadastrar cliente" }).click();
  const done = page
    .getByRole("status")
    .filter({ hasText: "Cliente “Bia Souza” cadastrado." });
  await expect(done).toBeVisible();
  // the form closed, and the focus is on the notice the person has to read
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(done.locator("xpath=..")).toBeFocused();
  // "Cadastrar outro" opens the next one, empty
  await done.getByRole("button", { name: "Cadastrar outro" }).click();
  await expect(name).toHaveValue("");
  await expect(name).toBeFocused();
});

for (const width of FORM_WIDTHS) {
  test(`Clientes a ${width} px: o formulário abre, cancela e salva na tela inteira do celular ou no diálogo central`, async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "a largura é a do teste"
    );
    await page.setViewportSize(sizeFor(width));
    let creates = 0;
    await openScreen(page, "/customers", "Clientes", {
      "customer/create": (route) => {
        creates += 1;
        return route.fulfill(rpc(customer(2, "Bia Souza")));
      },
      "customer/findPossibleDuplicates": reply({ matches: [] }),
      "customer/list": reply({ customers: [] }),
    });
    const openForm = page.getByRole("button", { name: "Novo cliente" });
    await openForm.click();
    const dialog = page.getByRole("dialog", { name: "Novo cliente" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Nome", { exact: true })).toBeFocused();
    await expectFormDialogLayout(dialog, width);

    // preenche, e no celular o teclado aberto não esconde o botão principal
    await dialog.getByLabel("Nome", { exact: true }).fill("Bia Souza");
    await dialog.getByLabel("Telefone").fill("11900000002");
    if (width < 760) {
      await expectKeyboardKeepsMainButton(
        page,
        dialog,
        dialog.getByRole("button", { name: "Cadastrar cliente" })
      );
    }

    // Esc guarda o rascunho (só em memória): o formulário fecha, o foco volta e o mesmo formulário o traz de volta
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(openForm).toBeFocused();
    await openForm.click();
    await expect(dialog.getByLabel("Nome", { exact: true })).toHaveValue(
      "Bia Souza"
    );

    // cancelar: nada é enviado, o formulário fecha, o foco volta ao botão que o abriu e o rascunho é descartado
    await dialog.getByRole("button", { exact: true, name: "Cancelar" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(openForm).toBeFocused();
    expect(creates).toBe(0);

    // o que foi digitado não fica para a próxima vez
    await openForm.click();
    await expect(dialog.getByLabel("Nome", { exact: true })).toHaveValue("");
    await dialog.getByLabel("Nome", { exact: true }).fill("Bia Souza");
    await dialog.getByLabel("Telefone").fill("11900000002");
    await dialog.getByRole("button", { name: "Cadastrar cliente" }).click();
    // o aviso diz o nome e oferece cadastrar outro
    const done = page
      .getByRole("status")
      .filter({ hasText: "Cliente “Bia Souza” cadastrado." });
    await expect(done).toBeVisible();
    await expect(
      done.getByRole("button", { name: "Cadastrar outro" })
    ).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(creates).toBe(1);
  });
}

test("Clientes: a lista vazia diz o que fazer e traz o botão que abre o formulário, um só", async ({
  page,
}) => {
  await openScreen(page, "/customers", "Clientes", {
    "customer/list": reply({ customers: [] }),
  });
  await expect(
    page.getByText(
      "Nenhum cliente ainda. Cadastre o primeiro em “Novo cliente”."
    )
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Novo cliente" })).toHaveCount(
    1
  );
  await page.getByRole("button", { name: "Novo cliente" }).click();
  await expect(
    page.getByRole("dialog", { name: "Novo cliente" })
  ).toBeVisible();
});

test("Clientes: anonimizar pede a confirmação na linha, 'Cancelar' desiste e confirmar diz que não dá para desfazer e anonimiza", async ({
  page,
}) => {
  const anonymized: unknown[] = [];
  await openScreen(page, "/customers", "Clientes", {
    "customer/anonymizeForPrivacy": (route) => {
      anonymized.push(
        (route.request().postDataJSON() as { json: unknown }).json
      );
      return route.fulfill(
        rpc({
          changed: true,
          customer: customer(1, "Ana Lima", {
            anonymizedAt: DAY,
            phone: null,
          }),
        })
      );
    },
    "customer/list": reply({ customers: [customer(1, "Ana Lima")] }),
  });
  await page.getByRole("button", { name: "Mais ações para Ana Lima" }).click();
  await page.getByRole("menuitem", { exact: true, name: "Anonimizar" }).click();
  const confirmation = page.getByRole("group", {
    name: "Confirmar a anonimização de Ana Lima",
  });
  await expect(confirmation).toContainText("Não dá para desfazer.");
  await confirmation.getByRole("button", { name: "Cancelar" }).click();
  await expect(confirmation).toHaveCount(0);
  expect(anonymized).toEqual([]);

  await page.getByRole("button", { name: "Mais ações para Ana Lima" }).click();
  await page.getByRole("menuitem", { exact: true, name: "Anonimizar" }).click();
  await page
    .getByRole("button", { name: "Anonimizar definitivamente" })
    .click();
  await expect(page.getByText("Cliente anonimizado.")).toBeVisible();
  expect(anonymized).toHaveLength(1);
});

test("Clientes: a lista que não carrega diz o motivo e 'Tentar novamente' lê de novo", async ({
  page,
}) => {
  let reads = 0;
  await openScreen(page, "/customers", "Clientes", {
    "customer/list": (route) => {
      reads += 1;
      // the read tries twice more by itself (~1.5 s and ~4 s): only the third 503 reaches the screen
      return reads <= 3
        ? route.fulfill(unavailable)
        : route.fulfill(rpc({ customers: [customer(1, "Ana Lima")] }));
    },
  });
  const alert = page.getByRole("alert");
  await expect(alert).toContainText(
    "A lista de clientes está temporariamente indisponível.",
    { timeout: 15_000 }
  );
  await expect(page.getByText("Nenhum cliente cadastrado.")).toHaveCount(0);
  expect(reads).toBe(3); // the first try and the two repeats, no more
  await alert.getByRole("button", { name: "Tentar novamente" }).click();
  await expect(page.getByText("Ana Lima")).toBeVisible();
  expect(reads).toBe(4);
});

test("Clientes a 320 px: nada transborda com nome e e-mail longos, o formulário e a confirmação", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop", "uma largura basta");
  await page.setViewportSize({ height: 740, width: 320 });
  await openScreen(page, "/customers", "Clientes", {
    "customer/list": reply({
      customers: [
        customer(1, "Bruno Carvalho de Albuquerque Montenegro Filho", {
          email: "bruno.carvalho.albuquerque.montenegro@exemplo.com.br",
          notes: "Prefere atendimento pelo WhatsApp, depois das 18 horas.",
        }),
      ],
    }),
  });
  await expectNoSidewaysScroll(page);
  // the form is a dialog, the whole screen at this width
  await page.getByRole("button", { name: "Novo cliente" }).click();
  await expect(
    page.getByRole("dialog", { name: "Novo cliente" })
  ).toBeVisible();
  await expectNoSidewaysScroll(page);
  await page.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: BRUNO_MENU }).click();
  await page.getByRole("menuitem", { exact: true, name: "Anonimizar" }).click();
  await expect(
    page.getByRole("group", { name: "Confirmar a anonimização de" })
  ).toBeVisible();
  await expectNoSidewaysScroll(page);
});

// ---- Catálogo público -----------------------------------------------------------------------------------------

const SETUP = {
  enabled: true,
  profile: null,
  publicOrigin: "https://catalogo.example",
  publishedProductIds: [],
};

test("Catálogo público sem internet: a faixa diz que a tela precisa de conexão e o que foi digitado fica (U-54)", async ({
  page,
}) => {
  await openScreen(page, "/public-catalog", "Catálogo público", {
    "product/list": reply({ products: [] }),
    "publicCatalog/setup": reply(SETUP),
  });
  await expect(page.getByText(STRIP)).toHaveCount(0);
  await page.getByLabel("Nome público").fill("Loja da Ana");
  await page.context().setOffline(true);
  await expect(page.getByText(STRIP)).toBeVisible();
  await expect(page.getByLabel("Nome público")).toHaveValue("Loja da Ana");
  await page.context().setOffline(false);
  await expect(page.getByText(STRIP)).toHaveCount(0);
});

test("Catálogo público fora do plano: o aviso diz por quê e 'Salvar perfil' desligado o lê, focável", async ({
  page,
}) => {
  await openScreen(page, "/public-catalog", "Catálogo público", {
    "product/list": reply({ products: [] }),
    "publicCatalog/setup": reply({ ...SETUP, enabled: false }),
  });
  await expect(page.getByText("faz parte do plano Pro")).toBeVisible();
  await page.getByLabel("Nome público").fill("Loja da Ana");
  const save = page.getByRole("button", { name: "Salvar perfil" });
  await expect(save).toHaveAttribute("aria-disabled", "true");
  // off by aria-disabled, not by `disabled`: it keeps the focus, and with it the reason it reads
  await expect(save).not.toHaveAttribute("disabled", "");
  await expect(save).toHaveAccessibleDescription(PLAN_NOTICE);
  await save.focus();
  await expect(save).toBeFocused();
});

test("Catálogo público: sem nada para salvar o botão diz por quê, e Enter num campo não envia", async ({
  page,
}) => {
  let saves = 0;
  await openScreen(page, "/public-catalog", "Catálogo público", {
    "product/list": reply({ products: [] }),
    "publicCatalog/saveProfile": (route) => {
      saves += 1;
      return route.abort();
    },
    "publicCatalog/setup": reply(SETUP),
  });
  const save = page.getByRole("button", { name: "Salvar perfil" });
  await expect(save).toHaveAccessibleDescription("Nada mudou para salvar.");
  await page.getByLabel("Instagram").press("Enter");
  expect(saves).toBe(0);
});

test("Catálogo público: a leitura que falha diz o motivo, não mostra o formulário e 'Tentar novamente' lê de novo", async ({
  page,
}) => {
  let reads = 0;
  await openScreen(page, "/public-catalog", "Catálogo público", {
    "product/list": reply({ products: [] }),
    "publicCatalog/setup": (route) => {
      reads += 1;
      // the read tries twice more by itself (~1.5 s and ~4 s): only the third 503 reaches the screen
      return reads <= 3
        ? route.fulfill(unavailable)
        : route.fulfill(rpc(SETUP));
    },
  });
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("temporariamente indisponível", {
    timeout: 15_000,
  });
  await expect(page.getByLabel("Nome público")).toHaveCount(0);
  expect(reads).toBe(3); // the first try and the two repeats, no more
  await alert.getByRole("button", { name: "Tentar novamente" }).click();
  await expect(page.getByLabel("Nome público")).toBeVisible();
  expect(reads).toBe(4);
});

test("Catálogo público a 320 px: nada transborda com o endereço de teste longo, o erro do campo e a lista de produtos", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop", "uma largura basta");
  await page.setViewportSize({ height: 740, width: 320 });
  const product = {
    archivedAt: null,
    categoryId: null,
    createdAt: DAY,
    deletedAt: null,
    description: null,
    id: id(80),
    name: "Camiseta Básica de algodão egípcio com estampa grande no peito",
    organizationId: ORGANIZATION.id,
    status: "active",
    updatedAt: DAY,
    version: 1,
  };
  await openScreen(page, "/public-catalog", "Catálogo público", {
    "product/list": reply({ products: [product] }),
    "publicCatalog/setup": reply({
      ...SETUP,
      publicOrigin:
        "https://catalogo-da-loja-de-teste.staging.exemplo-longo.app",
    }),
  });
  await page.getByLabel("Nome público").fill("Loja da Ana");
  await page.getByLabel("Endereço", { exact: true }).fill("Loja da Ana!");
  await page.getByRole("button", { name: "Salvar perfil" }).click();
  await expect(page.locator("#public-slug-error")).toBeVisible();
  await expectNoSidewaysScroll(page);
});
