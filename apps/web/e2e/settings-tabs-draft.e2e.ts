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
  /** The address the screen opens at; Configurações da loja by default. */
  path?: string;
  search?: string;
  /** False when the screen has one tab only, so there is no strip to wait for. */
  strip?: boolean;
  /** The strip of tabs is from 760 px; the list of a phone has its own tests (`settings-groups.e2e.ts`). */
  size?: { height: number; width: number };
}

async function openSettings(
  page: Page,
  {
    authMethods,
    passwordOn = false,
    path = "/configuracoes",
    search = "aba=formas-de-receber",
    strip = true,
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
  await page.goto(`${path}?${search}`);
  const account = path === "/conta";
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: account ? "Minha conta" : "Configurações da loja",
    })
  ).toBeVisible();
  if (strip && (size.width >= 760 || account)) {
    await expect(
      page.getByRole("tablist", {
        name: account ? "Minha conta" : "Configurações da loja",
      })
    ).toBeVisible();
  }
}

const openAccount = (page: Page, options: Options) =>
  openSettings(page, { ...options, path: "/conta" });

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

for (const [name, size] of [
  ["a 1280 px", { height: 800, width: 1280 }],
  ["a 360 px", { height: 740, width: 360 }],
] as const) {
  test(`${name} a aba Senha de Minha conta tem o lugar guardado, desligada, até o servidor responder, e a vizinha não anda`, async ({
    page,
  }) => {
    let release: () => void = () => undefined;
    const answer = new Promise<void>((resolve) => {
      release = resolve;
    });
    await openAccount(page, {
      authMethods: answer,
      passwordOn: true,
      search: "aba=aparelhos",
      size,
    });
    const password = tab(page, "Senha");
    await expect(password).toBeVisible();
    await expect(password).toBeDisabled();
    await expect(password).toHaveAttribute("aria-busy", "true");
    const before = await tab(page, "Aparelhos").boundingBox();

    release();
    await expect(password).toBeEnabled();
    await expect(password).not.toHaveAttribute("aria-busy", "true");
    expect(await tab(page, "Aparelhos").boundingBox()).toEqual(before);
  });
}

test("com a senha desligada a aba Senha sai de Minha conta quando o servidor diz, e Aparelhos fica sozinha, sem faixa", async ({
  page,
}) => {
  await openAccount(page, {
    passwordOn: false,
    search: "aba=aparelhos",
    strip: false,
  });
  await expect(page.getByRole("tablist")).toHaveCount(0);
  await expect(tab(page, "Senha")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { level: 1, name: "Minha conta" })
  ).toBeVisible();
});
