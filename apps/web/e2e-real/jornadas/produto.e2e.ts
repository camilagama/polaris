import { cents, numericCents } from "../oracle";
import { expect, openJourney, test } from "../fixtures";

/** Journey 2: category and product with its default variant and a list price, on screen; the price in cents. */
test("produto: categoria, produto e preço de tabela aparecem na lista e na venda", async ({ browser, sql }, testInfo) => {
  const journey = await openJourney(browser, testInfo, "produto");
  const { page } = journey;
  const categoryName = "Camisetas";
  const productName = "Camiseta básica";
  const price = "59,90";

  await page.goto("/categories");
  await page.getByLabel("Nova categoria").fill(categoryName);
  await page.getByRole("button", { name: "Adicionar categoria" }).click();
  await expect(page.getByRole("status").filter({ hasText: `Categoria “${categoryName}” criada.` })).toBeVisible();

  await page.goto("/products");
  await page.getByLabel("Nome do produto").fill(productName);
  await page.getByLabel("Categoria").selectOption({ label: categoryName });
  await page.getByRole("button", { name: "Cadastrar produto" }).click();
  await expect(page.getByRole("heading", { level: 3, name: productName })).toBeVisible();

  await page.getByRole("button", { name: "Variantes" }).click();
  await page.getByLabel("Preço de tabela — Variante padrão").fill(price);
  await page.getByRole("button", { name: "Salvar preço" }).click();
  await expect
    .poll(async () => {
      const row = (
        await sql.query<{ list_price: string | null; category: string | null }>(
          `SELECT v.list_price::text AS list_price, c.name AS category
             FROM products p JOIN product_variants v ON v.product_id = p.id LEFT JOIN categories c ON c.id = p.category_id
            WHERE p.organization_id = $1 AND p.name = $2`,
          [journey.organizationId, productName]
        )
      ).rows;
      return row.map((r) => ({ category: r.category, price: r.list_price === null ? null : numericCents(r.list_price) }));
    })
    .toEqual([{ category: categoryName, price: cents(price) }]);

  // the sale screen finds it, with the list price
  await page.goto("/sales");
  const item = page.getByRole("group", { name: "Item 1" });
  await item.getByLabel("Produto ou variante").fill("Camiseta");
  const option = item.getByRole("list", { name: "Variantes encontradas" }).getByRole("button", { name: new RegExp(productName) });
  await expect(option).toBeVisible();
  await option.click();
  await expect(item.getByLabel("Preço de tabela (R$)")).toHaveValue(price);
});
