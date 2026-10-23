/// <reference lib="dom" />
import type { Locator, Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { serveLabWorker, WORKER_MARK } from "./worker-mark";

const SHIRT_OPTION = /Camiseta do laboratório — Azul/;
const SHIRT_WITH_THREE = /Camiseta do laboratório — Azul.*Saldo 3/;

async function openLab(
  page: Page,
  user: string,
  screen:
    | "customers"
    | "history"
    | "payment-profiles"
    | "products"
    | "public-catalog"
    | "sale"
    | "stock" = "customers"
) {
  await serveLabWorker(page);
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
  page.locator(".customer-card", { hasText: name });

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
  await expect(
    card(page, "Ana Lima").locator(".customer-sync-state")
  ).toHaveCount(0, { timeout: 20_000 });
  await expect(chip(page)).toContainText("Tudo sincronizado");
});

test("sem rede, cadastra e lista do aparelho, bloqueia a edição, e numa segunda visita sem rede o cliente continua lá", async ({
  page,
}) => {
  const user = `user-${crypto.randomUUID()}`;
  await openLab(page, user);
  await start(page);

  await page.getByLabel("Rede disponível").uncheck();
  await expect(
    page.getByText("Sem conexão. Você pode cadastrar")
  ).toBeVisible();

  await register(page, { name: "Bia Souza", phone: "11900000002" });
  await expect(page.getByText("Cliente salvo neste aparelho.")).toBeVisible();
  await expect(card(page, "Bia Souza")).toContainText("Aguardando envio");
  await expect(
    page.getByRole("button", { name: "Editar cliente Bia Souza" })
  ).toBeDisabled();
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
    card(page, "Duda Reis").locator(".customer-sync-state")
  ).toHaveCount(0, { timeout: 20_000 });
  await expect(
    page.getByRole("button", { name: "Editar cliente Duda Reis" })
  ).toBeEnabled();
});

async function registerConfirmed(page: Page, name: string, phone: string) {
  await register(page, { name, phone });
  await expect(page.getByTestId("server-records")).toHaveText("1", {
    timeout: 20_000,
  });
  await expect(card(page, name).locator(".customer-sync-state")).toHaveCount(
    0,
    { timeout: 20_000 }
  );
}

async function editName(page: Page, from: string, to: string) {
  await page.getByRole("button", { name: `Editar cliente ${from}` }).click();
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
  await expect(
    page.getByRole("button", { name: "Editar cliente Eva Costa Lima" })
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Arquivar cliente Eva Costa Lima" })
  ).toBeDisabled();
  await expect(chip(page)).toContainText("Sem conexão · 1 operação guardada");

  await page.getByLabel("Rede disponível").check();
  await expect(chip(page)).toContainText("Tudo sincronizado", {
    timeout: 20_000,
  });
  await expect(edited.locator(".customer-sync-state")).toHaveCount(0);
  await expect(edited).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Editar cliente Eva Costa Lima" })
  ).toBeEnabled();
});

