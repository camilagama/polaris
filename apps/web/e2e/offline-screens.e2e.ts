/// <reference lib="dom" />
import type { Locator, Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { applyEditor, onPhone } from "./filter-bar-editor";
import { serveLabWorker, WORKER_MARK } from "./worker-mark";

const SHIRT_OPTION = /Camiseta do laboratório · Azul/;
const SHIRT_WITH_THREE = /Camiseta do laboratório · Azul.*Saldo 3/;
const MONEY = /R\$\s*[\d.]+,\d{2}/;

async function openLab(
  page: Page,
  user: string,
  screen:
    | "categories"
    | "customers"
    | "expenses"
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
  await page.getByRole("button", { name: "Novo cliente" }).click();
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

/**
 * Closes the open menu with Escape and waits for it to be gone, back to the page (no popup, no backdrop).
 * The Escape is asked again until the menu leaves: a menu that has just opened (or been opened again by a click
 * during the exit of the last one, which the hole of its backdrop lets through) listens for the key only after
 * its first effects, and the items of the popup that is still leaving are visible meanwhile, so an Escape sent
 * right after the assertion can be lost and leave the menu open over the page.
 */
async function closeMenu(page: Page) {
  await expect(async () => {
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0, { timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  await expect(page.locator("[data-base-ui-inert]")).toHaveCount(0);
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
  await closeMenu(page);
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
  await expect(
    page.getByText("Cliente “Bia Souza” salvo neste aparelho.")
  ).toBeVisible();
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
  await expect(page.getByText("Mesmo telefone")).toBeVisible();
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
  // the form is a dialog that fades out; what comes next (a menu, the lab controls) waits for it to be gone
  await expect(page.getByRole("dialog")).toHaveCount(0);
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

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`depois do Escape o menu "Mais ações" não deixa popup nem fundo inerte, e o clique seguinte funciona (movimento: ${reducedMotion})`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion });
    await openLab(page, `user-${crypto.randomUUID()}`);
    await start(page);
    await registerConfirmed(page, "Iris Prado", "11900000008");

    const trigger = page.getByRole("button", {
      name: "Mais ações para Iris Prado",
    });
    const network = page.getByLabel("Rede disponível");
    for (const toggle of ["uncheck", "check", "uncheck"] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: one round at a time
      await trigger.click();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await closeMenu(page);
      // the click right after the exit is not blocked by what is left of the menu
      await network[toggle]();
    }

    // the click on the trigger right after the Escape (the hole of the backdrop lets it through while the menu
    // leaves) opens it again, or closes what the key did not: either way it ends clean
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await trigger.click();
    // the trigger, not only the popup, says it is closed: a menu the click is still opening has no popup yet,
    // so "no menu" alone can pass just before it appears
    await expect(async () => {
      await page.keyboard.press("Escape");
      await expect(trigger).toHaveAttribute("aria-expanded", "false", {
        timeout: 1000,
      });
      await expect(page.getByRole("menu")).toHaveCount(0, { timeout: 1000 });
    }).toPass({ timeout: 10_000 });
    await expect(page.locator("[data-base-ui-inert]")).toHaveCount(0);
    await network.check();
  });
}

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

async function registerProduct(page: Page, name: string, quantity?: string) {
  await page.getByRole("button", { name: "Novo produto" }).first().click();
  await page.getByLabel("Nome do produto").fill(name);
  if (quantity) {
    await page.getByLabel("Quantos você tem agora").fill(quantity);
  }
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

    await registerProduct(page, "Bolsa Couro", "10");
    // the notice confirms the stock the person typed
    await expect(
      page.getByText(
        "Produto “Bolsa Couro” salvo neste aparelho com 10 unidades. Ele será enviado quando a conexão voltar."
      )
    ).toBeVisible();
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
    await closeMenu(page);
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
      page.getByText("Vendas guardadas neste aparelho")
    ).toBeVisible();
    await expect(page.getByText("Aguardando envio")).toBeVisible();
    // one card, one line: when, how many items, how much (P-3)
    const saved = page.getByRole("region", {
      name: "Vendas guardadas neste aparelho",
    });
    await expect(saved.getByRole("listitem")).toHaveCount(1);
    await expect(saved.getByRole("listitem")).toContainText(MONEY);
    await expect(saved.getByRole("listitem")).toContainText("1 item");
    await expect(
      page.getByText("Venda guardada neste aparelho.")
    ).toBeVisible();
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
    await expect(page.getByText("Vendas guardadas neste aparelho")).toHaveCount(
      0,
      { timeout: 20_000 }
    );
    // back online the form is the online one again
    await expect(page.getByLabel("Perfil de pagamento")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Confirmar venda" })
    ).toBeVisible();
  });

  test("com duas vendas guardadas, a mais nova vem primeiro e destacada, e cada linha diz o valor", async ({
    page,
  }) => {
    await openSaleLab(page, `user-${crypto.randomUUID()}`);
    await page.getByLabel("Rede disponível").uncheck();
    await fillShirtSale(page, 1);
    await keepSale(page).click();
    await expect(
      page.getByText("Venda guardada neste aparelho.")
    ).toBeVisible();
    await fillShirtSale(page, 3);
    await keepSale(page).click();

    const saved = page.getByRole("region", {
      name: "Vendas guardadas neste aparelho",
    });
    const lines = saved.getByRole("listitem");
    await expect(lines).toHaveCount(2);
    // the one kept just now is the first, and the only one that speaks as a status
    await expect(lines.first()).toContainText("Venda guardada neste aparelho.");
    await expect(lines.first()).toContainText(MONEY);
    await expect(lines.nth(1)).toContainText(MONEY);
    await expect(lines.nth(1)).not.toContainText("Venda guardada");
    await expect(saved.getByRole("status")).toHaveCount(1);
    // the supporting texts are said once
    await expect(page.getByText("Acompanhar em Pendências")).toHaveCount(1);
    await expect(
      page.getByText("O formulário abaixo foi reiniciado")
    ).toHaveCount(1);
    await expect(chip(page)).toContainText(
      "Sem conexão · 2 operações guardadas"
    );
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
      page.getByText("Saldo do aparelho. Receber, contar e baixar vão", {
        exact: false,
      })
    ).toBeVisible();
    await expect(shirtRow(page)).toContainText("Só com conexão");
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
      page.getByText("Saldo do aparelho. Receber, contar e baixar vão", {
        exact: false,
      })
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

/** The server answers the reads of the sale form, but the sale itself never gets an answer (or the one `confirm` gives). */
async function serveSaleReadsOnly(
  page: Page,
  confirm: (route: Route) => Promise<void> = (route) =>
    route.abort("connectionreset")
) {
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
  await page.route("**/rpc/sale/confirm", confirm);
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
    // the safe retry is the button below the notice; the notice points at it and ends with the discard (P-13)
    const notice = page.getByRole("alert").filter({
      has: page.getByRole("button", {
        name: "Guardar esta venda neste aparelho",
      }),
    });
    await expect(
      notice.getByText("toque em “Tentar novamente (seguro)”")
    ).toBeVisible();
    await expect(notice.getByRole("button").last()).toHaveText(
      "Descartar esta venda e começar outra"
    );
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

  test("o Worker em 5xx do runtime (cf-ray, sem motivo): a venda fica travada com os itens e o mesmo ID, repetir reenvia o mesmo pedido, guardar vai uma vez à fila e nada se descarta sozinho", async ({
    page,
  }) => {
    const commandIds: string[] = [];
    await serveSaleReadsOnly(page, (route) => {
      const { json } = route.request().postDataJSON() as {
        json: { commandId: string };
      };
      commandIds.push(json.commandId);
      // what Cloudflare answers for a Worker it killed: a 502 page with `cf-ray`, no Worker mark, no reason
      return route.fulfill({
        body: "<html>Error 1102 Worker exceeded resource limits</html>",
        contentType: "text/html",
        headers: { "cf-ray": "e2e-GRU" },
        status: 502,
      });
    });
    await openSaleLab(page, `user-${crypto.randomUUID()}`);

    await fillShirtSale(page, 2);
    await page.getByRole("button", { name: "Confirmar venda" }).click();

    const retry = page.getByRole("button", {
      name: "Tentar novamente (seguro)",
    });
    const keep = page.getByRole("button", {
      name: "Guardar esta venda neste aparelho",
    });
    await expect(retry).toBeVisible();
    await expect(keep).toBeVisible();
    await expect(page.getByLabel("Quantidade")).toBeDisabled();
    await expect(page.getByLabel("Quantidade")).toHaveValue("2");
    expect(commandIds).toHaveLength(1);

    // the safe retry sends the same request once and, with the Worker still down, the sale stays locked
    await retry.click();
    await expect.poll(() => commandIds.length).toBe(2);
    expect(commandIds[1]).toBe(commandIds[0]);
    await expect(retry).toBeVisible();
    await expect(keep).toBeVisible();
    await expect(page.getByLabel("Quantidade")).toHaveValue("2");
    // nothing was queued or discarded by itself
    await expect(page.getByTestId("server-records")).toHaveText("0");
    await expect(page.getByText("Vendas guardadas neste aparelho")).toHaveCount(
      0
    );

    await keep.click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Venda guardada neste aparelho" })
    ).toBeVisible();
    // the runtime is online: the queued command reaches the server once, and `confirm` is not called again
    await expect(page.getByTestId("server-records")).toHaveText("1", {
      timeout: 20_000,
    });
    expect(commandIds).toHaveLength(2);
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
    // the search by item needs the server: it stays in the "Filtrar" menu with its reason, and cannot be chosen
    const bar = page.getByRole("search", {
      exact: true,
      name: "Filtrar vendas",
    });
    const menu = page.getByRole("menu", { name: "Filtrar por" });
    await bar.getByRole("button", { exact: true, name: "Filtrar" }).click();
    await expect(
      menu.getByRole("menuitem", { name: "Produto vendido" })
    ).toHaveAttribute("aria-disabled", "true");
    await expect(
      menu.getByRole("menuitem", { name: "Produto vendido" })
    ).toContainText("Só com conexão");
    // touching it neither chooses it nor closes the menu
    await menu
      .getByRole("menuitem", { name: "Produto vendido" })
      .click({ force: true });
    await expect(menu).toBeVisible();
    await expect(
      page.getByRole("dialog", { name: "Produto vendido" })
    ).toHaveCount(0);
    await menu.getByRole("menuitem", { name: "Situação" }).click();
    const status = page.getByRole("dialog", { name: "Situação" });
    await status
      .getByRole("button", { exact: true, name: "Canceladas" })
      .click();
    // below 760 px the editor is the form Dialog: nothing applies before "Aplicar"
    await applyEditor(page, status);
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await bar.getByRole("button", { name: "Tirar o filtro Situação" }).click();
    await expect(list.getByRole("listitem")).toHaveCount(3);
    await bar.getByRole("button", { exact: true, name: "Filtrar" }).click();
    await menu.getByRole("menuitem", { name: "Cliente" }).click();
    const customer = page.getByRole("dialog", { name: "Cliente" });
    await customer.getByRole("textbox", { name: "Cliente" }).fill("angela");
    await customer
      .getByRole("button", { name: onPhone(page) ? "Aplicar" : "Pronto" })
      .click();
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await expect(list).toContainText("Ângela Souza");

    // back online it is the server's history again, with the links
    await page.getByLabel("Rede disponível").check();
    await bar.getByRole("button", { exact: true, name: "Filtrar" }).click();
    await expect(
      menu.getByRole("menuitem", { name: "Produto vendido" })
    ).not.toHaveAttribute("aria-disabled", "true");
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
    await chooseProfile(page, "Maquininha do laboratório");
    await expect(
      page.getByRole("combobox", { exact: true, name: "Perfil de pagamento" })
    ).toContainText("Maquininha do laboratório");
    // the summary names the profile the sale is priced with
    await expect(summary(page)).toContainText("Maquininha do laboratório");
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
    await chooseProfile(page, "Maquininha do laboratório");
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
    ).toContainText("Camiseta do laboratório · Azul");
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
    return route.fallback();
  });
  // counted as the page sends it: the route that cuts the network aborts before this one, so a count
  // in the handler would never see the press that the guard is meant to stop
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname.endsWith("/publicCatalog/saveProfile")
    ) {
      catalog.saves += 1;
    }
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
    return route.fallback();
  });
  // counted as the page sends it, even when the route that cuts the network aborts it (see serveCatalogSetup)
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/paymentProfile/create")) {
      server.creates += 1;
    }
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
        page.getByText(
          "Estas são as vendas mais recentes guardadas neste aparelho"
        )
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
        page.getByText("Saldo do aparelho. Receber, contar e baixar vão", {
          exact: false,
        })
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
      await page.getByRole("button", { name: "Novo perfil" }).click();
      await page.getByLabel("Nome do perfil").fill("Maquininha");
      const create = page.getByRole("button", { name: "Criar perfil" });
      await expect(create).toHaveAttribute("aria-disabled", "true");
      // the strip of the shell is under the veil of the form: the reason is said in the dialog, over the buttons
      await expect(create).toHaveAttribute(
        "aria-describedby",
        "connection-required-dialog-text"
      );
      await expect(create).toHaveAccessibleDescription(
        "Esta tela precisa de conexão. O que você digitou fica aqui enquanto esta página estiver aberta."
      );
      await expect(
        page.getByRole("dialog").getByText("Sem internet.")
      ).toBeVisible();
      // it also looks off (the Button base class), not just reads off
      await expect(create).toHaveCSS("opacity", "0.5");
      // focusable (the pattern of a control off with a reason): only the keyboard reaches it, since
      // pointer-events-none sends a click to what is below, so Enter on the focused button is the proof
      await create.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByLabel("Nome do perfil")).toHaveValue("Maquininha");
      // a request would leave a moment after the press: wait for it, so the proof does not pass by being early
      await page.waitForTimeout(500);
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
      // only the keyboard reaches it (a click falls to what is below), so focus and Enter
      await save.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByLabel("Nome público")).toHaveValue("Loja da Ana");
      await expect(page.getByText("Perfil salvo.")).toHaveCount(0);
      // a request would leave a moment after the press: wait for it, so the proof does not pass by being early
      await page.waitForTimeout(500);
      expect(catalog.saves).toBe(0);
    });
  });
}

