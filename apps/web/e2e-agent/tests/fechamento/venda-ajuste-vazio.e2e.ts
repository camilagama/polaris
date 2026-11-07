import { test } from "@e2e-dev/web";
import { expect } from "e2e";

/**
 * Achado da área 1 (Venda): depois de digitar 10,00 e 500 no valor do desconto e apagar, o explorador leu
 * "R$ 15,00" no campo. Esperado: o campo fica vazio (o "15,00" cinza é o exemplo do campo, não um valor).
 */
const CHOSEN = /^Trocar variante de/;
test("valor do ajuste apagado depois de um desconto maior que o subtotal", {
  session: "bb-achados-1",
  tags: ["bugbash"],
}, async ({ app, screen }) => {
  await app.open("/sales");
  const product = screen.getByRole("combobox", { name: "Produto ou variante" });
  await product.fill("Camiseta");
  await product.press("Enter");
  await expect(screen.getByRole("button", { name: CHOSEN })).toBeVisible();

  await screen.getByRole("button", { name: "Alterar data e ajustes" }).tap();
  await screen.getByRole("button", { name: "Adicionar ajuste" }).tap();
  const value = screen.getByLabel("Valor (R$)").first();
  await value.fill("10,00");
  await value.fill("500");
  await value.clear();
  await expect(value).toHaveValue("");
});
