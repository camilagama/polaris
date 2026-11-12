import { test } from "@e2e-dev/web";
import { expect } from "e2e";

/**
 * Achado da área 1 (confirmação da venda): ao trocar o Boné pela Meia, a linha manteve os preços do Boné (35,00);
 * aqui a troca é da Camiseta (49,90) pela Meia.
 * Esperado: depois de Trocar, o preço cobrado e o de tabela são os da variante escolhida (12,50).
 */
const CHOSEN = /^Trocar variante de/;
const SHIRT = /Camiseta/;
const SOCK = /Meia/;
const CHOSEN_SOCK = /^Trocar variante de Meia/;
test("Trocar a Camiseta pela Meia leva os preços da Meia", {
  session: "bb-achados-1",
  tags: ["rodada2"],
}, async ({ app, screen }) => {
  await app.open("/sales");
  const product = screen.getByRole("combobox", { name: "Produto ou variante" });
  await product.fill("Camiseta");
  await screen.getByRole("option", { name: SHIRT }).first().tap();
  await expect(screen.getByLabel("Preço cobrado")).toHaveValue("49,90");

  await screen.getByRole("button", { name: CHOSEN }).tap();
  await screen
    .getByRole("combobox", { name: "Produto ou variante" })
    .fill("Meia");
  await screen.getByRole("option", { name: SOCK }).first().tap();
  await expect(screen.getByRole("button", { name: CHOSEN_SOCK })).toBeVisible();
  await expect(screen.getByLabel("Preço cobrado")).toHaveValue("12,50");
  await expect(screen.getByLabel("Preço de tabela")).toHaveValue("12,50");
});
