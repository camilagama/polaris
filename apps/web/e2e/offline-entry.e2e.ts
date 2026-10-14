/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

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

type Listing = "down" | "ok" | "unauthorized";

/** Plays the part of the server for the one read the app makes on every start. */
async function serveListing(page: Page, listing: () => Listing) {
  organizations = ORIGINAL;
  await page.route("**/rpc/organization/listMine", async (route) => {
    const state = listing();
    if (state === "down") {
      await route.abort("internetdisconnected");
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

  listing = "unauthorized";
  await page.reload();
  await expect(page.getByText("Sua sessão não está ativa")).toBeVisible();
  expect(
    await page.evaluate((key) => window.localStorage.getItem(key), CACHE_KEY)
  ).toBeNull();

  // and offline afterwards there is nothing to open from
  listing = "down";
  await page.reload();
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
