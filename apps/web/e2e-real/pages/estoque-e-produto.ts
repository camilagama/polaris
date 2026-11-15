import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

const MUG_LINK = /^Caneca esmaltada, Variante padrão\. Abrir o produto$/;
const SEE_STOCK = /^Ver estoque$/;

/** The rows of the list of the stock screen. */
export const stockRows = (page: Page) =>
  page.getByRole("list", { name: "Saldos por variante" }).getByRole("listitem");

/**
 * From the stock to the product and back: the name of the row of the mug opens its dialog, and "Ver estoque" opens the
 * stock with the search holding the name, and only that row.
 */
export async function openMugAndSeeItsStock(page: Page): Promise<void> {
  await page.getByRole("link", { name: MUG_LINK }).click();
  const dialog = page.getByRole("dialog", { name: "Caneca esmaltada" });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await dialog.getByRole("link", { name: SEE_STOCK }).click();
  await expect(
    page.getByRole("heading", { exact: true, level: 1, name: "Estoque" })
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Buscar no estoque")).toHaveValue(
    "Caneca esmaltada"
  );
  await expect(stockRows(page)).toHaveCount(1, { timeout: 30_000 });
  await expect(stockRows(page).first()).toContainText("Caneca esmaltada");
}
