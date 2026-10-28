import type { Page } from "@playwright/test";
import { expect, test } from "../drive/fixture";

/**
 * The proven recipes of the feature map on the store `vendas` (`verify.sh seed vendas`): each test is one feature ID
 * of features/*.md, chosen with `--grep <id>`. Every one ends on the state that proves it, seen on screen.
 *
 *   VERIFY_LOJA=vendas verify.sh drive .claude/skills/verify-polaris/drives/receitas.verify.ts --grep venda-confirmar
 */

const CONFIRMED = /Venda confirmada|já estava confirmada/;
const RETURNED = /^Devolvido: /;
const RESTOCKED = /^Volta ao estoque: /;
const RETURN_REGISTERED = /^Devolução registrada: /;
const IMPORTED = /^Importamos 1 produto/;
const IMPORT_ONE = /^Importar 1 produto/;
const MUG = /Caneca esmaltada/;
const CANDLE = /Vela aromática/;
const EDIT_GOAL = /^Editar meta /;
const CANCELLED = /^Venda cancelada\. O estoque foi devolvido/;

/** Fills the "Nova venda" form with one item, paid in cash and with no payment profile, up to before "Confirmar venda". */
async function fillCashSale(
  page: Page,
  {
    price,
    product,
    quantity,
    search,
  }: { price: string; product: RegExp; quantity: string; search: string }
) {
  await page.goto("/sales");
  const item = page.getByRole("group", { exact: true, name: "Item 1" });
  await item.getByLabel("Produto ou variante").fill(search);
  await item
    .getByRole("list", { name: "Variantes encontradas" })
    .getByRole("button", { name: product })
    .click();
  await item.getByLabel("Quantidade").fill(quantity);
  await item.getByLabel("Preço cobrado").fill(price);
  await page
    .getByRole("radiogroup", { name: "Método de pagamento" })
    .getByRole("radio", { name: "Dinheiro" })
    .check();
  await page
    .getByRole("combobox", { exact: true, name: "Perfil de pagamento" })
    .click();
  await page
    .getByRole("option", { exact: true, name: "Sem perfil de pagamento" })
    .click();
}

/** The balance on the row of a product of the Estoque list: the first `definition` after the term "Saldo". */
function balanceOf(page: Page, product: string) {
  return page
    .getByRole("list", { name: "Saldos por variante" })
    .getByRole("listitem")
    .filter({ hasText: product })
    .getByRole("definition")
    .first();
}

test("venda-confirmar", async ({ evidence, page }) => {
  await fillCashSale(page, {
    price: "35,00",
    product: MUG,
    quantity: "2",
    search: "Caneca",
  });
  await evidence.shot("venda-preenchida", "Nova venda preenchida");
  await page.getByRole("button", { name: "Confirmar venda" }).click();
  await expect(page.getByRole("region", { name: CONFIRMED })).toBeVisible();
  await evidence.shot("venda-confirmada", "venda confirmada");
});

test("historico-detalhe", async ({ evidence, page }) => {
  await page.goto("/sales/history");
  await expect(
    page.getByRole("heading", { level: 1, name: "Histórico de vendas" })
  ).toBeVisible();
  await evidence.shot("historico-lista", "Histórico com as vendas da loja");
  await page
    .getByRole("list", { name: "Vendas" })
    .getByRole("link")
    .first()
    .click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Detalhe da venda" })
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Itens" })).toBeVisible();
  await evidence.shot(
    "historico-detalhe",
    "detalhe da venda aberto pelo Histórico"
  );
});

test("venda-devolver", async ({ evidence, page }) => {
  // a sale of its own, the newest of the Histórico: the first one of the list may be cancelled or already returned
  await fillCashSale(page, {
    price: "35,00",
    product: MUG,
    quantity: "2",
    search: "Caneca",
  });
  await page.getByRole("button", { name: "Confirmar venda" }).click();
  await expect(page.getByRole("region", { name: CONFIRMED })).toBeVisible();
  await page.goto("/sales/history");
  await page
    .getByRole("list", { name: "Vendas" })
    .getByRole("link")
    .first()
    .click();
  await page
    .getByRole("region", { name: "Devolução" })
    .getByRole("button", { name: "Registrar devolução" })
    .click();
  const panel = page.getByRole("region", { name: "Registrar devolução" });
  await panel.getByLabel(RETURNED).first().fill("1");
  await panel.getByLabel(RESTOCKED).first().fill("1");
  await panel.getByRole("button", { name: "Revisar devolução" }).click();
  await evidence.shot("devolucao-revisar", "devolução em revisão");
  await panel.getByRole("button", { name: "Confirmar devolução" }).click();
  await expect(page.getByText(RETURN_REGISTERED)).toBeVisible();
  await evidence.shot(
    "devolucao-registrada",
    "devolução registrada no detalhe"
  );
});

