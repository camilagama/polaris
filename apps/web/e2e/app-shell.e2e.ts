/// <reference lib="dom" />

import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import { signOfflineLease } from "../src/lib/offline-lease-token";
import { serveHealth, WORKER_MARK } from "./worker-mark";

/**
 * The shell v5.1: the sidebar of the desktop, the bottom bar and "Mais" of the phone, the theme and "Sair",
 * against a server played by network interception with the offline runtime on (the devices screen has the same).
 */

const ORGANIZATION_ID = "0199c2d0-0000-7000-8000-00000000a001";
const ORGANIZATIONS = [
  {
    id: ORGANIZATION_ID,
    name: "Loja do teste",
    role: "owner",
    timezone: "America/Sao_Paulo",
  },
];
const SECOND_ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a002",
  name: "Loja da filial",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
/** The hint of the connection chip on a screen that needs the network. */
const NEEDS_INTERNET_TITLE = /esta tela precisa de internet/;
const USER_ID = "user-do-teste";
const EMAIL = "contato@exemplo.com.br";
const LEASE_KEY = {
  id: "teste",
  secret: "teste-secret-teste-secret-teste-secret-0123456789",
};
const HOUR = 3_600_000;
const DARK = /\bdark\b/;
/** A count of days, which the trial at the foot of the menu never says (AS-3, AC-12). */
const DAYS = /\d+ dias?\b/;
const LEFT_TO_START = /\/(entrar\?motivo=saiu.*)?$/;
const DEVICE = {
  createdAt: "2026-10-01T12:00:00.000Z",
  id: "0199c2d0-0000-7000-8000-000000000001",
  label: "Caixa da loja",
  lastSeenAt: "2026-10-14T12:00:00.000Z",
  revokedAt: null,
};

const json = (body: unknown) => ({
  body: JSON.stringify({ json: body, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
});
const inputOf = (route: Route) =>
  (route.request().postDataJSON() as { json: Record<string, unknown> }).json;

/** What the server says of the ways to sign in (the latest route wins over the one `serve` set). */
const authMethods = (page: Page, emailPassword: boolean) =>
  page.route("**/api/auth-methods", (route) =>
    route.fulfill({
      body: JSON.stringify({
        emailPassword,
        google: true,
        turnstileSiteKey: null,
      }),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    })
  );

/** The server of a test: a signed-in person with one store, and nothing queued. */
async function serve(page: Page, organizations = ORGANIZATIONS) {
  const state = { signOutCalls: 0 };
  // the Início reads in vain here (every other /rpc is cut): the probe finds the Worker, so it is not "offline"
  await serveHealth(page);
  await page.route("**/rpc/**", (route) => route.abort("internetdisconnected"));
  await page.route("**/rpc/organization/listMine", (route) =>
    route.fulfill(json({ organizations }))
  );
  // the password is off unless a test says otherwise: Senha is not a tab of Configurações then
  await authMethods(page, false);
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      body: JSON.stringify(
        state.signOutCalls > 0 ? null : { user: { email: EMAIL, id: USER_ID } }
      ),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    })
  );
  await page.route("**/api/auth/sign-out", (route) => {
    state.signOutCalls += 1;
    return route.fulfill({
      body: "{}",
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    });
  });
  await page.route("**/rpc/device/list", (route) =>
    route.fulfill(json({ devices: [DEVICE] }))
  );
  await page.route("**/rpc/device/register", (route) =>
    route.fulfill(json({ device: DEVICE }))
  );
  await page.route("**/rpc/device/check", (route) =>
    route.fulfill(json({ device: DEVICE }))
  );
  await page.route("**/rpc/offline/issueLease", async (route) => {
    const input = inputOf(route) as {
      deviceId: string;
      organizationId: string;
    };
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 72 * HOUR);
    const lease = await signOfflineLease(
      buildOfflineLeaseClaims({
        capabilities: ["customer:create", "customer:update"],
        deviceId: input.deviceId,
        epoch: 0,
        expiresAt,
        grantId: "0199c2d0-0000-7000-8000-000000000901",
        issuedAt,
        organizationId: input.organizationId,
        userId: USER_ID,
      }),
      LEASE_KEY
    );
    await route.fulfill(
      json({
        expiresAt: expiresAt.toISOString(),
        grantId: "0199c2d0-0000-7000-8000-000000000901",
        issuedAt: issuedAt.toISOString(),
        lease,
      })
    );
  });
  await page.route("**/rpc/sync/getCursor", (route) =>
    route.fulfill(json({ cursor: "0" }))
  );
  await page.route("**/rpc/sync/bootstrapPage", (route) =>
    route.fulfill(
      json({
        collection: (inputOf(route) as { collection: string }).collection,
        nextAfterId: null,
        rows: [],
      })
    )
  );
  await page.route("**/rpc/sync/pull", (route) =>
    route.fulfill(json({ changes: [], hasMore: false, nextCursor: "0" }))
  );
  await page.route("**/rpc/sale/list", (route) =>
    route.fulfill(json({ sales: [] }))
  );
  return state;
}

const sidebar = (page: Page) =>
  page.getByRole("navigation", { exact: true, name: "Principal" });
const bottomBar = (page: Page) =>
  page.getByRole("navigation", { exact: true, name: "Destinos" });
const more = (page: Page) =>
  page.getByRole("button", { exact: true, name: "Mais" });
const chip = (page: Page) => page.locator(".sync-status");
const storeMenu = (page: Page) =>
  page.getByRole("button", { exact: true, name: "Loja, tema e Sair" });

/** The eight destinations of the menu, in order (map of navigation, § 1). */
const DESTINATIONS = [
  "Início",
  "Vender",
  "Histórico",
  "Estoque",
  "Produtos",
  "Clientes",
  "Resultado",
  "Configurações",
];

