/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { attentionStates } from "./ui-device-states";
import { axeFaults } from "./ui-guardrails";
import { stockStates } from "./ui-stock-states";

/**
 * "Precisa de ação" on Estoque and Pendências, and the texts of Estoque: each link of the strip applies its filter
 * without leaving the screen; the strip is not there with nothing to do or without a connection; the help in the title
 * opens by click; the movement panel says the date of the last movement online and the device's balance offline; axe
 * finds nothing on either screen.
 */
const JEANS_PANEL =
  /Saldo atual: 3 · custo médio R\$ 62,40 · último movimento \d{2}\/\d{2}(\/\d{4})? \d{2}:\d{2}/;
const RECEIVE_JEANS = /^Receber estoque de Calça jeans/;
const RECEIVE_SHIRT = /^Receber estoque de Camiseta/;
const DEVICE_PANEL = /Saldo do aparelho: \d+ · custo médio só com conexão/;
const LAST_MOVEMENT = /último movimento/;
const strip = (page: Page) => page.locator('[data-slot="action-strip"]');

test.describe("Estoque, Precisa de ação", () => {
  test("a faixa diz os números e cada link aplica o seu filtro", async ({
    page,
  }) => {
    await stockStates.list(page);
    await expect(strip(page)).toContainText(
      "Precisa de ação1 variante sem saldo · 1 sem custo"
    );
    const rows = page.getByRole("list", { name: "Saldos por variante" });

    await strip(page)
      .getByRole("link", { name: "1 variante sem saldo" })
      .click();
    await expect(
      page.getByRole("tab", { name: "Sem saldo", selected: true })
    ).toBeVisible();
    await expect(rows.getByRole("listitem")).toHaveCount(1);
    await expect(rows).toContainText("Boné aba reta");
    await expect(
      page.getByRole("button", { name: "Sem custo" })
    ).toHaveAttribute("aria-pressed", "false");

    await strip(page).getByRole("link", { name: "1 sem custo" }).click();
    await expect(
      page.getByRole("tab", { name: "Todas", selected: true })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Sem custo" })
    ).toHaveAttribute("aria-pressed", "true");
    await expect(rows.getByRole("listitem")).toHaveCount(1);
    await expect(rows).toContainText("Camiseta do teste");
    // the strip counts the store, not the list: it stays while a filter is on
    await expect(strip(page)).toContainText(
      "1 variante sem saldo · 1 sem custo"
    );
  });

  test("o link da faixa limpa a busca e os arquivados, que o número não conta", async ({
    page,
  }) => {
    await stockStates.list(page);
    await page.getByLabel("Buscar no estoque").fill("jeans");
    await page.getByRole("checkbox", { name: "Incluir arquivados" }).click();
    await strip(page)
      .getByRole("link", { name: "1 variante sem saldo" })
      .click();
    await expect(page.getByLabel("Buscar no estoque")).toHaveValue("");
    await expect(
      page.getByRole("checkbox", { name: "Incluir arquivados" })
    ).not.toBeChecked();
    await expect(
      page.getByRole("tab", { name: "Sem saldo", selected: true })
    ).toBeVisible();
    await expect(
      page.getByRole("list", { name: "Saldos por variante" })
    ).toContainText("Boné aba reta");
  });

  test("os links levam o mesmo endereço do Início", async ({ page }) => {
    await stockStates.list(page);
    await expect(
      strip(page).getByRole("link", { name: "1 variante sem saldo" })
    ).toHaveAttribute("href", "/inventory?filtro=sem-saldo");
    await expect(
      strip(page).getByRole("link", { name: "1 sem custo" })
    ).toHaveAttribute("href", "/inventory?filtro=sem-custo");
  });

  test("sem itens a faixa não aparece, e sem conexão também não", async ({
    page,
  }) => {
    await stockStates.empty(page);
    await expect(strip(page)).toHaveCount(0);
    await stockStates.offline(page);
    await expect(strip(page)).toHaveCount(0);
  });

  test("o subtítulo virou a ajuda do título, e a lista perdeu o Atualizado", async ({
    page,
  }) => {
    await stockStates.list(page);
    await expect(
      page.getByText("Receba, conte ou baixe", { exact: false })
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Sobre Estoque" }).click();
    await expect(page.getByRole("dialog", { name: "Estoque" })).toContainText(
      "Receber, contar e baixar mudam o saldo aqui. Venda e devolução mudam sozinhas."
    );
    await page.keyboard.press("Escape");
    await expect(page.getByText("4 variantes", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Carregar mais" })
    ).toBeVisible();
    await expect(page.getByText("Atualizado", { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("checkbox", { name: "Incluir arquivados" })
    ).toBeVisible();
  });

  test("o painel diz a data do último movimento", async ({ page }) => {
    await stockStates.list(page);
    await page.getByRole("button", { name: RECEIVE_JEANS }).click();
    await expect(page.getByText(JEANS_PANEL)).toBeVisible();
  });

  test("sem conexão o painel diz o saldo do aparelho e o aviso é o curto", async ({
    page,
  }) => {
    await stockStates.offline(page);
    await expect(
      page.getByText(
        "Saldo do aparelho. Receber, contar e baixar vão quando a conexão voltar (veja Pendências). Custo médio só com conexão."
      )
    ).toBeVisible();
    await page.getByRole("button", { name: RECEIVE_SHIRT }).first().click();
    await expect(page.getByText(DEVICE_PANEL)).toBeVisible();
    await expect(page.getByText(LAST_MOVEMENT)).toHaveCount(0);
  });

  test("o axe não acusa a tela com a faixa", async ({ page }) => {
    await stockStates.list(page);
    await expect(strip(page)).toBeVisible();
    expect(await axeFaults(page)).toEqual([]);
  });
});

test.describe("Pendências, Precisa de ação", () => {
  test("a faixa abre a tela com os registros recusados e os que esperam", async ({
    page,
  }) => {
    await attentionStates.items(page);
    await expect(strip(page)).toContainText(
      "Precisa de ação3 registros recusados · 2 na fila atrás deles"
    );
    await expect(page.getByText("O servidor recusou")).toHaveCount(0);
    expect(await axeFaults(page)).toEqual([]);
  });

  test("sem pendências não há faixa", async ({ page }) => {
    await attentionStates.empty(page);
    await expect(strip(page)).toHaveCount(0);
    expect(await axeFaults(page)).toEqual([]);
  });
});