test("sem rede, arquivar, restaurar e anonimizar seguem bloqueados, mas editar não", async ({
  page,
}) => {
  await openLab(page, `user-${crypto.randomUUID()}`);
  await start(page);
  await registerConfirmed(page, "Gil Alves", "11900000006");

  await page.getByLabel("Rede disponível").uncheck();
  await expect(
    page.getByRole("button", { name: "Editar cliente Gil Alves" })
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Arquivar cliente Gil Alves" })
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Anonimizar cliente Gil Alves" })
  ).toBeDisabled();
  await expect(card(page, "Gil Alves")).toContainText(
    "Arquivar, restaurar e anonimizar precisam de conexão."
  );
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
  await expect(
    refused.getByRole("button", { name: "Editar cliente" })
  ).toBeDisabled();
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
      headers: { ...WORKER_MARK },
    })
  );
  await page.route("**/rpc/inventory/listBalances", (route) =>
    route.fulfill({
      body: JSON.stringify({
        json: { entries: [SHIRT_ENTRY], nextCursor: null },
        meta: [],
      }),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
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
      page.getByText(
        "Estas são as vendas mais recentes guardadas neste aparelho"
      )
    ).toBeVisible();
    const list = page.getByRole("list", { name: "Vendas" });
    await expect(list.getByRole("listitem")).toHaveCount(3);
    // no detail without a connection
    await expect(list.getByRole("link")).toHaveCount(0);
    // below 760 px the filters are in a panel, closed
    const trigger = page.getByRole("button", { exact: true, name: "Filtrar" });
    const inPanel = await trigger.isVisible();
    if (inPanel) {
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      await trigger.click();
    }
    await expect(page.getByLabel("Busca")).toBeDisabled();

    await page.getByRole("combobox", { name: "Situação" }).click();
    await page.getByRole("option", { name: "Canceladas" }).click();
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await page.getByRole("combobox", { name: "Situação" }).click();
    await page.getByRole("option", { name: "Todas" }).click();
    await page.getByLabel("Cliente").fill("angela");
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await expect(list).toContainText("Ângela Souza");
    // with a filter on, the trigger of the panel counts it
    if (inPanel) {
      await expect(
        page.getByRole("button", { name: "Filtrar · 1" })
      ).toBeVisible();
    }

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
  headers: { ...WORKER_MARK },
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

// ---------------------------------------------------------------------------------------------------------
// F7: the connection state with proof (emenda do ADR 0043, U-57 to U-62). Two ways to lose the network:
// "offline" is the browser's own (`navigator.onLine=false`); "mentindo" keeps `onLine=true` while `/rpc` and
// `/health` fail, as a wi-fi with no internet, a captive portal or the Pixel after a reload.

type Network = "mentindo" | "offline" | "ok";

const cutNetwork = (route: Route) => route.abort("internetdisconnected");

/** Puts the page's network in one of the three states; "ok" undoes the other two without an `online` event in "mentindo". */
async function rede(page: Page, mode: Network) {
  await page.unroute("**/rpc/**", cutNetwork);
  await page.unroute("**/health", cutNetwork);
  if (mode === "ok") {
    await page.context().setOffline(false);
    return;
  }
  // a fulfilled route still answers with the context offline: with no network, nothing answers
  await page.route("**/rpc/**", cutNetwork);
  await page.route("**/health", cutNetwork);
  if (mode === "offline") {
    await page.context().setOffline(true);
  }
}

const healthRequests = (page: Page) => {
  const seen: number[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/health") {
      seen.push(Date.now());
    }
  });
  return seen;
};

const WITH_FORM =
  "Esta tela precisa de conexão. O que você digitou fica aqui enquanto esta página estiver aberta.";
const WITHOUT_FORM =
  "Esta tela precisa de conexão. Ela carrega sozinha quando a conexão voltar.";