/** A request counted as the page sends it, even when the route that cuts the network aborts it. */
function countRequests(page: Page, ends: string[]) {
  const sent: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (ends.some((end) => path.endsWith(end))) {
      sent.push(path);
    }
  });
  return sent;
}

/** A button that needs the connection while there is none: off to the eye and to the reader, but still focusable. */
async function expectOffWithReason(button: Locator) {
  await expect(button).toHaveAttribute("aria-disabled", "true");
  await expect(button).toHaveAttribute(
    "aria-describedby",
    "connection-required-text"
  );
  await expect(button).toHaveCSS("opacity", "0.5");
}

test.describe("P-2: Categorias e Despesas sem conexão", () => {
  test("Categorias: 'Adicionar categoria' fica desligado com o motivo, não envia e o nome fica", async ({
    page,
  }) => {
    await page.route("**/rpc/category/list", (route) =>
      route.fulfill(
        rpcAnswer({
          categories: [
            {
              archivedAt: null,
              createdAt: "2026-10-22T12:00:00.000Z",
              deletedAt: null,
              id: "0199c2d0-0000-7000-8000-0000000c0001",
              name: "Camisetas",
              organizationId: "0199c2d0-0000-7000-8000-00000000a001",
              status: "active",
              updatedAt: "2026-10-22T12:00:00.000Z",
            },
          ],
        })
      )
    );
    const sent = countRequests(page, ["/category/create"]);
    await openLab(page, `user-${crypto.randomUUID()}`, "categories");
    await start(page, "Categorias");
    await expect(page.getByText("Camisetas")).toBeVisible();
    await page.getByLabel("Nova categoria").fill("Calçados");
    await rede(page, "offline");
    await page
      .getByRole("button", { exact: true, name: "Sincronizar" })
      .click();
    await expect(page.getByText(WITH_FORM)).toBeVisible({ timeout: 15_000 });

    const add = page.getByRole("button", { name: "Adicionar categoria" });
    await expectOffWithReason(add);
    // only the keyboard reaches it (a click falls to what is below), so focus and Enter
    await add.focus();
    await page.keyboard.press("Enter");
    // a request would leave a moment after the press: wait for it, so the proof does not pass by being early
    await page.waitForTimeout(500);
    expect(sent).toEqual([]);
    await expect(page.getByLabel("Nova categoria")).toHaveValue("Calçados");

    // the menu of the row opens (it sends nothing); the items that send are off with the reason
    await page
      .getByRole("button", { name: "Mais ações para Camisetas" })
      .click();
    await expectOffWithReason(
      page.getByRole("menuitem", { exact: true, name: "Arquivar" })
    );
  });

  test("Despesas: registrar e anular ficam desligados com o motivo e não enviam", async ({
    page,
  }) => {
    const category = {
      archivedAt: null,
      createdAt: "2026-10-22T12:00:00.000Z",
      groupKey: "operational",
      id: "0199c2d0-0000-7000-8000-0000000c0002",
      name: "Aluguel",
      organizationId: "0199c2d0-0000-7000-8000-00000000a001",
      status: "active",
      systemKey: null,
      updatedAt: "2026-10-22T12:00:00.000Z",
      version: 1,
    };
    const expense = {
      amount: "100.00",
      categoryGroup: "operational",
      categoryId: category.id,
      categoryName: "Aluguel",
      competenceOn: "2026-10-10",
      createdAt: "2026-10-22T12:00:00.000Z",
      description: "Aluguel de outubro",
      id: "0199c2d0-0000-7000-8000-0000000c0003",
      organizationId: "0199c2d0-0000-7000-8000-00000000a001",
      payee: null,
      recurringRuleId: null,
      saleId: null,
      status: "active",
      updatedAt: "2026-10-22T12:00:00.000Z",
      version: 1,
      voidedAt: null,
    };
    await page.route("**/rpc/expense/listCategories", (route) =>
      route.fulfill(rpcAnswer({ categories: [category] }))
    );
    await page.route("**/rpc/expense/listRules", (route) =>
      route.fulfill(rpcAnswer({ rules: [] }))
    );
    await page.route("**/rpc/expense/list", (route) =>
      route.fulfill(
        rpcAnswer({
          count: 1,
          expenses: [expense],
          nextCursor: null,
          total: "100.00",
        })
      )
    );
    const sent = countRequests(page, ["/expense/create", "/expense/void"]);
    await openLab(page, `user-${crypto.randomUUID()}`, "expenses");
    await start(page, "Despesas");
    await expect(page.getByText("Aluguel de outubro")).toBeVisible();
    // the form is a dialog: what is typed and closed by Esc stays for the next opening
    const newExpense = page.getByRole("button", {
      exact: true,
      name: "Nova despesa",
    });
    await newExpense.click();
    const form = page.getByRole("dialog", { name: "Nova despesa" });
    await form.getByLabel("Descrição").fill("Internet");
    await page.keyboard.press("Escape");
    await expect(form).toHaveCount(0);
    await rede(page, "offline");
    await page
      .getByRole("button", { exact: true, name: "Sincronizar" })
      .click();
    await expect(page.getByText(WITH_FORM)).toBeVisible({ timeout: 15_000 });

    const voidIt = page.getByRole("button", {
      name: "Anular despesa Aluguel de outubro",
    });
    await expectOffWithReason(voidIt);
    await voidIt.focus();
    await page.keyboard.press("Enter");
    // "Nova despesa" and "Editar" only open the form: they stay on
    await expect(newExpense).not.toHaveAttribute("aria-disabled", "true");
    await expect(
      page.getByRole("button", { name: "Editar despesa Aluguel de outubro" })
    ).not.toHaveAttribute("aria-disabled", "true");

    // inside the dialog the reason is the dialog's own notice
    await newExpense.click();
    const save = form.getByRole("button", { name: "Registrar despesa" });
    await expect(save).toHaveAttribute("aria-disabled", "true");
    await expect(save).toHaveAttribute(
      "aria-describedby",
      "connection-required-dialog-text"
    );
    await expect(save).toHaveCSS("opacity", "0.5");
    await save.focus();
    await page.keyboard.press("Enter");
    // a request would leave a moment after the press: wait for it, so the proof does not pass by being early
    await page.waitForTimeout(500);
    expect(sent).toEqual([]);
    await expect(form.getByLabel("Descrição")).toHaveValue("Internet");
  });
});

