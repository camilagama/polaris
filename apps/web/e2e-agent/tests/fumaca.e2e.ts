import { test } from "@e2e-dev/web";
import { expect } from "e2e";

/** Sem modelo: a sessão por cookie abre a loja semeada e Produtos mostra o catálogo da semeadura. */
test("a loja semeada abre logada e mostra o catálogo em Produtos", {
  session: "bb-achados-2",
  tags: ["fumaca"],
}, async ({ app, screen }) => {
  await app.open("/products");
  await expect(
    screen.getByRole("button", { name: "Editar Camiseta básica" })
  ).toBeVisible();
});
