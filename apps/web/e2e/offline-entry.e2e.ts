/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { WORKER_MARK } from "./worker-mark";

const ORIGINAL = [
  {
    id: "0199c2d0-0000-7000-8000-00000000a001",
    name: "Loja do teste",
    role: "owner",
    timezone: "America/Sao_Paulo",
  },
];
const CACHE_KEY = "polaris.offline.organizations";
const OPENING_TITLE = /Abra a sua loja/;
const SIGN_IN_AGAIN_HREF = /\/entrar\?motivo=sessao&voltar=/;

let organizations = ORIGINAL;

type Listing =
  | "down"
  | "empty"
  | "ok"
  | "throttled"
  | "unauthorized"
  | "unavailable";

/** Plays the part of the server for the one read the app makes on every start. */
async function serveListing(page: Page, listing: () => Listing) {
  organizations = ORIGINAL;
  await page.route("**/rpc/organization/listMine", async (route) => {
    const state = listing();
    if (state === "down") {
      await route.abort("internetdisconnected");
      return;
    }
    if (state === "throttled" || state === "unavailable") {
      const [status, code] =
        state === "throttled"
          ? [429, "TOO_MANY_REQUESTS"]
          : [503, "SERVICE_UNAVAILABLE"];
      await route.fulfill({
        body: JSON.stringify({
          json: {
            code,
            data: undefined,
            defined: false,
            message: code,
            status,
          },
          meta: [],
        }),
        contentType: "application/json",
        headers: { ...WORKER_MARK },
        status,
      });
      return;
    }
    if (state === "empty") {
      await route.fulfill({
        body: JSON.stringify({ json: { organizations: [] }, meta: [] }),
        contentType: "application/json",
        headers: { ...WORKER_MARK },
      });
      return;
    }
    if (state === "unauthorized") {
      await route.fulfill({
        body: JSON.stringify({
          json: {
            code: "UNAUTHORIZED",
            data: undefined,
            defined: false,
            message: "Unauthorized",
            status: 401,
          },
          meta: [],
        }),
        contentType: "application/json",
        headers: { ...WORKER_MARK },
        status: 401,
      });
      return;
    }
    await route.fulfill({
      body: JSON.stringify({
        json: { organizations },
        meta: [],
      }),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    });
  });
  // everything else the runtime asks for is unreachable in this scenario
  await page.route("**/rpc/**", async (route) => {
    if (route.request().url().includes("organization/listMine")) {
      await route.fallback();
      return;
    }
    // the first access asks for the owner's closed stores: none here
    if (route.request().url().includes("organization/listClosed")) {
      await route.fulfill({
        body: JSON.stringify({ json: { organizations: [] }, meta: [] }),
        contentType: "application/json",
        headers: { ...WORKER_MARK },
      });
      return;
    }
    await route.abort("internetdisconnected");
  });
}

test("depois de um acesso online, o app abre sem rede com a loja lembrada no aparelho", async ({
  page,
}) => {
  let listing: Listing = "ok";
  await serveListing(page, () => listing);

  await page.goto("/");
  await expect(page.getByText("Loja do teste").first()).toBeAttached();

  listing = "down";
  await page.reload();
  await expect(page.getByText("Loja do teste").first()).toBeAttached();
  await expect(
    page.getByText("Não foi possível carregar suas lojas")
  ).toHaveCount(0);
});

test("sem nenhum acesso anterior e sem rede, diz que não foi possível carregar", async ({
  page,
}) => {
  await serveListing(page, () => "down");
  await page.goto("/");
  await expect(
    page.getByText("Não foi possível carregar suas lojas")
  ).toBeVisible();
});

test("quando a sessão acabou, a cópia das lojas é apagada e não é oferecida", async ({
  page,
}) => {
  let listing: Listing = "ok";
  await serveListing(page, () => listing);
  await page.goto("/");
  await expect(page.getByText("Loja do teste").first()).toBeAttached();
  expect(
    await page.evaluate((key) => window.localStorage.getItem(key), CACHE_KEY)
  ).toContain("Loja do teste");

  // the session was refused on opening: the app goes to the sign-in screen by itself (AC-16)
  listing = "unauthorized";
  await page.reload();
  await page.waitForURL("**/entrar?motivo=sessao&voltar=/");
  await expect(
    page.getByRole("heading", { name: "Entrar no Polaris" })
  ).toBeVisible();
  await expect(
    page.getByText("Sua sessão acabou. Entre de novo.", { exact: true })
  ).toBeVisible();
  expect(
    await page.evaluate((key) => window.localStorage.getItem(key), CACHE_KEY)
  ).toBeNull();

  // and offline afterwards there is nothing to open from
  listing = "down";
  await page.goto("/");
  await expect(
    page.getByText("Não foi possível carregar suas lojas")
  ).toBeVisible();
});

test("aberto da cópia, lê a lista de verdade quando a rede volta", async ({
  page,
}) => {
  let listing: Listing = "ok";
  await serveListing(page, () => listing);
  await page.goto("/");
  await expect(page.getByText("Loja do teste").first()).toBeAttached();

  listing = "down";
  await page.reload();
  await expect(page.getByText("Loja do teste").first()).toBeAttached();

  // the connection returns with a different list: the screen follows the server
  organizations = ORIGINAL.map((item) => ({ ...item, name: "Loja renomeada" }));
  listing = "ok";
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByText("Loja renomeada").first()).toBeAttached();
});

