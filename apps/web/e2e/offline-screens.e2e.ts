/// <reference lib="dom" />
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

const SHIRT_OPTION = /Camiseta do laboratório — Azul/;
const SHIRT_WITH_THREE = /Camiseta do laboratório — Azul.*Saldo 3/;

async function openLab(
  page: Page,
  user: string,
  screen: "customers" | "history" | "products" | "sale" | "stock" = "customers"
) {
  await page.goto(`/offline-screens-lab?screen=${screen}`);
  await expect(
    page.getByRole("heading", { name: "Laboratório das telas offline" })
  ).toBeVisible();
  await page.getByLabel("Usuário").fill(user);
}

async function start(page: Page, heading = "Clientes") {
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await expect(page.getByTestId("message")).toContainText(
    "Iniciar: ok (ready)",
    { timeout: 20_000 }
  );
  await expect(
    page.getByRole("heading", { exact: true, name: heading })
  ).toBeVisible();
}

async function register(page: Page, customer: { name: string; phone: string }) {
  await page.locator("#customer-name").fill(customer.name);
  await page.locator("#customer-phone").fill(customer.phone);
  await page.getByRole("button", { name: "Cadastrar cliente" }).click();
}

const chip = (page: Page) => page.locator(".sync-status");
const card = (page: Page, name: string) =>
  page.locator("[data-customer-id]", { hasText: name });

/** The actions of a customer are in the menu of its row: opens it and gives the item. */
async function customerMenuItem(page: Page, customer: string, item: string) {
  await page
    .getByRole("button", { name: `Mais ações para ${customer}` })
    .click();
  return page.getByRole("menuitem", { exact: true, name: item });
}

/** Opens the menu of the row, says whether the item is on, and closes it. */
async function expectCustomerItem(
  page: Page,
  customer: string,
  item: string,
  state: "disabled" | "enabled"
) {
  const entry = await customerMenuItem(page, customer, item);
  await (state === "enabled"
    ? expect(entry).toBeEnabled()
    : expect(entry).toBeDisabled());
  await page.keyboard.press("Escape");
}

test("com rede, cadastra pelo aparelho, o servidor confirma e o selo de envio some", async ({
  page,
}) => {
  await openLab(page, `user-${crypto.randomUUID()}`);
  await start(page);

  await register(page, { name: "Ana Lima", phone: "11900000001" });
  await expect(card(page, "Ana Lima")).toBeVisible();
  await expect(page.getByTestId("server-records")).toHaveText("1", {
    timeout: 20_000,
  });
  await expect(card(page, "Ana Lima").locator("[data-sync-state]")).toHaveCount(
    0,
    { timeout: 20_000 }
  );
  await expect(chip(page)).toContainText("Tudo sincronizado");
});

test("sem rede, cadastra e lista do aparelho, bloqueia a edição, e numa segunda visita sem rede o cliente continua lá", async ({
  page,
}) => {
  const user = `user-${crypto.randomUUID()}`;
  await openLab(page, user);
  await start(page);

  await page.getByLabel("Rede disponível").uncheck();
  await expect(page.getByText("Cadastrar e editar funciona")).toBeVisible();

  await register(page, { name: "Bia Souza", phone: "11900000002" });
  await expect(page.getByText("Cliente salvo neste aparelho.")).toBeVisible();
  await expect(card(page, "Bia Souza")).toContainText("Aguardando envio");
  await expectCustomerItem(page, "Bia Souza", "Editar", "disabled");
  await expect(chip(page)).toContainText("Sem conexão · 1 operação guardada");
  await expect(page.getByTestId("server-records")).toHaveText("0");

  // a second visit, still without a network
  await page.reload();
  await openLab(page, user);
  await page.getByLabel("Rede disponível").uncheck();
  await start(page);
  await expect(card(page, "Bia Souza")).toContainText("Aguardando envio");
});

