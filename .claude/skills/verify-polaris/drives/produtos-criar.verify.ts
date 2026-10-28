import { expect, test } from "../drive/fixture";

/**
 * features/produtos.md, `produto-criar`: the person opens Produtos from the menu, creates a product with price and
 * opening stock in the "Novo produto" dialog, and sees it in the list; a reload shows it again (it was saved on the
 * server, not only drawn). One product per project, so each width and theme proves its own.
 */
test("produtos: criar um produto e vê-lo na lista", async ({
  evidence,
  page,
}, testInfo) => {
  const productName = `Camiseta ${testInfo.project.name}`;
  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: "Início" })
  ).toBeVisible();

  // the user's path to Produtos: the sidebar on the desktop; on the phone, "Mais" and then the menu inside it
  if (testInfo.project.name.startsWith("celular")) {
    await page.getByRole("button", { exact: true, name: "Mais" }).click();
    await page
      .getByRole("dialog", { name: "Mais" })
      .getByRole("link", { exact: true, name: "Produtos" })
      .click();
  } else {
    await page
      .getByRole("navigation", { exact: true, name: "Principal" })
      .getByRole("link", { exact: true, name: "Produtos" })
      .click();
  }
  await expect(
    page.getByRole("heading", { level: 1, exact: true, name: "Produtos" })
  ).toBeVisible();
  await evidence.shot(
    "produtos-antes",
    "Produtos aberto pelo menu, antes de criar"
  );

  await page.getByRole("button", { name: "Novo produto" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Novo produto" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Nome do produto").fill(productName);
  await dialog.getByLabel("Preço de tabela").fill("59,90");
  await dialog.getByLabel("Quantos você tem agora").fill("10");
  await dialog.getByLabel("Custo de cada unidade").fill("12,50");
  await evidence.shot("produtos-dialog", "Dialog Novo produto preenchido");
  await dialog.getByRole("button", { name: "Cadastrar produto" }).click();

  const row = page.locator("[data-product-id]", { hasText: productName });
  await expect(row).toBeVisible();
  await expect(dialog).toBeHidden();
  await evidence.shot(
    "produtos-depois",
    `"${productName}" na lista após cadastrar`
  );

  await page.reload();
  await expect(
    page.locator("[data-product-id]", { hasText: productName })
  ).toBeVisible();
  await evidence.shot(
    "produtos-recarregado",
    "lista depois de recarregar a página (veio do servidor)"
  );
});