test("estoque-receber", async ({ evidence, page }) => {
  await page.goto("/inventory");
  const balance = balanceOf(page, "Vela aromática");
  const before = Number(await balance.innerText());
  await page
    .getByRole("button", {
      name: "Receber estoque de Vela aromática, Variante padrão",
    })
    .click();
  await page.getByLabel("Quantidade recebida").fill("5");
  await page.getByLabel("Custo unitário (R$)").fill("10,00");
  await page.getByRole("button", { exact: true, name: "Revisar" }).click();
  await evidence.shot("estoque-revisar", "recebimento de 5 em revisão");
  await page.getByRole("button", { name: "Confirmar recebimento" }).click();
  await expect(balance).toHaveText(String(before + 5));
  await evidence.shot(
    "estoque-recebido",
    `saldo de ${before} para ${before + 5}`
  );
});

test("cliente-criar", async ({ evidence, page }) => {
  const name = `Cliente fictício ${Date.now()}`;
  await page.goto("/customers");
  await page.getByRole("button", { name: "Novo cliente" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Novo cliente" });
  await dialog.getByLabel("Nome").fill(name);
  // a phone already in the store opens "Encontramos possíveis clientes existentes" instead of creating
  const digits = String(Date.now()).slice(-8);
  await dialog
    .getByLabel("Telefone")
    .fill(`11 9${digits.slice(0, 4)}-${digits.slice(4)}`);
  await dialog.getByRole("button", { name: "Cadastrar cliente" }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: `Cliente “${name}” cadastrado.` })
  ).toBeVisible();
  await evidence.shot("cliente-cadastrado", "cliente cadastrado, na lista");
});

test("produto-importar", async ({ evidence, page }) => {
  await page.goto("/products");
  await page.getByRole("button", { name: "Importar planilha" }).click();
  const dialog = page.getByRole("dialog", { name: "Importar planilha" });
  await expect(dialog.getByText("Passo 1 de 4 · Arquivo")).toBeVisible();
  await dialog.locator('input[type="file"]').setInputFiles({
    buffer: Buffer.from(
      `Nome;Preço de tabela;Quantidade;Custo de cada unidade\r\nBoné ${Date.now()};39,90;4;10,00\r\nCaneca esmaltada;35;;\r\n`,
      "utf8"
    ),
    mimeType: "text/csv",
    name: "produtos.csv",
  });
  await dialog.getByRole("button", { name: "Ver a prévia" }).click();
  await expect(dialog.getByText("Passo 2 de 4 · Prévia")).toBeVisible();
  await evidence.shot("importar-previa", "prévia: 1 entra, 1 já existe");
  await dialog.getByRole("button", { name: IMPORT_ONE }).click();
  await expect(
    dialog.getByRole("status").filter({ hasText: IMPORTED })
  ).toBeVisible({ timeout: 30_000 });
  await evidence.shot("importar-resultado", "resultado da importação");
});

test("estoque-contar", async ({ evidence, page }) => {
  await page.goto("/inventory");
  const balance = balanceOf(page, "Camiseta básica");
  const before = Number(await balance.innerText());
  const counted = before + 3;
  await page
    .getByRole("button", {
      name: "Contar estoque de Camiseta básica, Variante padrão",
    })
    .click();
  await page.getByLabel("Quantidade contada").fill(String(counted));
  await page.getByRole("button", { exact: true, name: "Revisar" }).click();
  await evidence.shot(
    "estoque-contar-revisar",
    `contagem de ${counted} em revisão`
  );
  await page.getByRole("button", { name: "Confirmar contagem" }).click();
  await expect(balance).toHaveText(String(counted));
  await evidence.shot(
    "estoque-contado",
    `saldo de ${before} para ${counted}, o contado`
  );
});

test("estoque-baixar", async ({ evidence, page }) => {
  await page.goto("/inventory");
  const balance = balanceOf(page, "Camiseta básica");
  const before = Number(await balance.innerText());
  await page
    .getByRole("button", {
      name: "Baixar estoque de Camiseta básica, Variante padrão",
    })
    .click();
  await page.getByLabel("Quantidade a baixar").fill("2");
  await page
    .getByRole("combobox", { exact: true, name: "Motivo da baixa" })
    .click();
  await page.getByRole("option", { exact: true, name: "Avariado" }).click();
  await page.getByRole("button", { exact: true, name: "Revisar" }).click();
  await evidence.shot(
    "estoque-baixar-revisar",
    "baixa de 2 por avaria em revisão"
  );
  await page.getByRole("button", { name: "Confirmar baixa" }).click();
  await expect(balance).toHaveText(String(before - 2));
  await evidence.shot(
    "estoque-baixado",
    `saldo de ${before} para ${before - 2}`
  );
});