test("sem rede, avisa de cliente repetido pelo telefone usando só os dados do aparelho", async ({
  page,
}) => {
  await openLab(page, `user-${crypto.randomUUID()}`);
  await start(page);
  await page.getByLabel("Rede disponível").uncheck();

  await register(page, { name: "Carla Dias", phone: "11900000003" });
  await expect(card(page, "Carla Dias")).toBeVisible();

  await register(page, { name: "Carla D.", phone: "11900000003" });
  await expect(page.getByText("Carla Dias").first()).toBeVisible();
  await expect(page.getByText("Correspondência por telefone.")).toBeVisible();
  await page.getByRole("button", { name: "Criar mesmo assim" }).click();
  await expect(card(page, "Carla D.")).toBeVisible();
});

test("voltando a rede, envia o que ficou guardado e confirma os clientes", async ({
  page,
}) => {
  await openLab(page, `user-${crypto.randomUUID()}`);
  await start(page);
  await page.getByLabel("Rede disponível").uncheck();
  await register(page, { name: "Duda Reis", phone: "11900000004" });
  await expect(card(page, "Duda Reis")).toContainText("Aguardando envio");

  await page.getByLabel("Rede disponível").check();
  await expect(page.getByTestId("server-records")).toHaveText("1", {
    timeout: 20_000,
  });
  await expect(
    card(page, "Duda Reis").locator("[data-sync-state]")
  ).toHaveCount(0, { timeout: 20_000 });
  await expectCustomerItem(page, "Duda Reis", "Editar", "enabled");
});

async function registerConfirmed(page: Page, name: string, phone: string) {
  await register(page, { name, phone });
  await expect(page.getByTestId("server-records")).toHaveText("1", {
    timeout: 20_000,
  });
  await expect(card(page, name).locator("[data-sync-state]")).toHaveCount(0, {
    timeout: 20_000,
  });
}

async function editName(page: Page, from: string, to: string) {
  await (await customerMenuItem(page, from, "Editar")).click();
  await page.locator("#customer-name").fill(to);
  await page.getByRole("button", { name: "Salvar alterações" }).click();
}

test("sem rede, edita um cliente já confirmado, vê a alteração à vista e o servidor a aplica quando a rede volta", async ({
  page,
}) => {
  await openLab(page, `user-${crypto.randomUUID()}`);
  await start(page);
  await registerConfirmed(page, "Eva Costa", "11900000005");

  await page.getByLabel("Rede disponível").uncheck();
  await editName(page, "Eva Costa", "Eva Costa Lima");
  await expect(page.getByText("Alteração salva neste aparelho.")).toBeVisible();
  const edited = card(page, "Eva Costa Lima");
  await expect(edited).toContainText("Alteração aguardando envio");
  await expectCustomerItem(page, "Eva Costa Lima", "Editar", "disabled");
  await expectCustomerItem(page, "Eva Costa Lima", "Arquivar", "disabled");
  await expect(chip(page)).toContainText("Sem conexão · 1 operação guardada");

  await page.getByLabel("Rede disponível").check();
  await expect(chip(page)).toContainText("Tudo sincronizado", {
    timeout: 20_000,
  });
  await expect(edited.locator("[data-sync-state]")).toHaveCount(0);
  await expect(edited).toBeVisible();
  await expectCustomerItem(page, "Eva Costa Lima", "Editar", "enabled");
});

test("sem rede, arquivar, restaurar e anonimizar seguem bloqueados, mas editar não", async ({
  page,
}) => {
  await openLab(page, `user-${crypto.randomUUID()}`);
  await start(page);
  await registerConfirmed(page, "Gil Alves", "11900000006");

  await page.getByLabel("Rede disponível").uncheck();
  await expectCustomerItem(page, "Gil Alves", "Editar", "enabled");
  await expectCustomerItem(page, "Gil Alves", "Arquivar", "disabled");
  await expectCustomerItem(page, "Gil Alves", "Anonimizar", "disabled");
  // said once, at the top, and not in every row
  await expect(
    page.getByText("arquivar, restaurar e anonimizar precisam de conexão")
  ).toBeVisible();
});

