/// <reference lib="dom" />

import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

async function openLab(page: Page) {
  await page.goto("/offline-local-lab");
  await expect(
    page.getByRole("heading", { name: "Coleções locais" })
  ).toBeVisible();
}

async function useNamespace(page: Page, user: string, organization: string) {
  await page.getByLabel("Usuário").fill(user);
  await page.getByLabel("Organização").fill(organization);
}

async function run(page: Page, button: string, done: RegExp | string) {
  await page.getByRole("button", { exact: true, name: button }).click();
  await expect(page.getByTestId("message")).toContainText(done, {
    timeout: 30_000,
  });
}

async function expectCounts(
  page: Page,
  counts: Partial<Record<string, number>>
) {
  for (const [name, value] of Object.entries(counts)) {
    // biome-ignore lint/performance/noAwaitInLoops: each count is asserted in turn
    await expect(page.getByTestId(`count-${name}`)).toHaveText(String(value));
  }
}

const FULL = {
  categories: 25,
  customers: 8,
  inventory: 12,
  products: 12,
  recentSales: 3,
  variants: 12,
};

test("sincroniza as coleções do zero e termina pronto no cursor", async ({
  page,
}) => {
  await openLab(page);
  await useNamespace(page, `user-${crypto.randomUUID()}`, "org-1");
  await run(page, "Sincronizar", "Sincronizar: concluído");
  await expectCounts(page, FULL);
  await expect(page.getByTestId("meta-status")).toHaveText("ready");
  await expect(page.getByTestId("meta-cursor")).toHaveText("0");
  await expect(page.getByTestId("sample-product")).toHaveText("Produto 1");
});

test("os dados continuam no disco depois de recarregar, sem servidor", async ({
  page,
}) => {
  const user = `user-${crypto.randomUUID()}`;
  await openLab(page);
  await useNamespace(page, user, "org-1");
  await run(page, "Sincronizar", "Sincronizar: concluído");

  await page.reload();
  await openLab(page);
  await useNamespace(page, user, "org-1");
  await run(page, "Abrir sem servidor", "Abrir sem servidor: concluído");
  await expectCounts(page, FULL);
  await expect(page.getByTestId("meta-status")).toHaveText("ready");
});

test("aplica as mudanças do servidor a partir do cursor", async ({ page }) => {
  await openLab(page);
  await useNamespace(page, `user-${crypto.randomUUID()}`, "org-1");
  await run(page, "Sincronizar", "Sincronizar: concluído");

  await page.getByRole("button", { name: "Alterar servidor" }).click();
  await run(page, "Aplicar mudanças", "Aplicar mudanças: concluído");

  await expect(page.getByTestId("count-categories")).toHaveText("26");
  await expect(page.getByTestId("count-customers")).toHaveText("7");
  await expect(page.getByTestId("sample-product")).toHaveText(
    "Produto renomeado no servidor"
  );
  await expect(page.getByTestId("meta-cursor")).toHaveText("3");
  await expect(page.getByTestId("meta-status")).toHaveText("ready");
});

test("um bootstrap interrompido continua marcado como em andamento e termina na próxima vez", async ({
  page,
}) => {
  const user = `user-${crypto.randomUUID()}`;
  await openLab(page);
  await useNamespace(page, user, "org-1");
  await page.getByLabel("Falhar na coleção").selectOption("inventory");
  await run(page, "Sincronizar", "falhou");
  await expect(page.getByTestId("meta-status")).toHaveText("bootstrapping");
  await expect(page.getByTestId("count-categories")).toHaveText("25");
  await expect(page.getByTestId("count-inventory")).toHaveText("0");

  await page.reload();
  await openLab(page);
  await useNamespace(page, user, "org-1");
  await run(page, "Abrir sem servidor", "Abrir sem servidor: concluído");
  await expect(page.getByTestId("meta-status")).toHaveText("bootstrapping");

  await page.getByLabel("Falhar na coleção").selectOption("");
  await run(page, "Sincronizar", "Sincronizar: concluído");
  await expect(page.getByTestId("meta-status")).toHaveText("ready");
  await expectCounts(page, FULL);
});

test("usuários e organizações diferentes não enxergam os dados uns dos outros", async ({
  page,
}) => {
  const first = `user-${crypto.randomUUID()}`;
  const second = `user-${crypto.randomUUID()}`;
  await openLab(page);
  await useNamespace(page, first, "org-1");
  await run(page, "Sincronizar", "Sincronizar: concluído");
  await expectCounts(page, FULL);

  await useNamespace(page, second, "org-1");
  await run(page, "Abrir sem servidor", "Abrir sem servidor: concluído");
  await expectCounts(page, { categories: 0, products: 0, recentSales: 0 });
  await expect(page.getByTestId("meta-status")).toHaveText("vazio");

  await useNamespace(page, first, "org-2");
  await run(page, "Abrir sem servidor", "Abrir sem servidor: concluído");
  await expectCounts(page, { categories: 0, products: 0 });

  await useNamespace(page, first, "org-1");
  await run(page, "Abrir sem servidor", "Abrir sem servidor: concluído");
  await expectCounts(page, FULL);
});

test("apagar os dados locais remove só o namespace escolhido", async ({
  page,
}) => {
  const first = `user-${crypto.randomUUID()}`;
  const second = `user-${crypto.randomUUID()}`;
  await openLab(page);
  await useNamespace(page, first, "org-1");
  await run(page, "Sincronizar", "Sincronizar: concluído");
  await useNamespace(page, second, "org-1");
  await run(page, "Sincronizar", "Sincronizar: concluído");

  await useNamespace(page, first, "org-1");
  await run(page, "Apagar dados locais", "Apagar dados locais: concluído");
  await expect(page.getByTestId("removed-files")).not.toHaveText("0");
  await expect(page.getByTestId("removed-files")).not.toHaveText("-");
  await run(page, "Abrir sem servidor", "Abrir sem servidor: concluído");
  await expectCounts(page, { categories: 0, products: 0 });
  await expect(page.getByTestId("meta-status")).toHaveText("vazio");

  await useNamespace(page, second, "org-1");
  await run(page, "Abrir sem servidor", "Abrir sem servidor: concluído");
  await expectCounts(page, FULL);
});
