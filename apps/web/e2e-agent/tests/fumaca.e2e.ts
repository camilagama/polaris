import { test } from "@e2e-dev/web";
import { expect } from "e2e";

/** Sem modelo: a sessão por cookie abre a loja semeada e a venda mostra o catálogo da semeadura. */
test("a loja semeada abre logada e mostra o catálogo na venda", {
  session: "bb-achados-2",
  tags: ["fumaca"],
}, async ({ app, screen }) => {
  await app.open("/sales");
  await expect(screen.getByText("Camiseta básica").first()).toBeVisible();
});
