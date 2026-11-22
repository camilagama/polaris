import type { Page } from "@playwright/test";

/** Opens the "Ações" menu of the title of the sale detail and chooses one of its items. */
export async function openSaleAction(page: Page, item: string) {
  await page.getByRole("button", { exact: true, name: "Ações" }).click();
  await page.getByRole("menuitem", { exact: true, name: item }).click();
}
