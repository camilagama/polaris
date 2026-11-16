import { test } from "@e2e-dev/web";
import { expect } from "e2e";

/**
 * Achado da área 1 (confirmação da venda): depois de confirmar uma venda em dinheiro, abrir a mais recente pelo
 * Histórico mostrou "Algo deu errado nesta tela". Esperado: o Detalhe da venda abre.
 */
const CHOSEN = /^Trocar variante de/;
const SHIRT = /Camiseta/;
const SHIRT_PRICE = /49,90/;
test("a venda recém confirmada abre o Detalhe pelo Histórico", {
  session: "bb-achados-2",
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

  await screen.getByRole("link", { name: "Histórico" }).first().tap();
  await screen.getByRole("link", { name: SHIRT_PRICE }).first().tap();
  await expect(
    screen.getByRole("heading", { name: "Detalhe da venda" })
  ).toBeVisible();
});