test("se o cliente mudou em outro aparelho, a alteração é recusada à vista, sem sobrescrever nada", async ({
  page,
}) => {
  await openLab(page, `user-${crypto.randomUUID()}`);
  await start(page);
  await registerConfirmed(page, "Hugo Neri", "11900000007");

  await page.getByLabel("Rede disponível").uncheck();
  await editName(page, "Hugo Neri", "Hugo Neri Filho");
  await expect(card(page, "Hugo Neri Filho")).toContainText(
    "Alteração aguardando envio"
  );
  await page
    .getByRole("button", { name: "Outro aparelho altera os clientes" })
    .click();

  await page.getByLabel("Rede disponível").check();
  const refused = card(page, "Hugo Neri");
  await expect(refused).toContainText("Alteração recusada pelo servidor", {
    timeout: 20_000,
  });
  await expect(
    refused.getByRole("link", { name: "Resolver em Pendências" })
  ).toBeVisible();
  // the server's row (the other device's edit) is what the card shows, not the refused one
  await expect(refused).toContainText("(outro aparelho)");
  await expect(refused).not.toContainText("Filho");
  await expectCustomerItem(page, "Hugo Neri", "Editar", "disabled");
});

const productRow = (page: Page, name: string) =>
  page.locator("[data-product-id]", { hasText: name });

/** The actions of a product are in its menu: opens it (the items of a locked product show disabled). */
async function openMenu(page: Page, name: string) {
  await page.getByRole("button", { name: `Mais ações para ${name}` }).click();
}

async function registerProduct(page: Page, name: string) {
  await page.getByRole("button", { name: "Novo produto" }).first().click();
  await page.getByLabel("Nome do produto").fill(name);
  await page.getByRole("button", { name: "Cadastrar produto" }).click();
}

