import { test } from "@e2e-dev/web";
import { expect } from "e2e";

/**
 * Achado da área 1 (Venda): com as quantidades 2, 5 e 1 em três itens, o contador sob "Itens" diz "3 itens".
 * O explorador esperava as unidades (8). Este teste afirma o que o explorador esperava.
 */
const CHOSEN = /^Trocar variante de/;
test("contador sob Itens com três itens de quantidades 2, 5 e 1", {
  session: "bb-achados-1",
  tags: ["bugbash"],
}, async ({ app, screen }) => {
  await app.open("/sales");
  const products = ["Camiseta", "Boné", "Meia"];
  const quantities = ["2", "5", "1"];
  for (const [index, name] of products.entries()) {
    if (index > 0) {
      // biome-ignore lint/performance/noAwaitInLoops: um item de cada vez, como a pessoa monta a venda
      await screen.getByRole("button", { name: "Adicionar item" }).tap();
    }
    const product = screen
      .getByRole("combobox", { name: "Produto ou variante" })
      .last();
    await product.fill(name);
    await screen
      .getByRole("option", { name: new RegExp(name) })
      .first()
      .tap();
    await expect(
      screen.getByRole("button", { name: CHOSEN }).nth(index)
    ).toBeVisible();
    await screen
      .getByLabel("Quantidade")
      .nth(index)
      .fill(quantities[index] ?? "1");
  }
  await expect(screen.getByText("3 itens")).toBeHidden();
  await expect(screen.getByText("8 itens")).toBeVisible();
});
