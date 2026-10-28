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

test("venda-confirmar", async ({ evidence, page }) => {
  await page.goto("/sales");
  const item = page.getByRole("group", { exact: true, name: "Item 1" });
  await item.getByLabel("Produto ou variante").fill("Caneca");
  await item
    .getByRole("list", { name: "Variantes encontradas" })
    .getByRole("button", { name: MUG })
    .click();
  await item.getByLabel("Quantidade").fill("2");
  await item.getByLabel("Preço cobrado").fill("35,00");
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
  const row = page
    .getByRole("list", { name: "Saldos por variante" })
    .getByRole("listitem")
    .filter({ hasText: "Vela aromática" });
  const before = Number(await row.getByRole("definition").first().innerText());
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
  await expect(row.getByRole("definition").first()).toHaveText(
    String(before + 5)
  );
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