test.describe("desktop (1280 px)", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
  });

  test("a lateral tem os grupos da v5.1, marca o item atual e o chip fica no alto do conteúdo", async ({
    page,
  }) => {
    await serve(page);
    await page.goto("/products");
    const nav = sidebar(page);
    await expect(nav).toBeVisible();
    await expect(bottomBar(page)).toBeHidden();
    // the eight destinations (map of navigation, § 1): no Pendências with nothing refused
    await expect(nav.getByRole("link")).toHaveText(DESTINATIONS);
    // Início and Configurações alone; Vendas and Gestão with their small label (map of navigation, § 1)
    await expect(nav.locator('[data-sidebar="group-label"]')).toHaveText([
      "Vendas",
      "Gestão",
    ]);
    const groups = nav.locator('[data-sidebar="group"]');
    await expect(groups).toHaveCount(4);
    await expect(groups.nth(0).getByRole("link")).toHaveText(["Início"]);
    await expect(groups.nth(1).getByRole("link")).toHaveText([
      "Vender",
      "Histórico",
    ]);
    await expect(groups.nth(2).getByRole("link")).toHaveText([
      "Estoque",
      "Produtos",
      "Clientes",
      "Resultado",
    ]);
    await expect(groups.nth(3).getByRole("link")).toHaveText(["Configurações"]);
    const current = nav.locator('[aria-current="page"]');
    await expect(current).toHaveCount(1);
    await expect(current).toHaveText("Produtos");
    await expect(current).toHaveAttribute("href", "/products");
    // the sidebar is on the new interface: no bullets, no underline, no link color of the browser
    await expect(nav.locator("li").first()).toHaveCSS(
      "list-style-type",
      "none"
    );
    await expect(current).toHaveCSS("text-decoration-line", "none");
    await expect(
      page.getByRole("link", { exact: true, name: "Polaris" })
    ).toHaveCSS("text-decoration-line", "none");

    // the top of the sidebar: the mark and "Polaris"; the foot: the card of the store, with the e-mail and the menu
    // of the theme and "Sair" (v7 § 3 item 12)
    await expect(
      page.getByRole("link", { exact: true, name: "Polaris" })
    ).toBeVisible();
    const card = page.locator("[data-store-card]");
    await expect(card).toContainText("Loja do teste");
    await expect(card.getByText(EMAIL, { exact: true })).toBeVisible();
    await expect(card).toContainText("LT");
    await expect(
      page.getByRole("button", { exact: true, name: "Sair" })
    ).toHaveCount(0);
    await storeMenu(page).click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitemradio")).toHaveText([
      "Automático",
      "Claro",
      "Escuro",
    ]);
    // "Sair" is the last item, with its own separator before it; one store: nothing to switch to
    await expect(menu.getByRole("menuitem")).toHaveText(["Sair"]);
    await expect(menu.getByRole("separator")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(storeMenu(page)).toBeFocused();

    // the chip is in the top right corner of the content, right of the sidebar
    await expect(chip(page)).toContainText("Tudo sincronizado", {
      timeout: 20_000,
    });
    const box = await chip(page).boundingBox();
    const side = await nav.boundingBox();
    expect(box?.x ?? 0).toBeGreaterThan(
      (side?.x ?? 0) + (side?.width ?? 0) + 600
    );
    expect(box?.y ?? 99).toBeLessThan(40);

    await nav.getByRole("link", { name: "Histórico" }).click();
    await page.waitForURL("**/sales/history");
    await expect(sidebar(page).locator('[aria-current="page"]')).toHaveText(
      "Histórico"
    );
  });

  test("com duas lojas, o menu do cartão troca a loja, separado do tema e do Sair", async ({
    page,
  }) => {
    await serve(page, [...ORGANIZATIONS, SECOND_ORGANIZATION]);
    await page.goto("/products");
    const card = page.locator("[data-store-card]");
    await expect(card).toContainText("Loja do teste");
    await storeMenu(page).click();
    const menu = page.getByRole("menu");
    const stores = menu.getByRole("group", { name: "Trocar de loja" });
    await expect(stores.getByRole("menuitemradio")).toHaveText([
      "Loja do teste",
      "Loja da filial",
    ]);
    await expect(
      stores.getByRole("menuitemradio", { name: "Loja do teste" })
    ).toHaveAttribute("aria-checked", "true");
    // the theme, the stores and "Sair": two separators, "Sair" last
    await expect(menu.getByRole("separator")).toHaveCount(2);
    await expect(menu.getByRole("menuitem").last()).toHaveText("Sair");
    await stores.getByRole("menuitemradio", { name: "Loja da filial" }).click();
    await expect(card).toContainText("Loja da filial");
    // the choice is the one kept for the next visit
    await page.reload();
    await expect(page.locator("[data-store-card]")).toContainText(
      "Loja da filial"
    );
  });

  test("só com o e-mail (a leitura das lojas falhou), o cartão e o Sair continuam lá", async ({
    page,
  }) => {
    await serve(page);
    await page.route("**/rpc/organization/listMine", (route) =>
      route.fulfill({
        body: JSON.stringify({
          json: { code: "INTERNAL_SERVER_ERROR", defined: false, status: 500 },
          meta: [],
        }),
        contentType: "application/json",
        headers: { ...WORKER_MARK },
        status: 500,
      })
    );
    await page.goto("/products");
    const card = page.locator("[data-store-card]");
    await expect(card).toContainText(EMAIL);
    await storeMenu(page).click();
    await expect(
      page.getByRole("menuitem", { exact: true, name: "Sair" })
    ).toBeVisible();
  });

  test("o tema escolhido no menu do cartão troca a classe do <html> e a cor da barra do navegador", async ({
    page,
  }) => {
    await serve(page);
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    await storeMenu(page).click();
    const option = (name: string) =>
      page.getByRole("menuitemradio", { exact: true, name });
    await expect(option("Automático")).toHaveAttribute("aria-checked", "true");
    await option("Escuro").click();
    await expect(page.locator("html")).toHaveClass(DARK);
    await expect(
      page.locator('meta[name="theme-color"][data-tema="escuro"]')
    ).toHaveAttribute("media", "all");
    await expect(
      page.locator('meta[name="theme-color"][data-tema="claro"]')
    ).toHaveAttribute("media", "not all");

    // the choice survives the next page
    await page.goto("/products");
    await expect(page.locator("html")).toHaveClass(DARK);
    await storeMenu(page).click();
    await expect(option("Escuro")).toHaveAttribute("aria-checked", "true");
    await option("Automático").click();
    await expect(page.locator("html")).not.toHaveClass(DARK);
    await expect(
      page.locator('meta[name="theme-color"][data-tema="claro"]')
    ).toHaveAttribute("media", "(prefers-color-scheme: light)");
  });

  test("Sair no menu do cartão encerra a sessão e vai para o início", async ({
    page,
  }) => {
    const state = await serve(page);
    await page.goto("/");
    await expect(chip(page)).toContainText("Tudo sincronizado", {
      timeout: 20_000,
    });
    await storeMenu(page).click();
    await page.getByRole("menuitem", { exact: true, name: "Sair" }).click();
    await expect.poll(() => state.signOutCalls).toBe(1);
    await expect(page).toHaveURL(LEFT_TO_START);
  });
});