test.describe("produtos", () => {
  test("com rede, cadastra pelo aparelho e o servidor confirma", async ({
    page,
  }) => {
    await openLab(page, `user-${crypto.randomUUID()}`, "products");
    await start(page, "Produtos");

    await registerProduct(page, "Camiseta Azul");
    await expect(productRow(page, "Camiseta Azul")).toBeVisible();
    // the form closes and the focus goes to what was done
    await expect(page.getByLabel("Nome do produto")).toHaveCount(0);
    await expect(
      page.getByText("Produto “Camiseta Azul” guardado. Enviando…")
    ).toBeVisible();
    await expect(page.getByTestId("server-records")).toHaveText("1", {
      timeout: 20_000,
    });
    await expect(
      productRow(page, "Camiseta Azul").locator("[data-sync-state]")
    ).toHaveCount(0, { timeout: 20_000 });
  });

  test("sem rede, cadastra e lista do aparelho, bloqueia o resto, e uma segunda visita sem rede mostra o produto", async ({
    page,
  }) => {
    const user = `user-${crypto.randomUUID()}`;
    await openLab(page, user, "products");
    await start(page, "Produtos");
    await page.getByLabel("Rede disponível").uncheck();
    await expect(page.getByText("Sem conexão.", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Cadastrar funciona e é enviado depois")
    ).toBeVisible();

    await registerProduct(page, "Bolsa Couro");
    await expect(page.getByText("salvo neste aparelho")).toBeVisible();
    const bag = productRow(page, "Bolsa Couro");
    await expect(bag).toContainText("Aguardando envio");
    await expect(bag).toContainText(
      "Disponível depois que o servidor confirmar"
    );
    await openMenu(page, "Bolsa Couro");
    await expect(
      page.getByRole("menuitem", { exact: true, name: "Editar" })
    ).toBeDisabled();
    await expect(
      page.getByRole("menuitem", { exact: true, name: "Variantes" })
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(chip(page)).toContainText("Sem conexão · 1 operação guardada");
    await expect(page.getByTestId("server-records")).toHaveText("0");

    await page.reload();
    await openLab(page, user, "products");
    await page.getByLabel("Rede disponível").uncheck();
    await start(page, "Produtos");
    await expect(productRow(page, "Bolsa Couro")).toContainText(
      "Aguardando envio"
    );
  });

  test("voltando a rede, envia o produto guardado e libera as ações", async ({
    page,
  }) => {
    await openLab(page, `user-${crypto.randomUUID()}`, "products");
    await start(page, "Produtos");
    await page.getByLabel("Rede disponível").uncheck();
    await registerProduct(page, "Calça Jeans");
    await expect(productRow(page, "Calça Jeans")).toContainText(
      "Aguardando envio"
    );

    await page.getByLabel("Rede disponível").check();
    await expect(page.getByTestId("server-records")).toHaveText("1", {
      timeout: 20_000,
    });
    await expect(
      productRow(page, "Calça Jeans").locator("[data-sync-state]")
    ).toHaveCount(0, { timeout: 20_000 });
    await openMenu(page, "Calça Jeans");
    await expect(
      page.getByRole("menuitem", { exact: true, name: "Editar" })
    ).toBeEnabled();
  });
});

async function openSaleLab(page: Page, user: string) {
  await openLab(page, user, "sale");
  await start(page, "Nova venda");
}

async function fillShirtSale(page: Page, quantity: number) {
  await page.getByLabel("Produto ou variante").fill("camiseta azul");
  await page.getByRole("button", { name: SHIRT_OPTION }).click();
  await page.getByLabel("Quantidade").fill(String(quantity));
  await payWith(page, "Pix");
  // the profile is a choice in both modes; these scenarios sell without one
  await chooseProfile(page, "Sem perfil de pagamento");
}

/** The method is a group of choice cards. */
async function payWith(page: Page, method: string) {
  await page
    .getByRole("radiogroup", { name: "Método de pagamento" })
    .getByRole("radio", { name: method })
    .check();
}

/** The profile is a Base UI Select: open it, then pick the option. */
async function chooseProfile(page: Page, option: string) {
  await page
    .getByRole("combobox", { exact: true, name: "Perfil de pagamento" })
    .click();
  await page.getByRole("option", { exact: true, name: option }).click();
}

const summary = (page: Page) =>
  page.getByRole("complementary", { name: "Resumo" });

const keepSale = (page: Page) =>
  page.getByRole("button", { name: "Guardar venda neste aparelho" });

test("na mesma aba, sem limpar dados, o usuário b inicia a venda e acha a variante depois do usuário a", async ({
  page,
}) => {
  // regression of the real-device run: no cleared site data between the two flows
  await openLab(page, `user-a-${crypto.randomUUID()}`);
  await start(page);
  await register(page, { name: "Ana Lima", phone: "11900000001" });
  await expect(page.getByTestId("server-records")).toHaveText("1", {
    timeout: 20_000,
  });

  await openSaleLab(page, `user-b-${crypto.randomUUID()}`);
  // the variants come from this device: the bootstrap of the sale server must have run
  await page.getByLabel("Rede disponível").uncheck();
  await page.getByLabel("Produto ou variante").fill("camiseta azul");
  await expect(page.getByRole("button", { name: SHIRT_OPTION })).toBeVisible({
    timeout: 20_000,
  });
});

test.describe("venda", () => {
  test("sem rede, guarda a venda no aparelho, desconta do estoque local e o servidor confirma ao voltar a rede", async ({
    page,
  }) => {
    await openSaleLab(page, `user-${crypto.randomUUID()}`);
    await page.getByLabel("Rede disponível").uncheck();
    await expect(
      page.getByRole("status").filter({ hasText: "Sem internet." })
    ).toBeVisible();
    // the profile is offered (the ones of the last connection), a typed date is not
    await expect(page.getByLabel("Perfil de pagamento")).toBeVisible();
    await expect(
      page.getByLabel("Data e hora da venda (opcional)")
    ).toHaveCount(0);

    await fillShirtSale(page, 2);
    await keepSale(page).click();

    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Venda guardada neste aparelho" })
    ).toBeVisible();
    await expect(
      page.getByText("Vendas neste aparelho aguardando o servidor")
    ).toBeVisible();
    await expect(page.getByText("Aguardando envio")).toBeVisible();
    await expect(chip(page)).toContainText("Sem conexão · 1 operação guardada");
    await expect(page.getByTestId("server-records")).toHaveText("0");

    // the next search already sees the stock the queued sale took (5 - 2)
    await page.getByLabel("Produto ou variante").fill("camiseta azul");
    await expect(
      page.getByRole("button", {
        name: SHIRT_WITH_THREE,
      })
    ).toBeVisible();

    await page.getByLabel("Rede disponível").check();
    await expect(page.getByTestId("server-records")).toHaveText("1", {
      timeout: 20_000,
    });
    await expect(
      page.getByText("Vendas neste aparelho aguardando o servidor")
    ).toHaveCount(0, { timeout: 20_000 });
    // back online the form is the online one again
    await expect(page.getByLabel("Perfil de pagamento")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Confirmar venda" })
    ).toBeVisible();
  });

  test("sem rede, avisa quando o estoque do aparelho não cobre, guarda mesmo assim, e a recusa do servidor fica à vista", async ({
    page,
  }) => {
    await openSaleLab(page, `user-${crypto.randomUUID()}`);
    await page.getByLabel("Rede disponível").uncheck();
    await fillShirtSale(page, 9);
    await keepSale(page).click();

    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Venda guardada neste aparelho" })
    ).toBeVisible();
    await expect(
      page.getByText("o aparelho mostra 5 em estoque e a venda tem 9")
    ).toBeVisible();

    await page.getByLabel("Rede disponível").check();
    await expect(page.getByText("Recusada pelo servidor")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("server-records")).toHaveText("0");
  });

  test("com rede o botão é o de confirmar no servidor, e a venda não é guardada no aparelho", async ({
    page,
  }) => {
    await openSaleLab(page, `user-${crypto.randomUUID()}`);
    await expect(
      page.getByRole("button", { name: "Confirmar venda" })
    ).toBeVisible();
    await expect(keepSale(page)).toHaveCount(0);
  });
});

