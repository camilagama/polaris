/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

async function openLab(
  page: Page,
  user: string,
  screen: "customers" | "products" = "customers"
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
