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
        headers: { ...WORKER_MARK },
        contentType: "application/json",
        status,
      });
      return;
    }
    if (state === "empty") {
      await route.fulfill({
        body: JSON.stringify({ json: { organizations: [] }, meta: [] }),
        headers: { ...WORKER_MARK },
        contentType: "application/json",
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
        headers: { ...WORKER_MARK },
        contentType: "application/json",
        status: 401,
      });
      return;
    }
    await route.fulfill({
      body: JSON.stringify({
        json: { organizations },
        meta: [],
      }),
      headers: { ...WORKER_MARK },
      contentType: "application/json",
    });
  });
  // everything else the runtime asks for is unreachable in this scenario
  await page.route("**/rpc/**", async (route) => {
    if (route.request().url().includes("organization/listMine")) {
      await route.fallback();
      return;
    }
    await route.abort("internetdisconnected");
  });
}

test("depois de um acesso online, o app abre sem rede com a organização lembrada no aparelho", async ({
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
    page.getByText("Não foi possível carregar suas organizações")
  ).toHaveCount(0);
});

test("sem nenhum acesso anterior e sem rede, diz que não foi possível carregar", async ({
  page,
}) => {
  await serveListing(page, () => "down");
  await page.goto("/");
  await expect(
    page.getByText("Não foi possível carregar suas organizações")
  ).toBeVisible();
});

test("quando a sessão acabou, a cópia das organizações é apagada e não é oferecida", async ({
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
    page.getByText("Não foi possível carregar suas organizações")
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

test("o primeiro acesso de uma conta sem organização chega à tela de criar organização, sem erro (AC-9)", async ({
  page,
}) => {
  await serveListing(page, () => "empty");
  await page.goto("/");
  await expect(page.getByText("Não foi possível")).toHaveCount(0);
  await expect(page.getByText("Sua sessão acabou")).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe("/");
  await expect(
    page.getByRole("heading", { name: "Abra a sua organização" })
  ).toBeVisible();
});