async function openStockLab(page: Page, user: string) {
  await openLab(page, user, "stock");
  await start(page, "Estoque");
}

const shirtRow = (page: Page) =>
  page.getByRole("listitem").filter({ hasText: "Azul" });
/** The balance of a row: the figure under "Saldo". */
const rowBalance = (row: Locator) =>
  row
    .locator("dt", { hasText: "Saldo" })
    .locator("xpath=following-sibling::dd");

test.describe("estoque", () => {
  test("sem rede, lista do aparelho sem custo, guarda um recebimento, mostra o saldo do aparelho e o servidor executa ao voltar a rede", async ({
    page,
  }) => {
    await openStockLab(page, `user-${crypto.randomUUID()}`);
    await page.getByLabel("Rede disponível").uncheck();
    await expect(
      page.getByText("O saldo é o do aparelho, com o que está na fila.")
    ).toBeVisible();
    await expect(shirtRow(page)).toContainText("Com conexão");
    await expect(rowBalance(shirtRow(page))).toContainText("5");

    await page
      .getByRole("button", {
        name: "Receber estoque de Camiseta do laboratório, Azul",
      })
      .click();
    await page.getByLabel("Quantidade recebida").fill("10");
    await page.getByLabel("Custo unitário (R$)").fill("12,50");
    await page.getByRole("button", { name: "Revisar" }).click();
    await page.getByRole("button", { name: "Confirmar recebimento" }).click();

    await expect(
      page.getByText("Recebimento guardado neste aparelho")
    ).toBeVisible();
    await expect(chip(page)).toContainText("Sem conexão · 1 operação guardada");
    await expect(page.getByTestId("server-records")).toHaveText("0");
    await page.getByRole("button", { name: "Fechar" }).click();
    await expect(rowBalance(shirtRow(page))).toContainText("15");

    await page.getByLabel("Rede disponível").check();
    await expect(page.getByTestId("server-records")).toHaveText("1", {
      timeout: 20_000,
    });
    // back online the list is the server's again, with the cost column
    await expect(
      page.getByText("O saldo é o do aparelho, com o que está na fila.")
    ).toHaveCount(0);
  });

  test("sem rede, uma baixa maior que o saldo do aparelho é recusada pelo formulário e nada é guardado", async ({
    page,
  }) => {
    await openStockLab(page, `user-${crypto.randomUUID()}`);
    await page.getByLabel("Rede disponível").uncheck();
    await page
      .getByRole("button", {
        name: "Baixar estoque de Camiseta do laboratório, Azul",
      })
      .click();
    await page.getByLabel("Quantidade a baixar").fill("6");
    await page
      .getByRole("combobox", { exact: true, name: "Motivo da baixa" })
      .click();
    await page.getByRole("option").first().click();
    await page.getByRole("button", { name: "Revisar" }).click();

    await expect(
      page.getByText("A baixa não pode ser maior que o saldo exibido (5)")
    ).toBeVisible();
    await expect(chip(page)).not.toContainText("operação guardada");
  });
});

