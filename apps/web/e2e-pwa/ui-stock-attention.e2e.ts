/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { attentionStates } from "./ui-device-states";
import { axeFaults } from "./ui-guardrails";
import { stockStates } from "./ui-stock-states";

/**
 * "Precisa de ação" on Estoque and Pendências, and the texts of Estoque: each link of the strip applies its filter
 * without leaving the screen; the strip is not there with nothing to do or without a connection; the help in the title
 * opens by click; the movement panel opened in a row does not repeat the balance the row says, and says the date of the last movement in the review online; axe
 * finds nothing on either screen.
 */
const JEANS_PANEL = /^Saldo atual: 3 · custo médio R\$ 62,40$/;
const LAST_MOVEMENT_DATE = /^\d{2}\/\d{2}(\/\d{4})? \d{2}:\d{2}$/;
const RECEIVE_JEANS = /^Receber estoque de Calça jeans/;
const RECEIVE_SHIRT = /^Receber estoque de Camiseta/;
const DEVICE_PANEL = /Saldo do aparelho: \d+ · custo médio só com conexão/;
const LAST_MOVEMENT = /último movimento/;
const strip = (page: Page) => page.locator('[data-slot="action-strip"]');

const bar = (page: Page) =>
  page.getByRole("search", { exact: true, name: "Filtrar estoque" });

/** The pills of the bar in order, named as their buttons name them (a filter the person can still edit ends in ", editar"). */
async function expectPills(page: Page, pills: string[]) {
  await expect
    .poll(() =>
      bar(page)
        .locator('[data-slot="filter-pill"] button:not([aria-label^="Tirar"])')
        .evaluateAll((buttons) =>
          buttons.map((button) =>
            (button.getAttribute("aria-label") ?? "").replace(", editar", "")
          )
        )
    )
    .toEqual(pills);
}

