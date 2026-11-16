import { test } from "@e2e-dev/web";
import { expect } from "e2e";

/**
 * Achado da área 4 (Primeiros passos), no caminho do explorador: loja nova, produto cadastrado com 10 unidades a
 * R$ 10,00 cada, duas vendidas no Pix. Ele leu "1 de 12 dias sem custo informado" no Resultado com o CMV de R$ 20,00
 * na cadeia e esperava que o aviso não falasse de custo. Este teste afirma o que o explorador esperava.
 */
const CHOSEN = /^Trocar variante de/;
const LIST_PRICE = /^Preço de tabela/;
const QUANTITY_NOW = /^Quantos você tem agora/;
const UNIT_COST = /^Custo de cada unidade/;
const MUG = /Caneca/;
const DAILY_CHART = /^Vendas líquidas e custos por dia/;
const DAYS_WITHOUT_COST = /dias? sem custo informado/;
const ITEM_WITHOUT_COST = /(item|itens) sem custo conhecido/;
const CMV_ROW = /Custo das mercadorias vendidas/;
test("loja nova: venda no Pix de produto com custo não deixa 'dias sem custo informado'", {
  session: "bb-r2-pix-vazia",
  tags: ["rodada2"],
}, async ({ app, screen }) => {
  await app.open("/products?novo=1");
  await screen.getByLabel("Nome do produto").fill("Caneca teste");
  await screen.getByLabel(LIST_PRICE).fill("25,00");
  await screen.getByLabel(QUANTITY_NOW).fill("10");
  await screen.getByLabel(UNIT_COST).fill("10,00");
  await screen.getByRole("button", { name: "Cadastrar produto" }).tap();
  await expect(
    screen.getByRole("button", { name: "Editar Caneca teste" })
  ).toBeVisible();

  await app.open("/sales");
  const product = screen.getByRole("combobox", { name: "Produto ou variante" });
  await product.fill("Caneca");
  await screen.getByRole("option", { name: MUG }).first().tap();
  await expect(screen.getByRole("button", { name: CHOSEN })).toBeVisible();
  await screen.getByLabel("Quantidade").fill("2");
  await screen
    .getByRole("radiogroup", { name: "Método de pagamento" })
    .getByRole("radio", { name: "Pix" })
    .tap();
  await screen.getByRole("button", { name: "Confirmar venda" }).tap();
  await expect(
    screen.getByRole("link", { name: "Ver detalhes e histórico da venda" })
  ).toBeVisible();

  await app.open("/dashboard");
  await expect(screen.getByRole("img", { name: DAILY_CHART })).toBeVisible();
  await expect(screen.getByRole("row", { name: CMV_ROW })).toBeVisible();
  await expect(screen.getByText(ITEM_WITHOUT_COST)).toBeHidden();
  await expect(screen.getByText(DAYS_WITHOUT_COST).first()).toBeHidden();
});