test.describe("celular (360 px)", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ height: 740, width: 360 });
  });

  test("a barra de destinos marca o atual; o resto fica em Mais, que também marca o atual", async ({
    page,
  }) => {
    await serve(page);
    await page.goto("/");
    const bar = bottomBar(page);
    await expect(bar).toBeVisible();
    await expect(sidebar(page)).toBeHidden();
    // Início, Histórico, Vender in the middle (a pill of ink), Estoque and Mais (v7 § 3 item 12)
    await expect(bar.getByRole("link")).toHaveText([
      "Início",
      "Histórico",
      "Vender",
      "Estoque",
    ]);
    const sell = bar.locator("[data-bottom-sell]");
    await expect(sell).toHaveText("Vender");
    const barBox = await bar.boundingBox();
    const sellBox = await sell.boundingBox();
    expect(
      Math.abs(
        (sellBox?.x ?? 0) +
          (sellBox?.width ?? 0) / 2 -
          ((barBox?.x ?? 0) + (barBox?.width ?? 0) / 2)
      )
    ).toBeLessThan(2);
    await expect(more(page)).toBeVisible();
    await expect(bar.locator('[aria-current="page"]')).toHaveText("Início");
    await bar.getByRole("link", { name: "Vender" }).click();
    await page.waitForURL("**/sales");
    await expect(bar.locator('[aria-current="page"]')).toHaveText("Vender");
    // the bar is at the bottom of the screen and nothing scrolls sideways
    const box = await bar.boundingBox();
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeGreaterThanOrEqual(739);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true);

    await page.goto("/products");
    // Estoque marks its area (Produtos, with its Categorias, and Clientes); Mais does not
    await expect(bar.locator('[aria-current="page"]')).toHaveCount(0);
    await expect(bar.locator('[aria-current="true"]')).toHaveText("Estoque");
    await expect(bar.locator("[data-bottom-mark]")).toHaveCount(1);
    await more(page).click();
    const panel = page.getByRole("dialog", { name: "Mais" });
    await expect(panel).toBeVisible();
    // the four of the bar are not repeated in Mais: the rest of the destinations, with Resultado and Configurações
    await expect(panel.getByRole("link", { name: "Vender" })).toHaveCount(0);
    await expect(panel.getByRole("link", { name: "Início" })).toHaveCount(0);
    await expect(
      panel.getByRole("navigation", { name: "Principal" }).getByRole("link")
    ).toHaveText(["Produtos", "Clientes", "Resultado", "Configurações"]);
    // the bottom bar is not regrouped: what is left of Gestão keeps its label, Vendas has nothing left here
    await expect(panel.locator('[data-sidebar="group-label"]')).toHaveText([
      "Gestão",
    ]);
    const current = panel.locator('[aria-current="page"]');
    await expect(current).toHaveText("Produtos");
    await expect(
      panel.getByRole("button", { exact: true, name: "Sair" })
    ).toBeVisible();
    await panel.getByRole("link", { name: "Clientes" }).click();
    await page.waitForURL("**/customers");
    await expect(bar.locator('[aria-current="true"]')).toHaveText("Estoque");

    // a screen of no destination of the bar marks Mais: Resultado and Configurações, with their tabs
    for (const path of [
      "/dashboard",
      "/dashboard?aba=despesas",
      "/configuracoes",
      "/configuracoes?aba=catalogo-publico",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one page at a time
      await page.goto(path);
      await expect(bar.locator("[aria-current]")).toHaveCount(0);
      await expect(more(page).locator("[data-bottom-mark]")).toHaveCount(1);
    }
  });

  test("em Mais, o menu da loja abre acima da folha (que é um diálogo modal), cabe na tela e troca a loja", async ({
    page,
  }) => {
    const long = {
      ...SECOND_ORGANIZATION,
      id: "0199c2d0-0000-7000-8000-00000000a003",
      name: "Loja do centro da cidade com um nome bem comprido para quebrar linha no menu",
    };
    await serve(page, [...ORGANIZATIONS, SECOND_ORGANIZATION, long]);
    await page.goto("/products");
    await more(page).click();
    const store = page.getByRole("combobox", { exact: true, name: "Loja" });
    await store.click();
    // a click only lands if nothing (the sheet or its veil) covers the option: Playwright checks what is hit
    const option = page.getByRole("option", { exact: true, name: long.name });
    await expect(option).toBeVisible();
    const box = await option.boundingBox();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(360);
    // Escape closes the menu only: the sheet (the dialog around it) stays open
    await page.keyboard.press("Escape");
    await expect(option).toBeHidden();
    await expect(page.getByRole("dialog", { name: "Mais" })).toBeVisible();
    await store.click();
    await option.click();
    await expect(store).toContainText("Loja do centro da cidade");
  });

  test("Mais abre e fecha com o teclado, e o foco volta para o botão", async ({
    page,
  }) => {
    await serve(page);
    await page.goto("/");
    await more(page).focus();
    await page.keyboard.press("Enter");
    const panel = page.getByRole("dialog", { name: "Mais" });
    await expect(panel).toBeVisible();
    await expect(more(page)).toHaveAttribute("aria-expanded", "true");
    // the focus went inside, and Tab stays inside while it is open
    expect(
      await panel.evaluate((node) => node.contains(document.activeElement))
    ).toBe(true);
    for (let step = 0; step < 20; step += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: one key at a time
      await page.keyboard.press("Tab");
    }
    expect(
      await panel.evaluate((node) => node.contains(document.activeElement))
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(more(page)).toBeFocused();
    await expect(more(page)).toHaveAttribute("aria-expanded", "false");

    // Space opens it too, and "Fechar" closes it
    await page.keyboard.press(" ");
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { exact: true, name: "Fechar" }).click();
    await expect(panel).toBeHidden();
    await expect(more(page)).toBeFocused();
  });

  test("Sair em Mais encerra a sessão", async ({ page }) => {
    const state = await serve(page);
    await page.goto("/");
    await expect(chip(page)).toContainText("Tudo sincronizado", {
      timeout: 20_000,
    });
    await more(page).click();
    await page
      .getByRole("dialog", { name: "Mais" })
      .getByRole("button", { exact: true, name: "Sair" })
      .click();
    await expect.poll(() => state.signOutCalls).toBe(1);
    await expect(page).toHaveURL(LEFT_TO_START);
  });
});