for (const refusal of ["throttled", "unavailable"] as const) {
  test(`com a cópia no aparelho, ${refusal === "throttled" ? "429" : "503"} na abertura não leva a /entrar: o app abre da cópia (AC-11)`, async ({
    page,
  }) => {
    let listing: Listing = "ok";
    await serveListing(page, () => listing);
    await page.goto("/");
    await expect(page.getByText("Loja do teste").first()).toBeAttached();

    listing = refusal;
    await page.reload();
    await expect(page.getByText("Loja do teste").first()).toBeAttached();
    expect(new URL(page.url()).pathname).toBe("/");
    expect(
      await page.evaluate((key) => window.localStorage.getItem(key), CACHE_KEY)
    ).toContain("Loja do teste");
  });
}

test("o primeiro acesso de uma conta sem loja chega à tela de abrir a loja, sem erro (AC-9)", async ({
  page,
}) => {
  await serveListing(page, () => "empty");
  await page.goto("/");
  await expect(page.getByText("Não foi possível")).toHaveCount(0);
  await expect(page.getByText("Sua sessão acabou")).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe("/");
  await expect(
    page.getByRole("heading", { name: "Abra a sua loja" })
  ).toBeVisible();
});

test("o primeiro acesso não mostra o menu: só o cartão, a aba com o nome da tela e o Sair", async ({
  page,
}) => {
  await serveListing(page, () => "empty");
  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: "Abra a sua loja" })
  ).toBeVisible();
  await expect(page).toHaveTitle("Abra a sua loja · Polaris");
  // nothing to go to yet: no sidebar, no bottom bar, no state chip
  await expect(page.getByRole("navigation", { name: "Principal" })).toHaveCount(
    0
  );
  await expect(page.getByRole("navigation", { name: "Destinos" })).toHaveCount(
    0
  );
  await expect(page.getByRole("link", { name: "Vender" })).toHaveCount(0);
  // a person who signed in with the wrong account can still leave
  await expect(page.getByRole("button", { name: "Sair" })).toBeVisible();
  // the two legal pages stay one tap away (AC-70)
  await expect(page.getByRole("link", { name: "Termos de Uso" })).toBeVisible();
});

test("401 ao abrir a loja: o aviso de sessão fica sobre o cartão e o erro leva a Entrar de novo", async ({
  page,
}) => {
  await serveListing(page, () => "empty");
  await page.route("**/rpc/organization/createInitial", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        json: {
          code: "UNAUTHORIZED",
          data: undefined,
          defined: false,
          message: "Unauthorized",
          status: 401,
        },
        meta: [],
      }),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
      status: 401,
    });
  });
  await page.goto("/");
  await page.getByLabel("Nome da loja").fill("Loja do teste");
  await page.getByRole("button", { name: "Abrir loja" }).click();
  await expect(
    page.getByText("Sua sessão acabou. Entre de novo.")
  ).toBeVisible();
  // the notice of the shell stays above the card, and the error offers the way back
  await expect(
    page.getByRole("alert", { name: "Sua sessão acabou" })
  ).toBeVisible();
  const again = page.getByRole("link", { name: "Entrar de novo" });
  await expect(again).toHaveAttribute("href", SIGN_IN_AGAIN_HREF);
});

test("sem rede ao abrir: texto de sem internet, com o foco no aviso e o nome mantido", async ({
  page,
}) => {
  await serveListing(page, () => "empty");
  await page.route("**/rpc/organization/createInitial", async (route) => {
    await route.abort("internetdisconnected");
  });
  await page.goto("/");
  await page.getByLabel("Nome da loja").fill("Loja do teste");
  await page.getByRole("button", { name: "Abrir loja" }).click();
  const alert = page.getByRole("alert").filter({ hasText: "Sem internet." });
  await expect(alert).toHaveText("Sem internet. Conecte-se e tente de novo.");
  await expect(alert).toBeFocused();
  await expect(page.getByText("Não foi possível abrir a loja")).toHaveCount(0);
  await expect(page.getByLabel("Nome da loja")).toHaveValue("Loja do teste");
  await expect(page.getByRole("button", { name: "Abrir loja" })).toBeEnabled();
});

test("no primeiro acesso, o nome vazio aponta o campo e, com o nome, a loja abre", async ({
  page,
}) => {
  let created = false;
  await serveListing(page, () => (created ? "ok" : "empty"));
  await page.route("**/rpc/organization/createInitial", async (route) => {
    created = true;
    await route.fulfill({
      body: JSON.stringify({
        json: { organization: ORIGINAL[0] },
        meta: [],
      }),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Abrir loja" }).click();
  await expect(page.getByText("Informe o nome da loja.")).toBeVisible();
  await expect(page.getByLabel("Nome da loja")).toBeFocused();
  expect(created).toBe(false);

  await page.getByLabel("Nome da loja").fill("Loja do teste");
  await page.getByRole("button", { name: "Abrir loja" }).click();
  // the app opens with its menu and the tab goes back to the name of the screen
  // (the sidebar from 760 px, the bar of destinations below it: one of the two is on the page)
  await expect(
    page
      .getByRole("navigation", { name: "Principal" })
      .or(page.getByRole("navigation", { name: "Destinos" }))
      .first()
  ).toBeAttached();
  await expect(
    page.getByRole("heading", { name: "Abra a sua loja" })
  ).toHaveCount(0);
  await expect(page).not.toHaveTitle(OPENING_TITLE);
});