const SHIRT_ENTRY = {
  isDefaultVariant: false,
  listPrice: "50.00",
  movingAverageCost: null,
  productId: "0199c2d0-0000-7000-8000-0000000000f1",
  productName: "Camiseta do laboratório",
  productStatus: "active",
  quantity: 5,
  sku: "CAM-AZ-M",
  updatedAt: "2026-10-14T12:00:00.000Z",
  values: [{ optionName: "color", optionValueName: "Azul" }],
  variantId: "0199c2d0-0000-7000-8000-0000000000b1",
  version: 1,
};

/** The server answers the reads of the sale form, but the sale itself never gets an answer. */
async function serveSaleReadsOnly(page: Page) {
  await page.route("**/rpc/paymentProfile/list", (route) =>
    route.fulfill({
      body: JSON.stringify({ json: { profiles: [] }, meta: [] }),
      contentType: "application/json",
    })
  );
  await page.route("**/rpc/inventory/listBalances", (route) =>
    route.fulfill({
      body: JSON.stringify({
        json: { entries: [SHIRT_ENTRY], nextCursor: null },
        meta: [],
      }),
      contentType: "application/json",
    })
  );
  await page.route("**/rpc/sale/confirm", (route) =>
    route.abort("connectionreset")
  );
}

test.describe("venda sem resposta do servidor", () => {
  test("a venda travada pode ser guardada no aparelho como a mesma venda, e o servidor a recebe uma vez", async ({
    page,
  }) => {
    await serveSaleReadsOnly(page);
    await openSaleLab(page, `user-${crypto.randomUUID()}`);

    await fillShirtSale(page, 1);
    await chooseProfile(page, "Sem perfil de pagamento");
    await page.getByRole("button", { name: "Confirmar venda" }).click();

    await expect(
      page.getByRole("button", { name: "Tentar novamente (seguro)" })
    ).toBeVisible();
    await expect(
      page.getByText("Sem resposta do servidor, a venda pode ser guardada")
    ).toBeVisible();
    // locked: nothing of the sale can change (Base UI's radio and checkbox are <span>s, which the
    // <fieldset disabled> alone would not turn off)
    for (const control of [
      page.getByRole("radio", { name: "Pix" }),
      page.getByRole("checkbox", {
        name: "Pretendo antecipar este recebimento",
      }),
      page.getByRole("combobox", { exact: true, name: "Perfil de pagamento" }),
      page.getByLabel("Quantidade"),
      page.getByRole("button", { name: "Adicionar item" }),
      page.getByRole("button", { name: "Adicionar ajuste" }),
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one control after the other
      await expect(control).toBeDisabled();
    }
    await page
      .getByRole("button", { name: "Guardar esta venda neste aparelho" })
      .click();

    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Venda guardada neste aparelho" })
    ).toBeVisible();
    // the runtime is online: the same command reaches the server, once
    await expect(page.getByTestId("server-records")).toHaveText("1", {
      timeout: 20_000,
    });
  });
});

test("duas abas do mesmo usuário: o cadastro feito numa aparece na outra sem recarregar", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const user = `user-${crypto.randomUUID()}`;
  const first = await context.newPage();
  const second = await context.newPage();
  await openLab(first, user);
  await start(first);
  await openLab(second, user);
  await start(second);
  await first.getByLabel("Rede disponível").uncheck();
  await second.getByLabel("Rede disponível").uncheck();

  await register(first, { name: "Eva das Abas", phone: "11900000009" });
  await expect(card(first, "Eva das Abas")).toBeVisible();
  await expect(card(second, "Eva das Abas")).toBeVisible({ timeout: 15_000 });
  await expect(card(second, "Eva das Abas")).toContainText("Aguardando envio");
  await context.close();
});

