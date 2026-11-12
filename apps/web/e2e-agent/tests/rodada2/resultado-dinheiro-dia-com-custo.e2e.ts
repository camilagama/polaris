import { test } from "@e2e-dev/web";
import { expect } from "e2e";

/**
 * Controle do teste do Pix: a mesma venda em dinheiro, numa loja sem perfil de pagamento, também deixa o dia sem custo
 * informado, porque nenhuma venda tem taxa de processamento conhecida ("3 vendas sem taxa" no aviso). O teste falha
 * como o do Pix, o que mostra que o aviso não vem do meio de pagamento nem do custo do item.
 */
const CHOSEN = /^Trocar variante de/;
const SHIRT = /Camiseta/;
const DAILY_CHART = /^Vendas líquidas e custos por dia/;
const DAYS_WITHOUT_COST = /dias? sem custo informado/;
const ITEM_WITHOUT_COST = /(item|itens) sem custo conhecido/;
const CMV_ROW = /Custo das mercadorias vendidas/;
test("venda em dinheiro de item com custo não deixa 'dias sem custo informado'", {
  session: "bb-achados-7",
  tags: ["rodada2"],
}, async ({ app, screen }) => {
  await app.open("/sales");
  const product = screen.getByRole("combobox", { name: "Produto ou variante" });
  await product.fill("Camiseta");
  await screen.getByRole("option", { name: SHIRT }).first().tap();
  await expect(screen.getByRole("button", { name: CHOSEN })).toBeVisible();
  await screen
    .getByRole("radiogroup", { name: "Método de pagamento" })
    .getByRole("radio", { name: "Dinheiro" })
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
