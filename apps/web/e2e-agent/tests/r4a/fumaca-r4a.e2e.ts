import { test } from "@e2e-dev/web";
import { expect } from "e2e";

/** Sem modelo: a sessão por cookie abre a loja semeada e Vender mostra o campo de produto. */
test("a loja semeada abre logada em Vender", {
  session: "bb-r4a-achados-1",
  tags: ["fumaca-r4a"],
}, async ({ app, screen }) => {
  await app.open("/sales");
  await expect(
    screen.getByRole("combobox", { name: "Produto ou variante" })
  ).toBeVisible();
});