test.describe("histórico de vendas", () => {
  test("sem rede, lista as vendas recentes do aparelho, filtra, e não oferece o detalhe nem a busca por item", async ({
    page,
  }) => {
    await openLab(page, `user-${crypto.randomUUID()}`, "history");
    await start(page, "Histórico de vendas");
    await page.getByLabel("Rede disponível").uncheck();

    await expect(
      page.getByText("Sem conexão. Estas são as vendas mais recentes")
    ).toBeVisible();
    const list = page.getByRole("list", { name: "Vendas" });
    await expect(list.getByRole("listitem")).toHaveCount(3);
    // no detail without a connection
    await expect(list.getByRole("link")).toHaveCount(0);
    await expect(page.getByLabel("Busca")).toBeDisabled();

    await page.getByLabel("Situação").selectOption({ label: "Canceladas" });
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await page.getByLabel("Situação").selectOption({ label: "Todas" });
    await page.getByLabel("Cliente").fill("angela");
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await expect(list).toContainText("Ângela Souza");

    // back online it is the server's history again, with the links
    await page.getByLabel("Rede disponível").check();
    await expect(page.getByLabel("Busca")).toBeEnabled();
  });
});

const LAB_ORGANIZATION = "0199c2d0-0000-7000-8000-00000000a001";
const LAB_PROFILE = (version: number) => ({
  archivedAt: null,
  createdAt: "2026-10-01T12:00:00.000Z",
  id: "0199c2d0-0000-7000-8000-0000000000c1",
  name: "Maquininha do laboratório",
  organizationId: LAB_ORGANIZATION,
  rules: [
    {
      anticipationFee: { fixedAmount: null, mode: "none", percentage: null },
      expectedSettlementDays: 1,
      id: "0199c2d0-0000-7000-8000-0000000000c2",
      installmentPlan: null,
      installments: null,
      method: "debit_card",
      processingFee: {
        fixedAmount: null,
        mode: "percentage",
        percentage: "2.000000",
      },
    },
  ],
  status: "active",
  updatedAt: "2026-10-01T12:00:00.000Z",
  version,
});

/** The profiles of "the last time with a connection", as the sale screen keeps them. */
async function rememberProfile(page: Page, version: number) {
  await page.addInitScript(
    ([key, value]) =>
      window.localStorage.setItem(key as string, value as string),
    [
      `polaris.offline.paymentProfiles.${LAB_ORGANIZATION}`,
      JSON.stringify([LAB_PROFILE(version)]),
    ]
  );
}

test.describe("venda com perfil de pagamento sem conexão", () => {
  test("oferece o perfil da última vez com conexão, guarda a venda com ele, e o servidor aceita se a versão é a atual", async ({
    page,
  }) => {
    await rememberProfile(page, 3);
    await openSaleLab(page, `user-${crypto.randomUUID()}`);
    await page.getByLabel("Rede disponível").uncheck();
    await expect(
      page.getByText("estes são os perfis da última vez com conexão")
    ).toBeVisible();

    await fillShirtSale(page, 1);
    await payWith(page, "Débito");
    await chooseProfile(page, "Maquininha do laboratório (versão 3)");
    await expect(
      page.getByRole("combobox", { exact: true, name: "Perfil de pagamento" })
    ).toContainText("Maquininha do laboratório (versão 3)");
    // the summary names the profile the sale is priced with
    await expect(summary(page)).toContainText(
      "Maquininha do laboratório (versão 3)"
    );
    await keepSale(page).click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Venda guardada neste aparelho" })
    ).toBeVisible();

    await page.getByLabel("Rede disponível").check();
    await expect(page.getByTestId("server-records")).toHaveText("1", {
      timeout: 20_000,
    });
  });

  test("com o perfil mudado no servidor a venda é recusada e fica à vista em Pendências", async ({
    page,
  }) => {
    // the device saw version 2; the server is already at 3
    await rememberProfile(page, 2);
    await openSaleLab(page, `user-${crypto.randomUUID()}`);
    await page.getByLabel("Rede disponível").uncheck();
    await fillShirtSale(page, 1);
    await payWith(page, "Débito");
    await chooseProfile(page, "Maquininha do laboratório (versão 2)");
    await keepSale(page).click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Venda guardada neste aparelho" })
    ).toBeVisible();

    await page.getByLabel("Rede disponível").check();
    await expect(page.getByText("Recusada pelo servidor")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("server-records")).toHaveText("0");
  });
});

