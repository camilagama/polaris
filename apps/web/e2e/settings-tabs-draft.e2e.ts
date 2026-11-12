/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { serveHealth, WORKER_MARK } from "./worker-mark";

/**
 * The tabs of Configurações keep what was typed while the page is open: a tab with an unsent change stays drawn
 * (hidden) when another one opens, and a tab with nothing typed is drawn only while open, as before.
 */
const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const rpc = (json: unknown) => ({
  body: JSON.stringify({ json, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
});

interface Options {
  /** Holds the answer of /api/auth-methods until the test releases it. */
  authMethods?: Promise<void>;
  passwordOn?: boolean;
  search?: string;
  /** The strip of tabs is from 760 px; the list of a phone has its own tests (`settings-groups.e2e.ts`). */
  size?: { height: number; width: number };
}

async function openSettings(
  page: Page,
  {
    authMethods,
    passwordOn = false,
    search = "aba=formas-de-receber",
    size = { height: 800, width: 1280 },
  }: Options = {}
) {
  await page.setViewportSize(size);
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      body: JSON.stringify({ session: { id: "s" }, user: { id: "u" } }),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    })
  );
  await page.route("**/api/auth-methods", async (route) => {
    await authMethods;
    return route.fulfill({
      body: JSON.stringify({ emailPassword: passwordOn, google: true }),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    });
  });
  await serveHealth(page);
  await page.route("**/rpc/**", (route) => {
    const procedure = new URL(route.request().url()).pathname.replace(
      "/rpc/",
      ""
    );
    if (procedure === "organization/listMine") {
      return route.fulfill(
        rpc({ billingSelfService: false, organizations: [ORGANIZATION] })
      );
    }
    if (procedure === "paymentProfile/list") {
      return route.fulfill(rpc({ profiles: [] }));
    }
    return route.abort("internetdisconnected");
  });
  await page.goto(`/configuracoes?${search}`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Configurações" })
  ).toBeVisible();
  if (size.width >= 760) {
    await expect(
      page.getByRole("tablist", { name: "Configurações" })
    ).toBeVisible();
  }
}

const tab = (page: Page, name: string) =>
  page.getByRole("tab", { exact: true, name });

test("o perfil de pagamento digitado volta intacto depois de olhar outra aba", async ({
  page,
}) => {
  await openSettings(page);
  await page.getByRole("button", { name: "Novo perfil" }).click();
  await page.getByLabel("Nome do perfil").fill("Maquininha nova");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await tab(page, "Catálogo público").click();
  await expect(
    tab(page, "Catálogo público").and(page.locator("[aria-selected=true]"))
  ).toBeVisible();
  await tab(page, "Formas de receber").click();
  await page.getByRole("button", { name: "Novo perfil" }).click();

  await expect(page.getByLabel("Nome do perfil")).toHaveValue(
    "Maquininha nova"
  );
});

test("sem nada digitado a aba que fechou não fica desenhada", async ({
  page,
}) => {
  await openSettings(page);
  await expect(page.getByRole("button", { name: "Novo perfil" })).toBeVisible();
  await tab(page, "Catálogo público").click();
  await expect(page.getByRole("button", { name: "Novo perfil" })).toHaveCount(
    0
  );
});

test("a aba Senha tem o lugar guardado, desligada, até o servidor responder, e as vizinhas não andam", async ({
  page,
}) => {
  let release: () => void = () => undefined;
  const answer = new Promise<void>((resolve) => {
    release = resolve;
  });
  await openSettings(page, { authMethods: answer, passwordOn: true });
  const password = tab(page, "Senha");
  await expect(password).toBeVisible();
  await expect(password).toBeDisabled();
  await expect(password).toHaveAttribute("aria-busy", "true");
  const before = await tab(page, "Seus dados").boundingBox();

  release();
  await expect(password).toBeEnabled();
  await expect(password).not.toHaveAttribute("aria-busy", "true");
  expect(await tab(page, "Seus dados").boundingBox()).toEqual(before);
});

test("com a senha desligada a aba Senha sai da lista quando o servidor diz", async ({
  page,
}) => {
  await openSettings(page, { passwordOn: false });
  await expect(tab(page, "Seus dados")).toBeVisible();
  await expect(tab(page, "Senha")).toHaveCount(0);
});

test("a 360 px a linha da aba Senha tem o lugar guardado, desligada, até o servidor responder, e as vizinhas não andam", async ({
  page,
}) => {
  let release: () => void = () => undefined;
  const answer = new Promise<void>((resolve) => {
    release = resolve;
  });
  await openSettings(page, {
    authMethods: answer,
    passwordOn: true,
    search: "",
    size: { height: 740, width: 360 },
  });
  const password = page.locator('[aria-busy="true"]');
  await expect(password).toHaveText("Senha");
  await expect(password).toHaveAttribute("aria-disabled", "true");
  const own = page.getByRole("link", { exact: true, name: "Seus dados" });
  const before = await own.boundingBox();

  release();
  await expect(
    page.getByRole("link", { exact: true, name: "Senha" })
  ).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  expect(await own.boundingBox()).toEqual(before);
});