/* -------------------------------------------------------------------------- */
/* The eight destinations, the tabs, the old addresses, Pendências and the folding column                           */
/* -------------------------------------------------------------------------- */

const pathOf = (page: Page) => {
  const url = new URL(page.url());
  return `${url.pathname}${url.search}`;
};

/**
 * One command of this device that the server refused (as `sync.push` leaves it): written into the outbox of the
 * runtime, which opened with the page, and read again on a reload. The screens of this harness have no copy of their
 * own to queue with, so the record is made here, in the shape the outbox keeps.
 */
async function leaveOneRefused(page: Page) {
  await page.goto("/");
  await expect(chip(page)).toContainText("Tudo sincronizado", {
    timeout: 20_000,
  });
  await page.evaluate(
    async ({ deviceId, organizationId }) => {
      const names = (await indexedDB.databases())
        .map(({ name }) => name ?? "")
        .filter((name) => name.startsWith("polaris-outbox-"));
      for (const name of names) {
        // biome-ignore lint/performance/noAwaitInLoops: one database, the one of this person
        await new Promise<void>((resolve, reject) => {
          const opening = indexedDB.open(name);
          opening.onerror = () => reject(opening.error);
          opening.onsuccess = () => {
            const tx = opening.result.transaction(
              ["commands", "meta"],
              "readwrite"
            );
            const at = new Date().toISOString();
            tx.objectStore("commands").put({
              attempts: 1,
              baseVersion: null,
              commandId: crypto.randomUUID(),
              createdAt: at,
              deviceId,
              lastAttemptAt: at,
              lease: "lease",
              organizationId,
              payload: { name: "Bia Souza" },
              rejection: { at, code: "validation_failed" },
              seq: 1,
              status: "rejected",
              type: "customer.create",
            });
            tx.objectStore("meta").put(1, "lastSeq");
            tx.oncomplete = () => {
              opening.result.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
          };
        });
      }
      return names.length;
    },
    { deviceId: DEVICE.id, organizationId: ORGANIZATION_ID }
  );
  await page.reload();
  await expect(chip(page)).toContainText("precisa de atenção", {
    timeout: 20_000,
  });
}

/** The text of the Pendências link: its name and the drawn count (its accessible name says the count in words). */
const PENDENCIAS_WITH_COUNT = "Pendências1";

const tabList = (page: Page, name: string) =>
  page.getByRole("tablist", { exact: true, name });

test.describe("os 8 destinos e as abas (1280 px)", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
  });

  test("cada destino da lateral abre a sua tela e fica como o atual", async ({
    page,
  }) => {
    await serve(page);
    await page.goto("/");
    for (const [label, path] of [
      ["Vender", "/sales"],
      ["Histórico", "/sales/history"],
      ["Estoque", "/inventory"],
      ["Produtos", "/products"],
      ["Clientes", "/customers"],
      ["Resultado", "/dashboard"],
      ["Configurações", "/configuracoes"],
      ["Início", "/"],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: one destination at a time
      await sidebar(page)
        .getByRole("link", { exact: true, name: label })
        .click();
      await expect.poll(() => pathOf(page)).toBe(path);
      await expect(sidebar(page).locator('[aria-current="page"]')).toHaveText(
        label
      );
      await expect(sidebar(page).getByRole("link")).toHaveText(DESTINATIONS);
    }
  });

  const tabScreens: {
    label: string;
    path: string;
    tabs: [name: string, address: string][];
    title: string;
  }[] = [
    {
      label: "Produtos e categorias",
      path: "/products",
      tabs: [
        ["Produtos", "/products"],
        ["Categorias", "/products?aba=categorias"],
      ],
      title: "Produtos",
    },
    {
      label: "Resultado, metas e despesas",
      path: "/dashboard",
      tabs: [
        ["Resultado", "/dashboard"],
        ["Metas", "/dashboard?aba=metas"],
        ["Despesas", "/dashboard?aba=despesas"],
      ],
      title: "Resultado",
    },
    {
      label: "Configurações",
      path: "/configuracoes",
      // Assinatura without billing:manage and Senha with the password off are not offered (map § 1)
      tabs: [
        ["Formas de receber", "/configuracoes"],
        ["Catálogo público", "/configuracoes?aba=catalogo-publico"],
        ["Aparelhos", "/configuracoes?aba=aparelhos"],
      ],
      title: "Configurações",
    },
  ];
  for (const screen of tabScreens) {
    test(`${screen.title}: cada aba abre a sua tela, fica no endereço e volta marcada ao recarregar`, async ({
      page,
    }) => {
      await serve(page);
      await page.goto(screen.path);
      await expect(
        page.getByRole("heading", { exact: true, level: 1, name: screen.title })
      ).toBeVisible();
      const list = tabList(page, screen.label);
      await expect(list.getByRole("tab")).toHaveText(
        screen.tabs.map(([name]) => name)
      );
      for (const [name, address] of screen.tabs) {
        const tab = list.getByRole("tab", { exact: true, name });
        // biome-ignore lint/performance/noAwaitInLoops: one tab at a time
        await tab.click();
        await expect(tab).toHaveAttribute("aria-selected", "true");
        await expect.poll(() => pathOf(page)).toBe(address);
        // the menu keeps the destination current on every tab
        await expect(sidebar(page).locator('[aria-current="page"]')).toHaveText(
          screen.title
        );
        await expect(page.getByRole("tabpanel")).toHaveCount(1);
      }
      // a reload opens the tab of the address, and the tab changes leave no step in the history
      await page.reload();
      const last = screen.tabs.at(-1)?.[0] ?? "";
      await expect(
        tabList(page, screen.label).getByRole("tab", {
          exact: true,
          name: last,
        })
      ).toHaveAttribute("aria-selected", "true");
    });
  }

  test("trocar de aba não deixa passo no histórico nem reabre o que o endereço abriu; aba que não existe abre a primeira", async ({
    page,
  }) => {
    await serve(page);
    await page.goto("/");
    await page.goto("/products?novo=1");
    // the new product opens in its dialog (F3.3), over the tab
    const form = page.getByRole("dialog", { name: "Novo produto" });
    await expect(form).toBeVisible();
    await form.getByRole("button", { exact: true, name: "Cancelar" }).click();
    await expect(form).toBeHidden();
    const steps = await page.evaluate(() => history.length);
    const list = tabList(page, "Produtos e categorias");
    await list.getByRole("tab", { exact: true, name: "Categorias" }).click();
    await expect.poll(() => pathOf(page)).toBe("/products?aba=categorias");
    await list.getByRole("tab", { exact: true, name: "Produtos" }).click();
    await expect.poll(() => pathOf(page)).toBe("/products");
    // the link of the new product was the tab's: it does not open the form again
    await expect(form).toBeHidden();
    expect(await page.evaluate(() => history.length)).toBe(steps);
    // "voltar" leaves the screen, it does not walk the tabs
    await page.goBack();
    await expect.poll(() => pathOf(page)).toBe("/");

    // a tab that does not exist opens the first one of the screen, and the address says so (no step in the history)
    await page.goto("/configuracoes?aba=nenhuma");
    const stepsBefore = await page.evaluate(() => history.length);
    await expect(
      tabList(page, "Configurações").getByRole("tab", {
        exact: true,
        name: "Formas de receber",
      })
    ).toHaveAttribute("aria-selected", "true");
    await expect.poll(() => pathOf(page)).toBe("/configuracoes");
    expect(await page.evaluate(() => history.length)).toBe(stepsBefore);
  });

  test("sem conexão, o chip e a faixa seguem a aba aberta: Produtos funciona do aparelho, Categorias precisa de internet", async ({
    context,
    page,
  }) => {
    await serve(page);
    await page.goto("/products");
    await expect(chip(page)).toContainText("Tudo sincronizado", {
      timeout: 20_000,
    });
    await context.setOffline(true);
    const strip = page.getByText("Esta tela precisa de conexão.", {
      exact: false,
    });
    const list = tabList(page, "Produtos e categorias");
    await list.getByRole("tab", { exact: true, name: "Categorias" }).click();
    await expect(strip).toBeVisible({ timeout: 20_000 });
    await expect(chip(page)).toHaveAttribute("title", NEEDS_INTERNET_TITLE);
    await list.getByRole("tab", { exact: true, name: "Produtos" }).click();
    await expect(strip).toHaveCount(0);
    await expect(chip(page)).not.toHaveAttribute("title", NEEDS_INTERNET_TITLE);
  });

  test("as abas andam com as setas do teclado e a tela da aba tem o título dela", async ({
    page,
  }) => {
    await serve(page);
    await page.goto("/configuracoes");
    const list = tabList(page, "Configurações");
    await list
      .getByRole("tab", { exact: true, name: "Formas de receber" })
      .focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    const tab = list.getByRole("tab", {
      exact: true,
      name: "Catálogo público",
    });
    await expect(tab).toBeFocused();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(
      page.getByRole("heading", {
        exact: true,
        level: 2,
        name: "Catálogo público",
      })
    ).toBeVisible();
    // one h1 a page: the destination
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Configurações"
    );
  });

  test("os endereços antigos abrem a aba certa, sem quebrar link salvo", async ({
    page,
  }) => {
    await serve(page);
    await authMethods(page, true);
    for (const [old, address, list, tab] of [
      [
        "/categories",
        "/products?aba=categorias",
        "Produtos e categorias",
        "Categorias",
      ],
      [
        "/expenses",
        "/dashboard?aba=despesas",
        "Resultado, metas e despesas",
        "Despesas",
      ],
      [
        "/payment-profiles",
        "/configuracoes",
        "Configurações",
        "Formas de receber",
      ],
      [
        "/public-catalog",
        "/configuracoes?aba=catalogo-publico",
        "Configurações",
        "Catálogo público",
      ],
      [
        "/devices",
        "/configuracoes?aba=aparelhos",
        "Configurações",
        "Aparelhos",
      ],
      [
        "/subscription",
        "/configuracoes?aba=assinatura",
        "Configurações",
        "Assinatura",
      ],
      [
        "/conta/seguranca",
        "/configuracoes?aba=senha",
        "Configurações",
        "Senha",
      ],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: one address at a time
      await page.goto(old);
      await expect.poll(() => pathOf(page)).toBe(address);
      await expect(
        tabList(page, list).getByRole("tab", { exact: true, name: tab })
      ).toHaveAttribute("aria-selected", "true");
    }
    // the rest of the query goes on (the return of a checkout)
    await page.goto("/subscription?retorno=concluida");
    await expect
      .poll(() => pathOf(page))
      .toBe("/configuracoes?retorno=concluida&aba=assinatura");
  });

  test("Despesas no Resultado: o segmento vem do endereço (?ver=), o inválido cai em Lançamentos no lugar e trocar de aba o tira", async ({
    page,
  }) => {
    await serve(page);
    const segments = page.getByRole("tablist", {
      name: "Lançamentos, recorrentes e categorias",
    });
    for (const [ver, segment] of [
      ["recorrentes", "Recorrentes"],
      ["categorias", "Categorias"],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: one address at a time
      await page.goto(`/dashboard?aba=despesas&ver=${ver}`);
      await expect(
        segments.getByRole("tab", { exact: true, name: segment })
      ).toHaveAttribute("aria-selected", "true");
    }
    // the old address keeps the part
    await page.goto("/expenses?ver=categorias");
    await expect
      .poll(() => pathOf(page))
      .toBe("/dashboard?ver=categorias&aba=despesas");
    await expect(
      segments.getByRole("tab", { exact: true, name: "Categorias" })
    ).toHaveAttribute("aria-selected", "true");

    await page.goto("/dashboard?aba=despesas&ver=xyz");
    const steps = await page.evaluate(() => history.length);
    await expect.poll(() => pathOf(page)).toBe("/dashboard?aba=despesas");
    await expect(
      segments.getByRole("tab", { exact: true, name: "Lançamentos" })
    ).toHaveAttribute("aria-selected", "true");
    expect(await page.evaluate(() => history.length)).toBe(steps);

    // the part belongs to the Despesas tab: another tab of the Resultado drops it from the address
    await segments
      .getByRole("tab", { exact: true, name: "Recorrentes" })
      .click();
    await expect
      .poll(() => pathOf(page))
      .toBe("/dashboard?aba=despesas&ver=recorrentes");
    await tabList(page, "Resultado, metas e despesas")
      .getByRole("tab", { exact: true, name: "Metas" })
      .click();
    await expect.poll(() => pathOf(page)).toBe("/dashboard?aba=metas");
    expect(await page.evaluate(() => history.length)).toBe(steps);
  });

  test("/sales/customer não existe mais: o 404 do shell leva ao Início e ao Histórico", async ({
    page,
  }) => {
    await serve(page);
    await page.goto(
      "/sales/customer?saleId=0199c2d0-0000-7000-8000-000000000001"
    );
    await expect(
      page.getByRole("heading", { name: "Página não encontrada" })
    ).toBeVisible();
    await expect(
      page.getByRole("link", { exact: true, name: "Ir para o Início" })
    ).toHaveAttribute("href", "/");
    await expect(
      page.getByRole("link", { exact: true, name: "Ver o histórico" })
    ).toHaveAttribute("href", "/sales/history");
  });

  test("Pendências aparece só com registro recusado, com o número, e marca a si mesma", async ({
    page,
  }) => {
    await serve(page);
    await page.goto("/");
    await expect(
      sidebar(page).getByRole("link", { name: "Pendências" })
    ).toHaveCount(0);
    await leaveOneRefused(page);
    const link = sidebar(page).getByRole("link", {
      exact: true,
      name: "Pendências, 1 registro recusado",
    });
    await expect(link).toBeVisible();
    await expect(link.locator("[data-attention-count]")).toHaveText("1");
    // the ninth, right after Histórico
    await expect(sidebar(page).getByRole("link")).toHaveText([
      "Início",
      "Vender",
      "Histórico",
      PENDENCIAS_WITH_COUNT,
      ...DESTINATIONS.slice(3),
    ]);
    await link.click();
    await expect.poll(() => pathOf(page)).toBe("/attention");
    await expect(sidebar(page).locator('[aria-current="page"]')).toContainText(
      "Pendências"
    );
  });
});

