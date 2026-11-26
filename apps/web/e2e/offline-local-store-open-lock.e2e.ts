/// <reference lib="dom" />

// Prova de integração de uma corrida entre abas: o tempo decide e, sem o lock, ela pode passar.
// A guarda determinística do lock é src/offline/local-store.test.ts.

import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

async function openLab(page: Page, user: string) {
  await page.goto("/offline-local-lab");
  await expect(
    page.getByRole("heading", { name: "Coleções locais" })
  ).toBeVisible();
  await page.getByLabel("Usuário").fill(user);
  await page.getByLabel("Organização").fill("org-1");
}

test("duas abas abrem o armazenamento local juntas logo depois de apagar os dados", async ({
  context,
}) => {
  const user = `user-${crypto.randomUUID()}`;
  const firstPage = await context.newPage();
  await openLab(firstPage, user);
  await firstPage
    .getByRole("button", { exact: true, name: "Abrir sem servidor" })
    .click();
  await expect(firstPage.getByTestId("message")).toContainText(
    "Abrir sem servidor: concluído",
    { timeout: 30_000 }
  );
  await firstPage
    .getByRole("button", { exact: true, name: "Apagar dados locais" })
    .click();
  await expect(firstPage.getByTestId("message")).toContainText(
    "Apagar dados locais: concluído",
    { timeout: 30_000 }
  );

  const secondPage = await context.newPage();
  await openLab(secondPage, user);
  const tabs = [firstPage, secondPage];
  await Promise.all(
    tabs.map((tab) =>
      tab
        .getByRole("button", { exact: true, name: "Abrir sem servidor" })
        .click()
    )
  );
  for (const tab of tabs) {
    // biome-ignore lint/performance/noAwaitInLoops: each tab is asserted in turn
    await expect(tab.getByTestId("message")).toContainText(
      "Abrir sem servidor: concluído",
      { timeout: 30_000 }
    );
    await expect(tab.getByTestId("meta-status")).toHaveText("vazio");
  }
});
