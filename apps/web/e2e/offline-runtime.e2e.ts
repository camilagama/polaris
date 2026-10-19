/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

async function openLab(page: Page, user: string) {
  await page.goto("/offline-runtime-lab");
  await expect(
    page.getByRole("heading", { name: "Laboratório do runtime offline" })
  ).toBeVisible();
  await page.getByLabel("Usuário").fill(user);
}

async function click(page: Page, name: string, expected: string) {
  await page.getByRole("button", { exact: true, name }).click();
  await expect(page.getByTestId("message")).toContainText(expected, {
    timeout: 20_000,
  });
}

const chip = (page: Page) => page.locator(".sync-status");

test("inicia online, trabalha sem rede, e numa segunda visita sem rede abre do que ficou no aparelho", async ({
  page,
}) => {
  const user = `user-${crypto.randomUUID()}`;
  await openLab(page, user);
  await click(page, "Iniciar", "Iniciar: ok (ready)");
  await expect(chip(page)).toContainText("Tudo sincronizado");

  await page.getByLabel("Rede disponível").uncheck();
  await click(page, "Criar produto offline", "Criar produto: ok");
  await expect(chip(page)).toContainText("Sem conexão · 1 operação guardada");
  await expect(page.getByTestId("local-products")).toHaveText("1");
  await expect(page.getByTestId("server-products")).toHaveText("0");

  // a second visit, still without a network: no device or lease request is possible
  await page.reload();
  await openLab(page, user);
  await page.getByLabel("Rede disponível").uncheck();
  await click(page, "Iniciar", "Iniciar: ok (ready)");
  await expect(chip(page)).toContainText("Sem conexão · 1 operação guardada");
  await expect(page.getByTestId("local-products")).toHaveText("1");
});

test("voltando a rede, envia o que ficou guardado e o aparelho fica sincronizado", async ({
  page,
}) => {
  const user = `user-${crypto.randomUUID()}`;
  await openLab(page, user);
  await click(page, "Iniciar", "Iniciar: ok (ready)");
  await page.getByLabel("Rede disponível").uncheck();
  await click(page, "Criar produto offline", "Criar produto: ok");
  await click(page, "Criar produto offline", "Criar produto: ok");
  await expect(chip(page)).toContainText("2 operações guardadas");

  await page.getByLabel("Rede disponível").check();
  await click(page, "Sincronizar", "Sincronizar: ok");
  await expect(page.getByTestId("server-products")).toHaveText("2");
  await expect(chip(page)).toContainText("Tudo sincronizado");
});

test("sem nenhum acesso anterior e sem rede, o offline fica indisponível e diz isso", async ({
  page,
}) => {
  await openLab(page, `user-${crypto.randomUUID()}`);
  await click(page, "Esquecer aparelho", "Esquecer aparelho: ok");
  await page.getByLabel("Rede disponível").uncheck();
  await click(page, "Iniciar", "unavailable:no_session_offline");
  await expect(chip(page)).toContainText("Offline indisponível");
});