/** Chooses a field in the "Filtrar" menu and the option in its editor. */
async function addFilter(page: Page, field: string, option: string) {
  await bar(page).getByRole("button", { exact: true, name: "Filtrar" }).click();
  await page
    .getByRole("menu", { name: "Filtrar por" })
    .getByRole("menuitem", { name: new RegExp(`^${field}`) })
    .click();
  const editor = page.getByRole("dialog", { name: field });
  await expect(editor).toBeVisible();
  await editor.getByRole("button", { exact: true, name: option }).click();
  const apply = editor.getByRole("button", { exact: true, name: "Aplicar" });
  if ((await apply.count()) > 0) {
    await apply.click();
  }
  await expect(editor).toHaveCount(0);
}

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
    await expectPills(page, ["Saldo: Sem saldo"]);
    await expect(rows.getByRole("listitem")).toHaveCount(1);
    await expect(rows).toContainText("Boné aba reta");

    await strip(page).getByRole("link", { name: "1 sem custo" }).click();
    await expectPills(page, ["Custo: Desconhecido"]);
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
    await addFilter(page, "Arquivados", "Incluir");
    await expectPills(page, ["Arquivados: Incluir"]);
    await strip(page)
      .getByRole("link", { name: "1 variante sem saldo" })
      .click();
    await expect(page.getByLabel("Buscar no estoque")).toHaveValue("");
    await expectPills(page, ["Saldo: Sem saldo"]);
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

  test("se a leitura da faixa falha, a linha diz que os avisos estão indisponíveis", async ({
    page,
  }) => {
    await stockStates.attentionUnavailable(page);
    await expect(strip(page)).toHaveCount(0);
    await expect(
      page.getByText("Avisos do estoque indisponíveis agora.")
    ).toBeVisible();
    await expect(
      page.getByRole("list", { name: "Saldos por variante" })
    ).toContainText("Camiseta do teste");
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
    await expect(
      page.getByText("Mostrando 4 variantes", { exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Carregar mais" })
    ).toBeVisible();
    await expect(page.getByText("Atualizado", { exact: true })).toHaveCount(0);
    await expect(
      bar(page).getByRole("button", { exact: true, name: "Filtrar" })
    ).toBeVisible();
  });

  test("o painel dentro do cartão não repete o saldo e o custo, e a data do último movimento vem na revisão", async ({
    page,
  }) => {
    await stockStates.list(page);
    await page.getByRole("button", { name: RECEIVE_JEANS }).click();
    await expect(
      page.getByRole("heading", { name: "Receber estoque" })
    ).toBeVisible();
    await expect(page.getByText(JEANS_PANEL)).toHaveCount(0);
    await expect(page.getByText(LAST_MOVEMENT)).toHaveCount(0);
    await page.getByLabel("Custo unitário (R$)").fill("12,50");
    await page.getByRole("button", { exact: true, name: "Revisar" }).click();
    await expect(
      page.getByText("Último movimento", { exact: true })
    ).toBeVisible();
    await expect(page.getByText(LAST_MOVEMENT_DATE)).toBeVisible();
  });

  test("sem conexão o painel dentro do cartão não repete o saldo do aparelho e o aviso é o curto", async ({
    page,
  }) => {
    await stockStates.offline(page);
    await expect(
      page.getByText(
        "Saldo do aparelho. Receber, contar e baixar vão quando a conexão voltar (veja Pendências). Custo médio só com conexão."
      )
    ).toBeVisible();
    await page.getByRole("button", { name: RECEIVE_SHIRT }).first().click();
    await expect(
      page.getByRole("heading", { name: "Receber estoque" })
    ).toBeVisible();
    await expect(page.getByText(DEVICE_PANEL)).toHaveCount(0);
    await expect(page.getByText(LAST_MOVEMENT)).toHaveCount(0);
  });

  test("o axe não acusa a tela com a faixa", async ({ page }) => {
    await stockStates.list(page);
    await expect(strip(page)).toBeVisible();
    expect(await axeFaults(page)).toEqual([]);
  });

  test("o axe não acusa a barra Filtrar estoque: fechada, com o menu aberto e com pílulas", async ({
    page,
  }) => {
    await stockStates.list(page);
    const open = bar(page).getByRole("button", {
      exact: true,
      name: "Filtrar",
    });
    await expect(open).toBeVisible();
    expect(await axeFaults(page)).toEqual([]);
    await open.click();
    await expect(page.getByRole("menu", { name: "Filtrar por" })).toBeVisible();
    expect(await axeFaults(page)).toEqual([]);
    await page.keyboard.press("Escape");
    await addFilter(page, "Saldo", "Sem saldo");
    await addFilter(page, "Arquivados", "Incluir");
    await expectPills(page, ["Saldo: Sem saldo", "Arquivados: Incluir"]);
    await expect(
      bar(page).getByRole("button", { name: "Limpar tudo" })
    ).toBeVisible();
    expect(await axeFaults(page)).toEqual([]);
  });

  test("o axe não acusa o menu da barra sem conexão, com o motivo do custo", async ({
    page,
  }) => {
    await stockStates.offline(page);
    await bar(page)
      .getByRole("button", { exact: true, name: "Filtrar" })
      .click();
    await expect(page.getByRole("menu", { name: "Filtrar por" })).toContainText(
      "Só com conexão"
    );
    expect(await axeFaults(page)).toEqual([]);
  });
});

test.describe("Pendências, Precisa de ação", () => {
  test("a faixa abre a tela com os registros recusados e os que esperam", async ({
    page,
  }) => {
    await attentionStates.items(page);
    await expect(strip(page)).toContainText(
      "Precisa de ação4 registros recusados · 2 na fila atrás deles"
    );
    // the subtitle of the page also says "o servidor recusou"; the cards are the list, and only the refusal of the access says it there, by design: no card repeats a raw server message
    await expect(
      page.getByRole("list").getByText("O servidor recusou")
    ).toHaveCount(1);
    expect(await axeFaults(page)).toEqual([]);
  });

  test("o erro da tentativa fica abaixo da confirmação e abaixo das ações, para o botão não descer", async ({
    page,
  }) => {
    await attentionStates.discarding(page);
    const card = page.getByRole("listitem").first();
    const failure = card.getByRole("alert");
    await expect(failure).toContainText("Não foi possível reenviar");
    const top = async (locator: typeof failure) =>
      (await locator.boundingBox())?.y ?? Number.NaN;
    const confirmation = card.getByRole("alertdialog");
    expect(await top(failure)).toBeGreaterThan(await top(confirmation));

    await card.getByRole("button", { name: "Manter" }).click();
    const resubmit = card.getByRole("button", { name: "Reenviar venda" });
    await expect(resubmit).toBeVisible();
    expect(await top(failure)).toBeGreaterThan(await top(resubmit));
  });

  test("sem pendências não há faixa", async ({ page }) => {
    await attentionStates.empty(page);
    await expect(strip(page)).toHaveCount(0);
    expect(await axeFaults(page)).toEqual([]);
  });
});