const rpcAnswer = (json: unknown, status = 200) => ({
  body: JSON.stringify({ json, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
  status,
});

/** The public catalog of a store with no profile yet, answered by the Worker; counts the saves. */
async function serveCatalogSetup(page: Page) {
  const catalog = { saves: 0 };
  await page.route("**/rpc/publicCatalog/**", (route) => {
    const procedure = new URL(route.request().url()).pathname;
    if (procedure.endsWith("/setup")) {
      return route.fulfill(
        rpcAnswer({
          enabled: true,
          profile: null,
          publicOrigin: "https://catalogo.example",
          publishedProductIds: [],
        })
      );
    }
    if (procedure.endsWith("/saveProfile")) {
      catalog.saves += 1;
    }
    return route.fallback();
  });
  await page.route("**/rpc/product/list", (route) =>
    route.fulfill(rpcAnswer({ products: [] }))
  );
  return catalog;
}

interface ProfilesServer {
  creates: number;
  lists: number;
  profiles: { name: string }[];
}

/** The payment profile procedures the screen calls, answered by the Worker (with its mark). */
async function serveProfiles(page: Page): Promise<ProfilesServer> {
  const server: ProfilesServer = { creates: 0, lists: 0, profiles: [] };
  await page.route("**/rpc/paymentProfile/**", (route) => {
    const procedure = new URL(route.request().url()).pathname;
    if (procedure.endsWith("/list")) {
      server.lists += 1;
      return route.fulfill(
        rpcAnswer({
          profiles: server.profiles.map((profile, index) => ({
            createdAt: "2026-10-22T12:00:00.000Z",
            id: `0199c2d0-0000-7000-8000-0000000b${String(index).padStart(4, "0")}`,
            name: profile.name,
            organizationId: "0199c2d0-0000-7000-8000-00000000a001",
            rules: [],
            status: "active",
            updatedAt: "2026-10-22T12:00:00.000Z",
            version: 1,
          })),
        })
      );
    }
    if (procedure.endsWith("/create")) {
      server.creates += 1;
    }
    return route.fallback();
  });
  return server;
}

for (const mode of ["offline", "mentindo"] as const) {
  test.describe(`conexão com prova, modo ${mode}`, () => {
    test(`U-57: o histórico mostra a faixa e as vendas do aparelho, sem erro de carregamento (${mode})`, async ({
      page,
    }) => {
      const user = `user-${crypto.randomUUID()}`;
      await openLab(page, user, "history");
      await start(page, "Histórico de vendas");
      await rede(page, mode);
      if (mode === "mentindo") {
        // the Pixel after a reload: `onLine` true and nothing gets through
        await page.reload();
        await page.getByLabel("Usuário").fill(user);
        await page
          .getByRole("button", { exact: true, name: "Iniciar" })
          .click();
      } else {
        await page
          .getByRole("button", { exact: true, name: "Sincronizar" })
          .click();
      }
      await expect(
        page.getByText("Sem conexão. Estas são as vendas mais recentes")
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        page.getByRole("list", { name: "Vendas" }).getByRole("listitem")
      ).toHaveCount(3);
      await expect(
        page.getByText("Não foi possível carregar as vendas")
      ).toHaveCount(0);
    });

    test(`U-58: o estoque mostra os saldos do aparelho, sem R$ 0,00 nem erro (${mode})`, async ({
      page,
    }) => {
      await openStockLab(page, `user-${crypto.randomUUID()}`);
      await rede(page, mode);
      await page
        .getByRole("button", { exact: true, name: "Sincronizar" })
        .click();
      await expect(
        page.getByText("O saldo é o do aparelho, com o que está na fila.")
      ).toBeVisible({ timeout: 15_000 });
      await expect(rowBalance(shirtRow(page))).toContainText("5");
      await expect(shirtRow(page)).not.toContainText("R$ 0,00");
      await expect(
        page.getByText("Não foi possível carregar o estoque")
      ).toHaveCount(0);
    });

    test(`U-62: a venda guarda no aparelho, com as variantes locais e nenhum erro preso (${mode})`, async ({
      page,
    }) => {
      await openSaleLab(page, `user-${crypto.randomUUID()}`);
      await rede(page, mode);
      await page
        .getByRole("button", { exact: true, name: "Sincronizar" })
        .click();
      await expect(
        page.getByRole("status").filter({ hasText: "Sem internet." })
      ).toBeVisible({ timeout: 15_000 });
      await fillShirtSale(page, 1);
      await expect(keepSale(page)).toBeVisible();
      await expect(
        page.getByText("Não foi possível carregar as variantes")
      ).toHaveCount(0);
      await keepSale(page).click();
      await expect(chip(page)).toContainText("Offline · 1");
    });

    test(`U-60: perfis offline: faixa, lista "não carregaram", "Criar perfil" sem pedido e o nome fica (${mode})`, async ({
      page,
    }) => {
      const server = await serveProfiles(page);
      await openLab(page, `user-${crypto.randomUUID()}`, "payment-profiles");
      await rede(page, mode);
      await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
      await expect(page.getByText(WITH_FORM)).toBeVisible({ timeout: 15_000 });
      await expect(
        page.getByText(
          "Os perfis não carregaram. Eles aparecem quando a conexão voltar."
        )
      ).toBeVisible();
      await expect(page.getByText("Nenhum perfil cadastrado")).toHaveCount(0);
      await expect(page.getByText("Tentar novamente")).toHaveCount(0);
      await page.getByLabel("Nome do perfil").fill("Maquininha");
      const create = page.getByRole("button", { name: "Criar perfil" });
      await expect(create).toHaveAttribute("aria-disabled", "true");
      await expect(create).toHaveAttribute(
        "aria-describedby",
        "connection-required-text"
      );
      // focusable and pressable (the pattern of a control off with a reason), and nothing leaves
      await create.click({ force: true });
      await expect(page.getByLabel("Nome do perfil")).toHaveValue("Maquininha");
      expect(server.creates).toBe(0);
      // the connection returns: the list is read again (a read, never the POST)
      await rede(page, "ok");
      await expect(page.getByText(WITH_FORM)).toHaveCount(0, {
        timeout: 20_000,
      });
      await expect(page.getByText("Nenhum perfil cadastrado")).toBeVisible();
      expect(server.creates).toBe(0);
      await expect(page.getByLabel("Nome do perfil")).toHaveValue("Maquininha");
    });

    test(`U-59: o catálogo aberto sem conexão mostra só a faixa e carrega sozinho na volta (${mode})`, async ({
      page,
    }) => {
      await serveCatalogSetup(page);
      await openLab(page, `user-${crypto.randomUUID()}`, "public-catalog");
      await rede(page, mode);
      await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
      await expect(page.getByText(WITHOUT_FORM)).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        page.getByRole("button", { name: "Salvar perfil" })
      ).toHaveCount(0);
      await expect(page.getByText("Perfil salvo.")).toHaveCount(0);
      await expect(
        page.getByText("Não foi possível carregar o catálogo público")
      ).toHaveCount(0);
      await rede(page, "ok");
      await expect(page.getByLabel("Nome público")).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.getByText(WITHOUT_FORM)).toHaveCount(0);
    });

    test(`U-59: o catálogo carregado antes do corte guarda o texto, e "Salvar perfil" não envia (${mode})`, async ({
      page,
    }) => {
      const catalog = await serveCatalogSetup(page);
      await openLab(page, `user-${crypto.randomUUID()}`, "public-catalog");
      await start(page, "Catálogo público");
      await page.getByLabel("Nome público").fill("Loja da Ana");
      await rede(page, mode);
      await page
        .getByRole("button", { exact: true, name: "Sincronizar" })
        .click();
      await expect(page.getByText(WITH_FORM)).toBeVisible({ timeout: 15_000 });
      const save = page.getByRole("button", { name: "Salvar perfil" });
      await expect(save).toHaveAttribute("aria-disabled", "true");
      await save.click({ force: true });
      await expect(page.getByLabel("Nome público")).toHaveValue("Loja da Ana");
      await expect(page.getByText("Perfil salvo.")).toHaveCount(0);
      expect(catalog.saves).toBe(0);
    });
  });
}

