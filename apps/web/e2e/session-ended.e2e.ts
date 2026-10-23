/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { WORKER_MARK } from "./worker-mark";

/**
 * "Sua sessão acabou" dentro de uma tela com ação em andamento (AC-17, AC-18): o 401 de uma chamada da
 * própria tela não leva a lugar nenhum sozinho; o aviso do shell oferece "Entrar de novo", que não passa
 * pelo "Sair" (a sessão já morreu), limpa as cópias e vai a `/entrar?motivo=sessao&voltar=<tela>`.
 */
const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const CACHE_KEY = "polaris.offline.organizations";
const SENTENCE = "Sua sessão acabou. Entre de novo para continuar.";
const WARNING =
  "O que você digitou e ainda não enviou pode se perder ao entrar de novo.";

const rpc = (json: unknown, status = 200) => ({
  body: JSON.stringify({ json, meta: [] }),
  headers: { ...WORKER_MARK },
  contentType: "application/json",
  status,
});
const unauthorized = rpc(
  {
    code: "UNAUTHORIZED",
    data: undefined,
    defined: false,
    message: "Unauthorized",
    status: 401,
  },
  401
);

async function openCategories(page: Page) {
  const calls = { signOut: 0 };
  // once the server refused a call, the session is dead for the sign-in screen's lookup too
  let alive = true;
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      body: JSON.stringify(
        alive ? { session: { id: "s" }, user: { id: "u" } } : null
      ),
      headers: { ...WORKER_MARK },
      contentType: "application/json",
    })
  );
  await page.route("**/api/auth/sign-out", (route) => {
    calls.signOut += 1;
    return route.fulfill({
      body: "{}",
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    });
  });
  await page.route("**/rpc/**", (route) => {
    const procedure = new URL(route.request().url()).pathname.replace(
      "/rpc/",
      ""
    );
    if (procedure === "organization/listMine") {
      return route.fulfill(rpc({ organizations: [ORGANIZATION] }));
    }
    if (procedure === "category/list") {
      return route.fulfill(rpc({ categories: [] }));
    }
    if (procedure === "category/create") {
      alive = false;
      return route.fulfill(unauthorized);
    }
    return route.abort("internetdisconnected");
  });
  await page.goto("/categories");
  await expect(page.getByLabel("Nova categoria")).toBeVisible();
  return calls;
}

test("401 numa ação da tela não navega sozinho: avisa, mantém o digitado e oferece 'Entrar de novo' (AC-17)", async ({
  page,
}) => {
  await openCategories(page);
  await page.getByLabel("Nova categoria").fill("Acessórios");
  await page.getByRole("button", { name: "Adicionar categoria" }).click();

  const notice = page.locator(".session-ended-notice");
  await expect(notice).toContainText(SENTENCE);
  await expect(notice).toContainText(WARNING);
  await expect(
    notice.getByRole("button", { name: "Entrar de novo" })
  ).toBeVisible();
  // the red box says only what did not happen; the sentence about the session is the notice's alone
  await expect(page.getByRole("alert")).toContainText(
    "A categoria não foi alterada."
  );
  await expect(page.getByRole("alert")).not.toContainText(SENTENCE);
  await expect(page.getByText(SENTENCE)).toHaveCount(1);
  // the notice is brought to the person: it has the focus
  await expect(notice).toBeFocused();
  expect(new URL(page.url()).pathname).toBe("/categories");
  await expect(page.getByLabel("Nova categoria")).toHaveValue("Acessórios");
  await expect(page.locator("body")).not.toContainText("sessão não está ativa");
});

test("'Entrar de novo' com a sessão morta não chama o Sair, limpa as cópias e vai a /entrar com o motivo e a tela de origem (AC-18)", async ({
  page,
}) => {
  const calls = await openCategories(page);
  await page.getByLabel("Nova categoria").fill("Acessórios");
  await page.getByRole("button", { name: "Adicionar categoria" }).click();
  await page
    .locator(".session-ended-notice")
    .getByRole("button", { name: "Entrar de novo" })
    .click();

  await page.waitForURL("**/entrar?motivo=sessao&voltar=/categories");
  await expect(
    page.getByRole("heading", { name: "Entrar no Polaris" })
  ).toBeVisible();
  // `/entrar` says it shorter (v5.2): the notice inside the app keeps the long sentence
  await expect(
    page.getByText("Sua sessão acabou. Entre de novo.", { exact: true })
  ).toBeVisible();
  expect(calls.signOut).toBe(0);
  expect(
    await page.evaluate((key) => window.localStorage.getItem(key), CACHE_KEY)
  ).toBeNull();
});
