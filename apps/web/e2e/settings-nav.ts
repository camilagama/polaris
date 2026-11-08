import type { Page } from "@playwright/test";

const PHONE_WIDTH = 760;

/** Below 760 px Configurações is a list of rows and each screen has "Voltar"; from there it is a strip of tabs. */
export const onPhone = (page: Page) =>
  (page.viewportSize()?.width ?? PHONE_WIDTH) < PHONE_WIDTH;

export const backToList = (page: Page) =>
  page.getByRole("link", { name: "Voltar para Configurações" });

/** Opens a screen of Configurações the way the width gives it: the tab, or on a phone "Voltar" and then the row. */
export async function openSettingsTab(page: Page, name: string) {
  if (!onPhone(page)) {
    await page.getByRole("tab", { exact: true, name }).click();
    return;
  }
  const back = backToList(page);
  if (await back.isVisible()) {
    await back.click();
  }
  await page.getByRole("link", { exact: true, name }).click();
}