const LEGAL_REFUSAL = {
  body: JSON.stringify({
    json: {
      code: "FORBIDDEN",
      data: {
        pending: [{ document: "terms", version: 1 }],
        reason: "legal_acceptance_required",
      },
      defined: false,
      message: "Forbidden",
      status: 403,
    },
    meta: [],
  }),
  contentType: "application/json",
  status: 403,
};

test.describe("sem o aceite dos termos (ADR 0100)", () => {
  test("a fila da venda pausa: nada é recusado nem apagado, e a venda sai depois do aceite", async ({
    page,
  }) => {
    await openSaleLab(page, `user-${crypto.randomUUID()}`);
    await page.getByLabel("Rede disponível").uncheck();
    await fillShirtSale(page, 2);
    await keepSale(page).click();
    await expect(chip(page)).toContainText("Sem conexão · 1 operação guardada");

    // the server now refuses for lack of the acceptance, and the network is back
    await page.getByLabel("Falta aceitar os termos").check();
    await page.getByLabel("Rede disponível").check();
    await expect(chip(page)).toContainText(
      "Envio pausado até o aceite dos termos · 1 operação guardada",
      { timeout: 20_000 }
    );
    // the queue is intact and not refused, and the local collections are still there
    await expect(page.getByText("Aguardando envio")).toBeVisible();
    await expect(page.getByText("Recusada pelo servidor")).toHaveCount(0);
    await expect(page.getByTestId("server-records")).toHaveText("0");
    // the local collections are still there: without a network the search reads them, with the queued sale
    await page.getByLabel("Rede disponível").uncheck();
    await page.getByLabel("Produto ou variante").fill("camiseta azul");
    await expect(
      page.getByRole("button", { name: SHIRT_WITH_THREE })
    ).toBeVisible();

    // accepted: the same sale goes out once
    await page.getByLabel("Falta aceitar os termos").uncheck();
    await page.getByLabel("Rede disponível").check();
    await expect(page.getByTestId("server-records")).toHaveText("1", {
      timeout: 20_000,
    });
    await expect(chip(page)).toContainText("Tudo sincronizado", {
      timeout: 20_000,
    });
  });

  test("a venda com itens recebe o 403 do aceite e os itens não se perdem", async ({
    page,
  }) => {
    await page.route("**/rpc/sale/confirm", (route) =>
      route.fulfill(LEGAL_REFUSAL)
    );
    await openSaleLab(page, `user-${crypto.randomUUID()}`);
    // the lab has no online catalog: the items are picked from the device, then the network comes back
    await page.getByLabel("Rede disponível").uncheck();
    await fillShirtSale(page, 2);
    await page.getByLabel("Rede disponível").check();
    await page.getByRole("button", { name: "Confirmar venda" }).click();

    await expect(
      page.getByText(
        "A venda não foi registrada porque falta aceitar os Termos de Uso e a Política de Privacidade. Os itens continuam aqui."
      )
    ).toBeVisible();
    // the item and its quantity are still on the form, nothing was sent or queued
    await expect(
      page.getByRole("group", { exact: true, name: "Item 1" })
    ).toContainText("Camiseta do laboratório — Azul");
    await expect(page.getByLabel("Quantidade")).toHaveValue("2");
    await expect(page.getByTestId("server-records")).toHaveText("0");
    expect(new URL(page.url()).pathname).toBe("/offline-screens-lab");
  });
});