test.describe("conexão com prova", () => {
  test("U-60: o POST cortado diz que não sabe, não reenvia, e a releitura mostra a lista", async ({
    page,
  }) => {
    const server = await serveProfiles(page);
    await openLab(page, `user-${crypto.randomUUID()}`, "payment-profiles");
    await start(page, "Formas de receber");
    await expect(page.getByText("Nenhum perfil cadastrado")).toBeVisible();
    // the server saves it, but the answer never comes back, and the network goes with it
    await page.route("**/rpc/paymentProfile/create", async (route) => {
      server.profiles.push({ name: "Maquininha" });
      await page.route("**/health", cutNetwork);
      await route.abort("connectionreset");
    });
    await page.getByRole("button", { name: "Novo perfil" }).click();
    await page.getByLabel("Nome do perfil").fill("Maquininha");
    await page.getByRole("button", { name: "Criar perfil" }).click();
    // the doubt is said inside the dialog, which is where the person is, with the way to check
    const dialog = page.getByRole("dialog", { name: "Novo perfil" });
    await expect(
      dialog.getByText(
        "Não deu para confirmar se o perfil foi salvo. Toque em Fechar e conferir: se ele não estiver na lista, abra de novo e salve."
      )
    ).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByLabel("Nome do perfil")).toHaveValue("Maquininha");

    await page.unroute("**/health", cutNetwork);
    // the list read on the return shows the saved profile (under the form, which is still open, so it is found by
    // its markup: the dialog hides the list from the reader)
    await expect(
      page.locator("li[data-profile-id]").filter({ hasText: "Maquininha" })
    ).toBeVisible({ timeout: 20_000 });

    // "Fechar e conferir" closes and keeps the draft: the list is there to be checked, and the doubt stays said
    await dialog.getByRole("button", { name: "Fechar e conferir" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Perfis cadastrados" })
    ).toContainText("Maquininha");
    await expect(
      page.getByText("Este perfil pode já ter sido salvo.")
    ).toBeVisible();

    // reopened: the draft is back with the doubt; sending it again first says the name is already on the list
    await page.getByRole("button", { name: "Novo perfil" }).click();
    await expect(dialog.getByLabel("Nome do perfil")).toHaveValue("Maquininha");
    await expect(
      dialog.getByText("Este perfil pode já ter sido salvo.")
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Criar perfil" }).click();
    await expect(
      dialog.getByText("Já existe um perfil chamado “Maquininha” na lista.")
    ).toBeVisible();
    await page.waitForTimeout(500);
    expect(server.creates).toBe(1); // read again, never sent again, and not even the second press went
    await expect(
      dialog.getByRole("button", { name: "Criar mesmo assim" })
    ).toBeVisible();
    // "Cancelar" throws the draft and the doubt away
    await dialog.getByRole("button", { exact: true, name: "Cancelar" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByText("Este perfil pode já ter sido salvo.")
    ).toHaveCount(0);
  });

  test("Perfis: a leitura cortada uma vez repete sozinha e abre sem o erro", async ({
    page,
  }) => {
    const server = await serveProfiles(page);
    let cuts = 0;
    await page.route("**/rpc/paymentProfile/list", async (route) => {
      if (cuts < 1) {
        cuts += 1;
        await route.abort("connectionreset");
        return;
      }
      await route.fallback();
    });
    await openLab(page, `user-${crypto.randomUUID()}`, "payment-profiles");
    await start(page, "Formas de receber");
    await expect(page.getByText("Nenhum perfil cadastrado")).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByRole("button", { name: "Tentar novamente" })
    ).toHaveCount(0);
    expect(cuts).toBe(1);
    expect(server.lists).toBeGreaterThanOrEqual(1);
  });

  test("Perfis: a leitura cortada três vezes, com /health respondendo, mostra o erro com Tentar novamente", async ({
    page,
  }) => {
    const server = await serveProfiles(page);
    let cuts = 0;
    await page.route("**/rpc/paymentProfile/list", async (route) => {
      // three tries (~1.5 s and ~4 s between them): only the third cut reaches the screen
      if (cuts < 3) {
        cuts += 1;
        await route.abort("connectionreset");
        return;
      }
      await route.fallback();
    });
    await openLab(page, `user-${crypto.randomUUID()}`, "payment-profiles");
    await start(page, "Formas de receber");
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
      page.getByText("Saldo do aparelho. Receber, contar e baixar vão", {
        exact: false,
      })
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
      page.getByText(
        "Estas são as vendas mais recentes guardadas neste aparelho"
      )
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
      page.getByText(
        "Estas são as vendas mais recentes guardadas neste aparelho"
      )
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
      page.getByText("Saldo do aparelho. Receber, contar e baixar vão", {
        exact: false,
      })
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