test("venda-cancelar", async ({ evidence, page }) => {
  await page.goto("/inventory");
  const before = Number(await balanceOf(page, "Vela aromática").innerText());
  await fillCashSale(page, {
    price: "45,00",
    product: CANDLE,
    quantity: "1",
    search: "Vela",
  });
  await page.getByRole("button", { name: "Confirmar venda" }).click();
  await expect(page.getByRole("region", { name: CONFIRMED })).toBeVisible();
  await page.goto("/inventory");
  await expect(balanceOf(page, "Vela aromática")).toHaveText(
    String(before - 1)
  );
  await evidence.shot(
    "venda-cancelar-estoque-baixou",
    `saldo de ${before} para ${before - 1} com a venda`
  );

  // the sale just confirmed is the newest of the Histórico
  await page.goto("/sales/history");
  await page
    .getByRole("list", { name: "Vendas" })
    .getByRole("link")
    .first()
    .click();
  await expect(
    page.getByRole("region", { name: "Itens" }).getByText(CANDLE)
  ).toBeVisible();
  const cancel = page.getByRole("region", { name: "Cancelar venda" });
  await cancel.getByRole("button", { name: "Cancelar venda" }).click();
  await cancel.getByRole("button", { name: "Revisar cancelamento" }).click();
  await evidence.shot("venda-cancelar-revisar", "cancelamento em revisão");
  await cancel.getByRole("button", { name: "Confirmar cancelamento" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: CANCELLED })
  ).toBeVisible();
  await evidence.shot("venda-cancelada", "detalhe da venda cancelada");

  await page.goto("/inventory");
  await expect(balanceOf(page, "Vela aromática")).toHaveText(String(before));
  await evidence.shot(
    "venda-cancelar-estoque-voltou",
    `saldo de volta a ${before}`
  );
});

test("resultado-periodo", async ({ evidence, page }) => {
  await page.goto("/dashboard");
  await expect(
    page.getByRole("heading", { level: 1, name: "Resultado" })
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "Resultado", selected: true })
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Resultado estimado" })
  ).toBeVisible();
  await evidence.shot("resultado-mes", "Resultado de este mês");
  const period = page.getByRole("group", { name: "Período" });
  await period.getByRole("button", { name: "Últimos 30 dias" }).click();
  await expect(
    period.getByRole("button", { name: "Últimos 30 dias", pressed: true })
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Resultado estimado" })
  ).toBeVisible();
  await evidence.shot("resultado-30-dias", "Resultado dos últimos 30 dias");
});

test("despesas", async ({ evidence, page }) => {
  const description = `Aluguel verify ${Date.now()}`;
  await page.goto("/dashboard?aba=despesas");
  await page.getByRole("button", { exact: true, name: "Nova despesa" }).click();
  const dialog = page.getByRole("dialog", { name: "Nova despesa" });
  await dialog.getByLabel("Valor (R$)").fill("120,00");
  await dialog
    .getByRole("combobox", { exact: true, name: "Categoria" })
    .click();
  await page.getByRole("option", { exact: true, name: "Aluguel" }).click();
  await dialog.getByLabel("Descrição").fill(description);
  await evidence.shot("despesa-preenchida", "Nova despesa preenchida");
  await dialog.getByRole("button", { name: "Registrar despesa" }).click();
  await expect(page.getByText("Despesa registrada.")).toBeVisible();
  const list = page.getByRole("region", { name: "Despesas do período" });
  await expect(list.getByText(description)).toBeVisible();
  await evidence.shot("despesa-registrada", "despesa na lista do mês");

  // read again from the server: a reload shows the same expense
  await page.reload();
  await expect(
    page
      .getByRole("region", { name: "Despesas do período" })
      .getByText(description)
  ).toBeVisible();
  await evidence.shot("despesa-recarregada", "lista depois de recarregar");
});

test("metas", async ({ evidence, page }) => {
  // far above the month's sales: a goal that already reached its target is closed and cannot be edited
  const target = 50_000 + (Date.now() % 9000);
  const shown = new Intl.NumberFormat("pt-BR").format(target);
  await page.goto("/dashboard?aba=metas");
  const goals = page.getByRole("region", { exact: true, name: "Metas" });
  await expect(goals).toBeVisible({ timeout: 15_000 });
  // the Free plan keeps one goal in progress: the goal of an earlier run is edited instead of creating a second one
  const edit = goals.getByRole("button", { name: EDIT_GOAL });
  await expect(
    edit.first().or(goals.getByText("Nenhuma meta ainda"))
  ).toBeVisible({
    timeout: 15_000,
  });
  if ((await edit.count()) === 0) {
    await goals.getByRole("button", { name: "Nova meta" }).click();
    const dialog = page.getByRole("dialog", { name: "Nova meta" });
    await dialog.getByLabel("Nome").fill("Meta verify");
    await dialog.getByLabel("Alvo").fill("50.000,00");
    await evidence.shot("meta-preenchida", "Nova meta preenchida");
    await dialog.getByRole("button", { name: "Criar meta" }).click();
    await expect(page.getByText("Meta criada.")).toBeVisible();
    await evidence.shot("meta-criada", "meta criada, em andamento");
  }
  await edit.first().click();
  await goals.getByLabel("Alvo").fill(`${shown},00`);
  await evidence.shot("meta-editando", "alvo da meta em edição");
  await goals.getByRole("button", { name: "Salvar alterações" }).click();
  await expect(page.getByText("Meta atualizada.")).toBeVisible();
  await expect(goals).toContainText(`R$ ${shown},00`);
  await evidence.shot("meta-editada", `alvo da meta em R$ ${shown},00`);
});