test.describe("lateral recolhível (a partir de 1024 px)", () => {
  const collapse = (page: Page) =>
    page.getByRole("button", { exact: true, name: "Recolher menu" });
  const expand = (page: Page) =>
    page.getByRole("button", { exact: true, name: "Expandir menu" });

  test("o botão do topo recolhe só para os ícones, com o nome de cada destino, e a escolha fica no aparelho", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await serve(page);
    await page.goto("/products");
    const nav = sidebar(page);
    const wide = (await nav.boundingBox())?.width ?? 0;
    await expect(collapse(page)).toHaveAttribute("aria-expanded", "true");
    await collapse(page).click();
    await expect(expand(page)).toHaveAttribute("aria-expanded", "false");
    await expect
      .poll(async () => (await nav.boundingBox())?.width ?? 0)
      .toBeLessThan(wide / 3);
    // folded, the links keep their names (for a screen reader) and the current one its mark
    await expect(nav.getByRole("link")).toHaveText(DESTINATIONS);
    await expect(nav.locator('[aria-current="page"]')).toHaveAccessibleName(
      "Produtos"
    );
    // only to the eye: the name is a pixel, out of sight
    expect(
      (await nav.getByText("Produtos", { exact: true }).boundingBox())?.width ??
        0
    ).toBeLessThanOrEqual(1);
    // the name in a tooltip beside the icon
    await nav.getByRole("link", { exact: true, name: "Clientes" }).hover();
    await expect(page.locator("[data-slot=tooltip-content]")).toHaveText(
      "Clientes"
    );
    // the legal links leave the folded column for the foot of the content
    await expect(
      page.getByRole("link", { exact: true, name: "Termos de Uso" })
    ).toBeVisible();
    // kept on the device: a reload opens it folded
    await page.reload();
    await expect(expand(page)).toBeVisible();
    await expand(page).click();
    await expect(collapse(page)).toBeVisible();
    await expect
      .poll(async () => (await nav.boundingBox())?.width ?? 0)
      .toBeGreaterThan(wide - 2);
  });

  test("Ctrl+B recolhe e abre sem tirar o foco do item, e a borda da lateral também", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1024 });
    await serve(page);
    await page.goto("/");
    await expect(collapse(page)).toBeVisible();
    const item = sidebar(page).getByRole("link", {
      exact: true,
      name: "Estoque",
    });
    await item.focus();
    await page.keyboard.press("Control+b");
    await expect(expand(page)).toBeVisible();
    await expect(item).toBeFocused();
    await page.keyboard.press("Control+b");
    await expect(collapse(page)).toBeVisible();
    await page.locator('[data-sidebar="rail"]').click();
    await expect(expand(page)).toBeVisible();
  });

  test("de 760 a 1023 px a lateral não recolhe, nem com a escolha guardada", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await serve(page);
    await page.goto("/");
    await collapse(page).click();
    await expect(expand(page)).toBeVisible();
    await page.setViewportSize({ height: 800, width: 900 });
    await expect(expand(page)).toHaveCount(0);
    await expect(collapse(page)).toHaveCount(0);
    await page.keyboard.press("Control+b");
    // open, with every name written
    const name = sidebar(page)
      .getByRole("link", { exact: true, name: "Configurações" })
      .getByText("Configurações", { exact: true });
    expect((await name.boundingBox())?.width ?? 0).toBeGreaterThan(40);
  });
});

