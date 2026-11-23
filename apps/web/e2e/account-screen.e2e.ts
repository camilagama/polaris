/// <reference lib="dom" />

import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { axeFaults } from "../e2e-pwa/ui-guardrails/measures";
import { authMethods, serve } from "./shell-server";

/**
 * Minha conta (`/conta`): Senha and Aparelhos, from the menu of the circle. This build has the offline runtime on, so
 * Aparelhos is always there and the password decides Senha. The other two combinations of `passwordOn` and `offline`
 * (offline off, with or without the password) are the build's flag and cannot change in the browser: they are the
 * cases of `accountTabsShown` in `settings-tabs.test.ts`.
 */
const STORE_MENU_NAME = /^Loja, conta e ajuda: /;
const AT_ACCOUNT = /\/conta$/;
const AT_DEVICES = /\/conta\?aba=aparelhos$/;
const SMALL = { height: 740, width: 360 };
const LARGE = { height: 800, width: 1280 };

const storeMenu = (page: Page) =>
  page.getByRole("button", { name: STORE_MENU_NAME });
const tabs = (page: Page) => page.getByRole("tablist", { name: "Minha conta" });
const tab = (page: Page, name: string) =>
  tabs(page).getByRole("tab", { exact: true, name });
const title = (page: Page) =>
  page.getByRole("heading", { exact: true, level: 1, name: "Minha conta" });

async function open(
  page: Page,
  address: string,
  { passwordOn, size }: { passwordOn: boolean; size: typeof LARGE }
) {
  await page.setViewportSize(size);
  await serve(page);
  await authMethods(page, passwordOn);
  await page.goto(address);
}

for (const [where, size] of [
  ["360 px", SMALL],
  ["1280 px", LARGE],
] as const) {
  test(`${where}: Minha conta é um item do menu do círculo e abre a tela`, async ({
    page,
  }) => {
    await open(page, "/", { passwordOn: true, size });
    await storeMenu(page).click();
    const item = page.getByRole("menuitem", {
      exact: true,
      name: "Minha conta",
    });
    await expect(item).toHaveAttribute("href", "/conta");
    await item.click();
    await expect(page).toHaveURL(AT_ACCOUNT);
    await expect(title(page)).toBeVisible();
    await expect(page.getByRole("menu")).toHaveCount(0);
  });
}

test("a lateral e a barra de baixo não têm Minha conta: ela só abre pelo menu do círculo", async ({
  page,
}) => {
  await open(page, "/", { passwordOn: true, size: LARGE });
  await expect(
    page
      .getByRole("navigation", { exact: true, name: "Principal" })
      .getByRole("link", { name: "Minha conta" })
  ).toHaveCount(0);
});

test("com a senha ligada e o runtime offline há duas abas, Senha primeiro, e o endereço sem aba abre Senha", async ({
  page,
}) => {
  await open(page, "/conta", { passwordOn: true, size: LARGE });
  await expect(title(page)).toBeVisible();
  await expect(tabs(page).getByRole("tab")).toHaveText(["Senha", "Aparelhos"]);
  await expect(tab(page, "Senha")).toHaveAttribute("aria-selected", "true");
  await tab(page, "Aparelhos").click();
  await expect(page).toHaveURL(AT_DEVICES);
  await expect(tab(page, "Aparelhos")).toHaveAttribute("aria-selected", "true");
  await tab(page, "Senha").click();
  await expect(page).toHaveURL(AT_ACCOUNT);
});

test("a 360 px as duas abas ficam na faixa, sem a lista de linhas de Configurações", async ({
  page,
}) => {
  await open(page, "/conta", { passwordOn: true, size: SMALL });
  await expect(tabs(page).getByRole("tab")).toHaveText(["Senha", "Aparelhos"]);
  await expect(page.locator("[data-settings-row]")).toHaveCount(0);
});

test("com uma aba só não há faixa nem título repetido: Minha conta e o conteúdo de Aparelhos", async ({
  page,
}) => {
  await open(page, "/conta?aba=aparelhos", {
    passwordOn: false,
    size: LARGE,
  });
  await expect(title(page)).toBeVisible();
  await expect(page.getByRole("tablist")).toHaveCount(0);
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Minha conta" })).toHaveCount(
    1
  );
  await expect(page.getByRole("heading", { name: "Aparelhos" })).toHaveCount(1);
  expect(await axeFaults(page)).toEqual([]);
});

test("o endereço de uma aba que a pessoa não tem não mostra tela vazia: Senha com a senha desligada abre Aparelhos", async ({
  page,
}) => {
  await open(page, "/conta?aba=senha", { passwordOn: false, size: LARGE });
  await expect(page).toHaveURL(AT_DEVICES);
  await expect(title(page)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Aparelhos" })).toBeVisible();
  await expect(page.getByLabel("Senha atual")).toHaveCount(0);
});

test("uma aba que o endereço não conhece abre a primeira, e o endereço diz qual", async ({
  page,
}) => {
  await open(page, "/conta?aba=nenhuma", { passwordOn: true, size: LARGE });
  await expect(tab(page, "Senha")).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(AT_ACCOUNT);
});

for (const [address, final] of [
  ["/configuracoes?aba=senha", AT_ACCOUNT],
  ["/configuracoes?aba=aparelhos", AT_DEVICES],
  ["/devices", AT_DEVICES],
  ["/conta/seguranca", AT_ACCOUNT],
] as const) {
  test(`${address} termina em Minha conta`, async ({ page }) => {
    await open(page, address, { passwordOn: true, size: LARGE });
    await expect(page).toHaveURL(final);
    await expect(title(page)).toBeVisible();
  });
}

test("a Assinatura segue em Configurações da loja, com o retorno do pagamento", async ({
  page,
}) => {
  await open(page, "/configuracoes?aba=assinatura&retorno=concluida", {
    passwordOn: true,
    size: LARGE,
  });
  await expect.poll(() => new URL(page.url()).pathname).toBe("/configuracoes");
  expect(page.url()).toContain("retorno=concluida");
  await expect(
    page.getByRole("heading", {
      exact: true,
      level: 1,
      name: "Configurações da loja",
    })
  ).toBeVisible();
});
