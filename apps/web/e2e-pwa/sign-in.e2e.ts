/// <reference lib="dom" />
import { expect, test } from "@playwright/test";
import { openControlled } from "./support";

const OFFLINE_TEXT = "Sem conexão. Conecte-se para entrar.";

test("a tela de entrada abre pelo shell em cache, sem rede, com o botão desabilitado e o aviso (AC-10)", async ({
  context,
  page,
}) => {
  await openControlled(page);
  await context.setOffline(true);

  await page.goto("/entrar?motivo=sessao&voltar=%2Fsales");
  await expect(page).toHaveTitle("Entrar · Polaris");
  await expect(
    page.getByRole("heading", { level: 1, name: "Entrar no Polaris" })
  ).toBeVisible();
  await expect(page.getByText(OFFLINE_TEXT)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continuar com o Google" })
  ).toBeDisabled();
  await expect(
    page.getByText("Sua sessão acabou. Entre de novo.", { exact: true })
  ).toBeVisible();

  await context.setOffline(false);
  await expect(
    page.getByRole("button", { name: "Continuar com o Google" })
  ).toBeEnabled();
});

test("a tela de entrada não pede loja nem mostra o menu do app", async ({
  page,
}) => {
  const rpcCalls: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/rpc/")) {
      rpcCalls.push(request.url());
    }
  });
  await page.goto("/entrar");
  await expect(
    page.getByRole("button", { name: "Continuar com o Google" })
  ).toBeVisible();
  await expect(page.getByRole("navigation")).toHaveCount(0);
  expect(rpcCalls).toEqual([]);
});