test.describe("barra do celular a 360 e 320 px", () => {
  for (const width of [360, 320]) {
    test(`${width} px: a barra cabe, Vender no centro, e o número de Pendências fica em Mais`, async ({
      page,
    }) => {
      await page.setViewportSize({ height: 740, width });
      await serve(page);
      await leaveOneRefused(page);
      const bar = bottomBar(page);
      await expect(bar.getByRole("link")).toHaveText([
        "Início",
        "Histórico",
        "Vender",
        "Estoque",
      ]);
      // each of the five is whole on the screen, and nothing scrolls sideways
      for (const item of await bar.locator("a, button").all()) {
        // biome-ignore lint/performance/noAwaitInLoops: one item at a time
        await expect(item).toBeInViewport({ ratio: 1 });
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth
        )
      ).toBe(true);
      await expect(more(page).locator("[data-attention-count]")).toHaveText(
        "1"
      );
      await more(page).click();
      const panel = page.getByRole("dialog", { name: "Mais" });
      await expect(
        panel.getByRole("navigation", { name: "Principal" }).getByRole("link")
      ).toHaveText([
        PENDENCIAS_WITH_COUNT,
        "Produtos",
        "Clientes",
        "Resultado",
        "Configurações",
      ]);
      await expect(
        panel.getByRole("button", { exact: true, name: "Sair" })
      ).toBeVisible();
      // no folding on the phone
      await expect(
        page.getByRole("button", { name: "Recolher menu" })
      ).toHaveCount(0);
    });
  }
});

