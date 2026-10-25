/// <reference lib="dom" />

import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import { signOfflineLease } from "../src/lib/offline-lease-token";
import { serveHealth, WORKER_MARK } from "./worker-mark";

/**
 * The shell v5.1 (t225): the sidebar of the desktop, the bottom bar and "Mais" of the phone, the theme and "Sair",
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
const USER_ID = "user-do-teste";
const EMAIL = "contato@exemplo.com.br";
const LEASE_KEY = {
  id: "teste",
  secret: "teste-secret-teste-secret-teste-secret-0123456789",
};
const HOUR = 3_600_000;
const DARK = /\bdark\b/;
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

/** The server of a test: a signed-in person with one store, and nothing queued. */
async function serve(page: Page, organizations = ORGANIZATIONS) {
  const state = { signOutCalls: 0 };
  // the Início reads in vain here (every other /rpc is cut): the probe finds the Worker, so it is not "offline"
  await serveHealth(page);
  await page.route("**/rpc/**", (route) => route.abort("internetdisconnected"));
  await page.route("**/rpc/organization/listMine", (route) =>
    route.fulfill(json({ organizations }))
  );
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
    await expect(nav.getByRole("link")).toHaveText([
      "Início",
      "Vender",
      "Histórico",
      "Estoque",
      "Produtos",
      "Categorias",
      "Clientes",
      "Despesas",
      "Resultado",
      "Perfis de pagamento",
      "Catálogo público",
      "Aparelhos",
    ]);
    await expect(nav.locator('[data-sidebar="group-label"]')).toHaveText([
      "Catálogo",
      "Resultado",
      "Configurações",
    ]);
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

    // the top of the sidebar: the mark and "Polaris"; the foot: the theme, the store, the e-mail and "Sair"
    await expect(
      page.getByRole("link", { exact: true, name: "Polaris" })
    ).toBeVisible();
    await expect(
      page.getByText("Loja do teste", { exact: true })
    ).toBeVisible();
    await expect(page.getByText(EMAIL, { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { exact: true, name: "Sair" })
    ).toBeVisible();

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

  test("com duas lojas, o seletor da lateral é o Select do tema, tem o rótulo Loja e troca a loja", async ({
    page,
  }) => {
    await serve(page, [...ORGANIZATIONS, SECOND_ORGANIZATION]);
    await page.goto("/products");
    const store = page.getByRole("combobox", { exact: true, name: "Loja" });
    await expect(store).toContainText("Loja do teste");
    await store.click();
    // the menu is the themed one (a listbox of options), not the one of the system
    await expect(page.getByRole("option")).toHaveText([
      "Loja do teste",
      "Loja da filial",
    ]);
    await page
      .getByRole("option", { exact: true, name: "Loja da filial" })
      .click();
    await expect(store).toContainText("Loja da filial");
    // the choice is the one kept for the next visit
    await page.reload();
    await expect(
      page.getByRole("combobox", { exact: true, name: "Loja" })
    ).toContainText("Loja da filial");
  });

  test("o tema escolhido na lateral troca a classe do <html> e a cor da barra do navegador", async ({
    page,
  }) => {
    await serve(page);
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    const appearance = page.getByRole("group", { name: "Aparência" });
    await expect(
      appearance.getByRole("button", { name: "Automático" })
    ).toHaveAttribute("aria-pressed", "true");
    await appearance.getByRole("button", { name: "Escuro" }).click();
    await expect(page.locator("html")).toHaveClass(DARK);
    await expect(
      appearance.getByRole("button", { name: "Escuro" })
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.locator('meta[name="theme-color"][data-tema="escuro"]')
    ).toHaveAttribute("media", "all");
    await expect(
      page.locator('meta[name="theme-color"][data-tema="claro"]')
    ).toHaveAttribute("media", "not all");

    // the choice survives the next page
    await page.goto("/products");
    await expect(page.locator("html")).toHaveClass(DARK);
    await page
      .getByRole("group", { name: "Aparência" })
      .getByRole("button", { name: "Automático" })
      .click();
    await expect(page.locator("html")).not.toHaveClass(DARK);
    await expect(
      page.locator('meta[name="theme-color"][data-tema="claro"]')
    ).toHaveAttribute("media", "(prefers-color-scheme: light)");
  });

  test("Sair na lateral encerra a sessão e vai para o início", async ({
    page,
  }) => {
    const state = await serve(page);
    await page.goto("/");
    await expect(chip(page)).toContainText("Tudo sincronizado", {
      timeout: 20_000,
    });
    await page.getByRole("button", { exact: true, name: "Sair" }).click();
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
    // Início, Vender, Histórico, Estoque and Mais (desenho t269 v2, § 4): the Início at one touch, Vender too
    await expect(bar.getByRole("link")).toHaveText([
      "Início",
      "Vender",
      "Histórico",
      "Estoque",
    ]);
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
    // Estoque marks its area (Produtos, Categorias, Clientes); Mais does not
    await expect(bar.locator('[aria-current="page"]')).toHaveCount(0);
    await expect(bar.locator('[aria-current="true"]')).toHaveText("Estoque");
    await expect(bar.locator("[data-bottom-mark]")).toHaveCount(1);
    await more(page).click();
    const panel = page.getByRole("dialog", { name: "Mais" });
    await expect(panel).toBeVisible();
    // the four of the bar are not repeated in Mais; Resultado is there now
    await expect(panel.getByRole("link", { name: "Vender" })).toHaveCount(0);
    await expect(panel.getByRole("link", { name: "Início" })).toHaveCount(0);
    await expect(panel.getByRole("link", { name: "Resultado" })).toBeVisible();
    const current = panel.locator('[aria-current="page"]');
    await expect(current).toHaveText("Produtos");
    await expect(
      panel.getByRole("button", { exact: true, name: "Sair" })
    ).toBeVisible();
    await panel.getByRole("link", { name: "Clientes" }).click();
    await page.waitForURL("**/customers");
    await expect(bar.locator('[aria-current="true"]')).toHaveText("Estoque");

    // a screen of no destination of the bar marks Mais: Resultado and Despesas since the Início took their place
    for (const path of ["/dashboard", "/expenses", "/payment-profiles"]) {
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
