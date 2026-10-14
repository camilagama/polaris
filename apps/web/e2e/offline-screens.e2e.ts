/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

const SHIRT_OPTION = /Camiseta do laboratório — Azul/;
const SHIRT_WITH_THREE = /Camiseta do laboratório — Azul.*Saldo 3/;

async function openLab(
  page: Page,
  user: string,
  screen: "customers" | "products" | "sale" | "stock" = "customers"
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

const productCard = (page: Page, name: string) =>
  page.locator(".product-card", { hasText: name });

async function registerProduct(page: Page, name: string) {
  await page.locator("#product-name").fill(name);
  await page.getByRole("button", { name: "Cadastrar produto" }).click();
}

test.describe("produtos", () => {
  test("com rede, cadastra pelo aparelho e o servidor confirma", async ({
    page,
  }) => {
    await openLab(page, `user-${crypto.randomUUID()}`, "products");
    await start(page, "Produtos");

    await registerProduct(page, "Camiseta Azul");
    await expect(productCard(page, "Camiseta Azul")).toBeVisible();
    await expect(page.getByTestId("server-records")).toHaveText("1", {
      timeout: 20_000,
    });
    await expect(
      productCard(page, "Camiseta Azul").locator(".product-sync-state")
    ).toHaveCount(0, { timeout: 20_000 });
  });

  test("sem rede, cadastra e lista do aparelho, bloqueia o resto, e uma segunda visita sem rede mostra o produto", async ({
    page,
  }) => {
    const user = `user-${crypto.randomUUID()}`;
    await openLab(page, user, "products");
    await start(page, "Produtos");
    await page.getByLabel("Rede disponível").uncheck();
    await expect(
      page.getByText("Sem conexão. Você pode cadastrar produtos")
    ).toBeVisible();

    await registerProduct(page, "Bolsa Couro");
    await expect(page.getByText("salvo neste aparelho")).toBeVisible();
    const bag = productCard(page, "Bolsa Couro");
    await expect(bag).toContainText("Aguardando envio");
    await expect(
      bag.getByRole("button", { exact: true, name: "Editar" })
    ).toBeDisabled();
    await expect(
      bag.getByRole("button", { exact: true, name: "Variantes" })
    ).toBeDisabled();
    await expect(chip(page)).toContainText("Sem conexão · 1 operação guardada");
    await expect(page.getByTestId("server-records")).toHaveText("0");

    await page.reload();
    await openLab(page, user, "products");
    await page.getByLabel("Rede disponível").uncheck();
    await start(page, "Produtos");
    await expect(productCard(page, "Bolsa Couro")).toContainText(
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
    await expect(productCard(page, "Calça Jeans")).toContainText(
      "Aguardando envio"
    );

    await page.getByLabel("Rede disponível").check();
    await expect(page.getByTestId("server-records")).toHaveText("1", {
      timeout: 20_000,
    });
    await expect(
      productCard(page, "Calça Jeans").locator(".product-sync-state")
    ).toHaveCount(0, { timeout: 20_000 });
    await expect(
      productCard(page, "Calça Jeans").getByRole("button", {
        exact: true,
        name: "Editar",
      })
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
  await page.getByLabel("Método de pagamento").selectOption({ label: "Pix" });
}

const keepSale = (page: Page) =>
  page.getByRole("button", { name: "Guardar venda neste aparelho" });

test.describe("venda", () => {
  test("sem rede, guarda a venda no aparelho, desconta do estoque local e o servidor confirma ao voltar a rede", async ({
    page,
  }) => {
    await openSaleLab(page, `user-${crypto.randomUUID()}`);
    await page.getByLabel("Rede disponível").uncheck();
    await expect(
      page.getByText("Sem conexão. A venda será guardada")
    ).toBeVisible();
    // no profile and no date exist offline
    await expect(page.getByLabel("Perfil de pagamento")).toHaveCount(0);
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
  page.locator(".stock-item", { hasText: "Azul" });

test.describe("estoque", () => {
  test("sem rede, lista do aparelho sem custo, guarda um recebimento, mostra o saldo do aparelho e o servidor executa ao voltar a rede", async ({
    page,
  }) => {
    await openStockLab(page, `user-${crypto.randomUUID()}`);
    await page.getByLabel("Rede disponível").uncheck();
    await expect(
      page.getByText("Sem conexão. O saldo mostrado é o do aparelho")
    ).toBeVisible();
    await expect(shirtRow(page)).toContainText("Com conexão");
    await expect(shirtRow(page).locator(".stock-quantity")).toContainText("5");

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
    await expect(shirtRow(page).locator(".stock-quantity")).toContainText("15");

    await page.getByLabel("Rede disponível").check();
    await expect(page.getByTestId("server-records")).toHaveText("1", {
      timeout: 20_000,
    });
    // back online the list is the server's again, with the cost column
    await expect(page.getByText("Sem conexão. O saldo mostrado")).toHaveCount(
      0
    );
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
    await page.getByLabel("Motivo da baixa").selectOption({ index: 1 });
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
    await page.getByLabel("Perfil de pagamento").selectOption({
      label: "Sem perfil de pagamento (taxas e prazo desconhecidos)",
    });
    await page.getByRole("button", { name: "Confirmar venda" }).click();

    await expect(
      page.getByRole("button", { name: "Tentar novamente (seguro)" })
    ).toBeVisible();
    await expect(
      page.getByText("Sem resposta do servidor, a venda pode ser guardada")
    ).toBeVisible();
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