test.describe("pé do menu: primeiros passos e teste grátis", () => {
  /** A trial with its first charge set, as the server reads it (every key: the answer is strict). */
  const TRIAL_PLAN = {
    accessEndsAt: "2026-11-11T03:00:00.000Z",
    cycleMonths: 1,
    kept: { historyMonths: 3, products: 18, sales: 47 },
    limits: { goals: 3, images: 5000, variants: 2000 },
    method: "card",
    nextCharge: { amount: "24.90", on: "2026-11-10" },
    offer: {
      methods: ["card", "pix_automatic"],
      prices: [
        { amount: "249.00", cycleMonths: 12 },
        { amount: "24.90", cycleMonths: 1 },
      ],
    },
    recovery: null,
    refund: null,
    refundPending: false,
    refundWindowEndedOn: null,
    renewalCancelled: false,
    resubscribeFrom: null,
    state: "trialing",
    trialAvailable: false,
    usage: { goals: 1, images: 12, variants: 38 },
  };
  const STEPS_NAME = "Primeiros passos, 2 de 3 concluídos";
  const TRIAL_NAME =
    "Teste grátis, primeira cobrança em 10/11, abrir Assinatura";

  /**
   * The shell of a store in its trial: `steps` is what the Início read of the first steps in this tab, `role` and
   * `billingSelfService` say whether this person manages the billing. Counts the reads of the plan.
   */
  async function serveFoot(
    page: Page,
    {
      billingSelfService = true,
      role = "owner",
      steps = 2,
    }: { billingSelfService?: boolean; role?: string; steps?: number | null }
  ) {
    const organizations = [
      {
        id: ORGANIZATION_ID,
        name: "Loja do teste",
        role,
        timezone: "America/Sao_Paulo",
      },
    ];
    await serve(page, organizations);
    await page.route("**/rpc/organization/listMine", (route) =>
      route.fulfill(json({ billingSelfService, organizations }))
    );
    const reads = { plan: 0 };
    await page.route("**/rpc/billing/readPlan", (route) => {
      reads.plan += 1;
      return route.fulfill(json(TRIAL_PLAN));
    });
    if (steps !== null) {
      await page.addInitScript(
        ([organizationId, done]) => {
          sessionStorage.setItem(
            "polaris.home.firstSteps",
            JSON.stringify({ done, organizationId })
          );
        },
        [ORGANIZATION_ID, steps] as const
      );
    }
    return reads;
  }

  const stepsLink = (page: Page) =>
    page.getByRole("link", { exact: true, name: STEPS_NAME });
  const trialLink = (page: Page) =>
    page.getByRole("link", { exact: true, name: TRIAL_NAME });

  test("1280 px: os dois itens acima do cartão da loja, cada um levando ao seu lugar", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    const reads = await serveFoot(page, {});
    await page.goto("/products");
    await expect(stepsLink(page)).toBeVisible();
    await expect(stepsLink(page)).toHaveAttribute("href", "/#home-checklist");
    await expect(stepsLink(page)).toContainText("Primeiros passos");
    await expect(stepsLink(page)).toContainText("2 de 3");
    await expect(trialLink(page)).toBeVisible();
    await expect(trialLink(page)).toHaveAttribute(
      "href",
      "/configuracoes?aba=assinatura"
    );
    await expect(trialLink(page)).toContainText("1ª cobrança em 10/11");
    await expect(trialLink(page)).toContainText("Assinatura");
    // the date, never a count of days (AS-3, AC-12)
    await expect(page.locator("[data-menu-progress]")).not.toContainText(DAYS);
    // out of the destinations, at the foot, in order: steps, trial, the card of the store
    await expect(
      sidebar(page).getByRole("link", { name: "Primeiros passos" })
    ).toHaveCount(0);
    const steps = await stepsLink(page).boundingBox();
    const trial = await trialLink(page).boundingBox();
    const card = await page.locator("[data-store-card]").boundingBox();
    expect(steps?.y ?? 0).toBeLessThan(trial?.y ?? 0);
    expect((trial?.y ?? 0) + (trial?.height ?? 0)).toBeLessThanOrEqual(
      card?.y ?? 0
    );
    expect(reads.plan).toBe(1);
    await trialLink(page).click();
    await page.waitForURL("**/configuracoes?aba=assinatura");
  });

  test("sem billing:manage (papel sem a permissão), nada da assinatura aparece nem é lido, nem em Mais", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    const reads = await serveFoot(page, { role: "cashier" });
    await page.goto("/products");
    // the steps are not of the billing: they stay
    await expect(stepsLink(page)).toBeVisible();
    await expect(trialLink(page)).toHaveCount(0);
    await expect(page.getByText("Teste grátis")).toHaveCount(0);
    await expect(page.locator("[data-menu-trial]")).toHaveCount(0);

    await page.setViewportSize({ height: 740, width: 360 });
    await more(page).click();
    const panel = page.getByRole("dialog", { name: "Mais" });
    await expect(
      panel.getByRole("link", { exact: true, name: STEPS_NAME })
    ).toBeVisible();
    await expect(panel.getByText("Teste grátis")).toHaveCount(0);
    expect(reads.plan).toBe(0);
  });

  test("dono com o autosserviço desligado: nada da assinatura", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    const reads = await serveFoot(page, {
      billingSelfService: false,
      steps: null,
    });
    await page.goto("/products");
    await expect(page.locator("[data-store-card]")).toBeVisible();
    await expect(page.locator("[data-menu-progress]")).toHaveCount(0);
    await expect(page.getByText("Teste grátis")).toHaveCount(0);
    expect(reads.plan).toBe(0);
  });

  test("sem passos lidos (a loja já vendeu) e fora do teste: o pé fica só com o cartão", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await serveFoot(page, { steps: null });
    await page.route("**/rpc/billing/readPlan", (route) =>
      route.fulfill(json({ ...TRIAL_PLAN, nextCharge: null, state: "active" }))
    );
    await page.goto("/products");
    await expect(page.locator("[data-store-card]")).toBeVisible();
    await expect(page.locator("[data-menu-progress]")).toHaveCount(0);
  });

  test("recolhida, só os ícones, com o texto no tooltip e o nome inteiro no link", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await serveFoot(page, {});
    await page.goto("/products");
    await page
      .getByRole("button", { exact: true, name: "Recolher menu" })
      .click();
    await expect(
      page.getByRole("button", { exact: true, name: "Expandir menu" })
    ).toBeVisible();
    for (const [link, tooltip] of [
      [stepsLink(page), "Primeiros passos · 2 de 3"],
      [trialLink(page), "Teste grátis · 1ª cobrança em 10/11"],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: one tooltip at a time
      await expect(link).toBeVisible();
      const box = await link.boundingBox();
      expect(box?.width ?? 99).toBeLessThanOrEqual(48);
      await link.hover();
      await expect(page.locator("[data-slot=tooltip-content]")).toHaveText(
        tooltip
      );
      await page.mouse.move(600, 400);
      await expect(page.locator("[data-slot=tooltip-content]")).toHaveCount(0);
    }
  });

  test("360 px: as duas linhas ficam em Mais, antes do tema", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await serveFoot(page, {});
    await page.goto("/products");
    await expect(bottomBar(page)).toBeVisible();
    await more(page).click();
    const panel = page.getByRole("dialog", { name: "Mais" });
    const steps = panel.getByRole("link", { exact: true, name: STEPS_NAME });
    const trial = panel.getByRole("link", { exact: true, name: TRIAL_NAME });
    await expect(steps).toBeVisible();
    await expect(trial).toBeVisible();
    const theme = panel.getByRole("group", { name: "Aparência" });
    const stepsBox = await steps.boundingBox();
    const trialBox = await trial.boundingBox();
    const themeBox = await theme.boundingBox();
    expect(stepsBox?.y ?? 0).toBeLessThan(trialBox?.y ?? 0);
    expect((trialBox?.y ?? 0) + (trialBox?.height ?? 0)).toBeLessThanOrEqual(
      themeBox?.y ?? 0
    );
    // a touch target of the phone, and nothing out of the sheet's width
    expect(trialBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true);
  });
});
