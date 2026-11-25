import type { Page } from "@playwright/test";

/** The "…" menu of an active profile holds "Editar" and "Arquivar"; each item keeps the name the buttons had. */
export async function chooseProfileAction(
  page: Page,
  action: "Arquivar" | "Editar",
  profile: string
) {
  await page
    .getByRole("button", { name: `Mais ações para ${profile}` })
    .click();
  await page
    .getByRole("menuitem", { name: `${action} perfil ${profile}` })
    .click();
}