test.describe("conexão com prova", () => {
  test("U-60: o POST cortado diz que não sabe, não reenvia, e a releitura mostra a lista", async ({
    page,
  }) => {
    const server = await serveProfiles(page);
    await openLab(page, `user-${crypto.randomUUID()}`, "payment-profiles");
    await start(page, "Perfis de pagamento");
    await expect(page.getByText("Nenhum perfil cadastrado")).toBeVisible();
    // the server saves it, but the answer never comes back, and the network goes with it
    await page.route("**/rpc/paymentProfile/create", async (route) => {
      server.creates += 1;
      server.profiles.push({ name: "Maquininha" });
      await page.route("**/health", cutNetwork);
      await route.abort("connectionreset");
    });
    await page.getByLabel("Nome do perfil").fill("Maquininha");
    await page.getByRole("button", { name: "Criar perfil" }).click();
    await expect(
      page.getByText(
        "A conexão caiu antes da resposta. Não sabemos se o perfil foi salvo. Quando a internet voltar, a lista é atualizada: confira antes de salvar de novo."
      )
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByLabel("Nome do perfil")).toHaveValue("Maquininha");
    await expect(
      page.getByRole("button", { name: "Criar perfil" })
    ).toBeVisible();

    await page.unroute("**/health", cutNetwork);
    // the list read on the return shows the saved profile; the warning and the typed form stay to be checked
    await expect(
      page
        .getByRole("region", { name: "Perfis cadastrados" })
        .getByRole("listitem")
        .filter({ hasText: "Maquininha" })
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByLabel("Nome do perfil")).toHaveValue("Maquininha");
    await expect(
      page.getByText("Não sabemos se o perfil foi salvo", { exact: false })
    ).toBeVisible();
    expect(server.creates).toBe(1); // read again, never sent again
  });

  test("Perfis: a leitura cortada uma vez, com /health respondendo, mostra o erro com Tentar novamente", async ({
    page,
  }) => {
    const server = await serveProfiles(page);
    let cut = true;
    await page.route("**/rpc/paymentProfile/list", async (route) => {
      if (cut) {
        cut = false;
        await route.abort("connectionreset");
        return;
      }
      await route.fallback();
    });
    await openLab(page, `user-${crypto.randomUUID()}`, "payment-profiles");
    await start(page, "Perfis de pagamento");
    const retry = page.getByRole("button", { name: "Tentar novamente" });
    await expect(retry).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(WITH_FORM)).toHaveCount(0);
    await retry.click();
    await expect(page.getByText("Nenhum perfil cadastrado")).toBeVisible();
    expect(server.lists).toBeGreaterThanOrEqual(1);
  });

  test("um erro de rede isolado, com /health respondendo, não troca a tela para offline", async ({
    page,
  }) => {
    await openStockLab(page, `user-${crypto.randomUUID()}`);
    let cut = false;
    await page.route("**/rpc/__screens-lab", (route) => {
      if (!cut) {
        cut = true;
        return route.abort("connectionreset");
      }
      return route.fallback();
    });
    await page
      .getByRole("button", { exact: true, name: "Sincronizar" })
      .click();
    await expect(page.getByTestId("message")).toContainText("Sincronizar: ok");
    await page.waitForTimeout(3000);
    await expect(
      page.getByText("O saldo é o do aparelho, com o que está na fila.")
    ).toHaveCount(0);
    await expect(chip(page)).not.toContainText("Offline");
  });

  test("portal cativo: HTML 200 em /rpc e em /health é sem conexão", async ({
    page,
  }) => {
    await openLab(page, `user-${crypto.randomUUID()}`, "history");
    await start(page, "Histórico de vendas");
    const portal = (route: Route) =>
      route.fulfill({
        body: "<html><title>Wi-Fi</title></html>",
        contentType: "text/html",
        status: 200,
      });
    await page.route("**/rpc/**", portal);
    await page.route("**/health", portal);
    await page
      .getByRole("button", { exact: true, name: "Sincronizar" })
      .click();
    await expect(
      page.getByText("Sem conexão. Estas são as vendas mais recentes")
    ).toBeVisible({ timeout: 15_000 });
    await expect(chip(page)).toContainText("Offline");
  });

  test("recarga com o 'offline desde' vencido (90 s) abre offline em até 5 s", async ({
    page,
  }) => {
    const user = `user-${crypto.randomUUID()}`;
    await openLab(page, user, "history");
    await start(page, "Histórico de vendas");
    await rede(page, "mentindo");
    await page.evaluate(() =>
      window.sessionStorage.setItem(
        "polaris.connection.offline-since",
        JSON.stringify({
          seen: Date.now() - 90_000,
          since: Date.now() - 120_000,
        })
      )
    );
    await page.reload();
    await page.getByLabel("Usuário").fill(user);
    const clicked = Date.now();
    await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
    await expect(
      page.getByText("Sem conexão. Estas são as vendas mais recentes")
    ).toBeVisible({ timeout: 5000 });
    expect(Date.now() - clicked).toBeLessThan(5000);
  });

  test("sondas: nenhuma online, no máximo 9 no 1º minuto offline e nenhuma com a página escondida", async ({
    page,
  }) => {
    await page.clock.install();
    const probes = healthRequests(page);
    await openLab(page, `user-${crypto.randomUUID()}`, "stock");
    // online, nothing in doubt: no probe in two minutes
    await page.clock.runFor(120_000);
    expect(probes).toHaveLength(0);

    await start(page, "Estoque");
    await rede(page, "mentindo");
    const before = probes.length;
    await page
      .getByRole("button", { exact: true, name: "Sincronizar" })
      .click();
    await expect(
      page.getByText("O saldo é o do aparelho, com o que está na fila.")
    ).toBeVisible({ timeout: 15_000 });
    await page.clock.runFor(60_000);
    // the first minute offline, counted from the probe that found it
    expect(probes.length - before).toBeGreaterThan(0);
    expect(probes.length - before).toBeLessThanOrEqual(9);

    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const hidden = probes.length;
    await page.clock.runFor(180_000);
    expect(probes.length).toBe(hidden);
  });

  test("U-61 mentindo: a rede volta sem o evento online e as 2 vendas chegam em até 16 s", async ({
    page,
  }) => {
    await openSaleLab(page, `user-${crypto.randomUUID()}`);
    await rede(page, "mentindo");
    await page
      .getByRole("button", { exact: true, name: "Sincronizar" })
      .click();
    for (const sale of [1, 2]) {
      // biome-ignore lint/performance/noAwaitInLoops: each sale is kept after the form of the previous one cleared
      await fillShirtSale(page, 1);
      await keepSale(page).click();
      await expect(chip(page)).toContainText(`Offline · ${sale}`);
    }
    const back = Date.now();
    await rede(page, "ok");
    await expect(page.getByTestId("server-records")).toHaveText("2", {
      timeout: 16_000,
    });
    expect(Date.now() - back).toBeLessThanOrEqual(16_000);
    await expect(chip(page)).toContainText("Sincronizado", { timeout: 10_000 });
  });

  test("U-61 offline: com o evento online, as 2 vendas saem em até 3 s", async ({
    page,
  }) => {
    await openSaleLab(page, `user-${crypto.randomUUID()}`);
    await rede(page, "offline");
    for (const sale of [1, 2]) {
      // biome-ignore lint/performance/noAwaitInLoops: each sale is kept after the form of the previous one cleared
      await fillShirtSale(page, 1);
      await keepSale(page).click();
      await expect(chip(page)).toContainText(`Offline · ${sale}`);
    }
    const back = Date.now();
    await rede(page, "ok");
    await expect(page.getByTestId("server-records")).toHaveText("2", {
      timeout: 3000,
    });
    expect(Date.now() - back).toBeLessThanOrEqual(3000);
  });
});
