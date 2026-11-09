/// <reference lib="dom" />

import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { SUPPORT_ADDRESS } from "./support-address";
import {
  authMethods,
  EMAIL,
  json,
  leaveOneRefused,
  ORGANIZATIONS,
  SECOND_ORGANIZATION,
  serve,
  serveFoot,
  TRIAL_PLAN,
} from "./shell-server";
import { WORKER_MARK } from "./worker-mark";

/** The button of the menu of the store in the header: what the menu holds, then the store. */
const STORE_MENU_NAME = /^Loja, conta e ajuda: /;

/**
 * The shell: the sidebar of the desktop, the bottom bar and "Mais" of the phone, the header with the menu of the store
 * (the theme, Ajuda, the legal pages and "Sair"),
 * against a server played by network interception with the offline runtime on (the devices screen has the same).
 */

/** The hint of the connection chip on a screen that needs the network. */
const NEEDS_INTERNET_TITLE = /esta tela precisa de internet/;
const DARK = /\bdark\b/;
/** A count of days, which the trial at the foot of the menu never says (AS-3, AC-12). */
const DAYS = /\d+ dias?\b/;
const ENTRAR = /\/entrar(\?.*)?$/;
const LEFT_TO_START = /\/(entrar\?motivo=saiu.*)?$/;

const sidebar = (page: Page) =>
  page.getByRole("navigation", { exact: true, name: "Principal" });
const bottomBar = (page: Page) =>
  page.getByRole("navigation", { exact: true, name: "Destinos" });
const more = (page: Page) =>
  page.getByRole("button", { exact: true, name: "Mais" });
const chip = (page: Page) => page.locator(".sync-status");
const storeMenu = (page: Page) =>
  page.getByRole("button", { name: STORE_MENU_NAME });
/** The store and the e-mail at the top of the open menu of the header. */
const identity = (page: Page) => page.locator("[data-store-identity]");

/** The nine destinations of the menu, in order (map of navigation, § 1). */
const DESTINATIONS = [
  "Início",
  "Vender",
  "Histórico",
  "Estoque",
  "Produtos",
  "Clientes",
  "Resultado",
  "Despesas",
  "Configurações",
];

test.describe("desktop (1280 px)", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
  });

  test("a lateral tem os grupos da v5.1, marca o item atual e o chip fica no cabeçalho", async ({
    page,
  }) => {
    await serve(page);
    await page.goto("/products");
    const nav = sidebar(page);
    await expect(nav).toBeVisible();
    await expect(bottomBar(page)).toBeHidden();
    // the nine destinations (map of navigation, § 1): no Pendências with nothing refused
    await expect(nav.getByRole("link")).toHaveText(DESTINATIONS);
    // Início and Configurações alone; Vendas, Gestão and Resultado with their small label (map of navigation, § 1)
    await expect(nav.locator('[data-sidebar="group-label"]')).toHaveText([
      "Vendas",
      "Gestão",
      "Resultado",
    ]);
    const groups = nav.locator('[data-sidebar="group"]');
    await expect(groups).toHaveCount(5);
    await expect(groups.nth(0).getByRole("link")).toHaveText(["Início"]);
    await expect(groups.nth(1).getByRole("link")).toHaveText([
      "Vender",
      "Histórico",
    ]);
    await expect(groups.nth(2).getByRole("link")).toHaveText([
      "Estoque",
      "Produtos",
      "Clientes",
    ]);
    await expect(groups.nth(3).getByRole("link")).toHaveText([
      "Resultado",
      "Despesas",
    ]);
    await expect(groups.nth(4).getByRole("link")).toHaveText(["Configurações"]);
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

    // the top of the sidebar: the mark and "Polaris"; the header: the menu of the store, with its initials and name,
    // that holds the e-mail, the theme, Ajuda, the legal pages and "Sair"; the sidebar has nothing of the account
    await expect(
      page.getByRole("link", { exact: true, name: "Polaris" })
    ).toBeVisible();
    // the name of the button starts with what the menu holds and ends with the store, its visible label
    await expect(storeMenu(page)).toHaveAccessibleName(
      "Loja, conta e ajuda: Loja do teste"
    );
    await expect(storeMenu(page).locator("[data-initials]")).toHaveAttribute(
      "data-initials",
      "LT"
    );
    await expect(storeMenu(page)).toContainText("Loja do teste");
    await expect(page.locator('[data-slot="sidebar"]')).not.toContainText(
      EMAIL
    );
    await expect(
      page.getByRole("button", { exact: true, name: "Sair" })
    ).toHaveCount(0);
    await storeMenu(page).click();
    const menu = page.getByRole("menu");
    await expect(identity(page)).toContainText("Loja do teste");
    await expect(
      identity(page).getByText(EMAIL, { exact: true })
    ).toBeVisible();
    await expect(menu.getByRole("menuitemradio")).toHaveText([
      "Automático",
      "Claro",
      "Escuro",
    ]);
    // one store: nothing to switch to; "Sair" is the last item, with its own separator before it
    await expect(menu.getByRole("menuitem")).toHaveText([
      "Ajuda e contato",
      "Termos de Uso (abre em outra aba)",
      "Política de Privacidade (abre em outra aba)",
      "Sair",
    ]);
    await expect(menu.getByRole("separator")).toHaveCount(3);
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(storeMenu(page)).toBeFocused();

    // the chip is in the header, at its right, before "?" and the menu of the store
    await expect(chip(page)).toContainText("Tudo sincronizado", {
      timeout: 20_000,
    });
    const header = page.locator("[data-app-header]");
    await expect(header.locator(".sync-status")).toHaveCount(1);
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

  test("com duas lojas, o menu da loja troca a loja, separado do tema e do Sair", async ({
    page,
  }) => {
    await serve(page, [...ORGANIZATIONS, SECOND_ORGANIZATION]);
    await page.goto("/products");
    await expect(storeMenu(page)).toContainText("Loja do teste");
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
    // the stores, the theme, the links and "Sair": four separators, "Sair" last
    await expect(menu.getByRole("separator")).toHaveCount(4);
    await expect(menu.getByRole("menuitem").last()).toHaveText("Sair");
    await stores.getByRole("menuitemradio", { name: "Loja da filial" }).click();
    await expect(storeMenu(page)).toContainText("Loja da filial");
    // the choice is the one kept for the next visit
    await page.reload();
    await expect(storeMenu(page)).toContainText("Loja da filial");
  });

  test("só com o e-mail (a leitura das lojas falhou), o menu da loja e o Sair continuam lá", async ({
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
    await expect(storeMenu(page)).toContainText(EMAIL);
    await storeMenu(page).click();
    await expect(
      page.getByRole("menuitem", { exact: true, name: "Sair" })
    ).toBeVisible();
  });

  test("o tema escolhido no menu da loja troca a classe do <html> e a cor da barra do navegador", async ({
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

  test("Sair no menu da loja encerra a sessão e vai para o início", async ({
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
    ).toHaveText([
      "Produtos",
      "Clientes",
      "Resultado",
      "Despesas",
      "Configurações",
      "Ajuda e contato",
    ]);
    // the bottom bar is not regrouped: what is left of Gestão keeps its label, Vendas has nothing left here
    await expect(panel.locator('[data-sidebar="group-label"]')).toHaveText([
      "Gestão",
      "Resultado",
    ]);
    const current = panel.locator('[aria-current="page"]');
    await expect(current).toHaveText("Produtos");
    // only navigation: the store, the theme and "Sair" are in the menu of the header; the legal pages at its foot
    await expect(
      panel.getByRole("button", { exact: true, name: "Sair" })
    ).toHaveCount(0);
    await expect(panel.getByRole("radiogroup")).toHaveCount(0);
    await expect(panel).not.toContainText(EMAIL);
    await expect(
      panel.locator("[data-sheet-legal]").getByRole("link")
    ).toHaveText(["Termos de Uso", "Política de Privacidade"]);
    await panel.getByRole("link", { name: "Clientes" }).click();
    await page.waitForURL("**/customers");
    await expect(bar.locator('[aria-current="true"]')).toHaveText("Estoque");

    // a screen of no destination of the bar marks Mais: Resultado, Despesas and Configurações, with their tabs
    for (const path of [
      "/dashboard",
      "/dashboard?aba=metas",
      "/expenses",
      "/configuracoes",
      "/configuracoes?aba=catalogo-publico",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one page at a time
      await page.goto(path);
      await expect(bar.locator("[aria-current]")).toHaveCount(0);
      await expect(more(page).locator("[data-bottom-mark]")).toHaveCount(1);
    }
  });

  test("Mais › Despesas são dois toques, e a tela marca Mais na barra", async ({
    page,
  }) => {
    await serve(page);
    await page.goto("/dashboard");
    let taps = 0;
    await more(page).click();
    taps += 1;
    const panel = page.getByRole("dialog", { name: "Mais" });
    await panel.getByRole("link", { exact: true, name: "Despesas" }).click();
    taps += 1;
    await page.waitForURL("**/expenses");
    expect(taps).toBe(2);
    await expect(
      page.getByRole("heading", { level: 1, name: "Despesas" })
    ).toBeVisible();
    await expect(bottomBar(page).locator("[aria-current]")).toHaveCount(0);
    await expect(more(page).locator("[data-bottom-mark]")).toHaveCount(1);
    await more(page).click();
    await expect(panel.locator('[aria-current="page"]')).toHaveText("Despesas");
  });

  test("o menu da loja do cabeçalho cabe na tela, mostra a loja e o e-mail inteiros e troca a loja", async ({
    page,
  }) => {
    const long = {
      ...SECOND_ORGANIZATION,
      id: "0199c2d0-0000-7000-8000-00000000a003",
      name: "Loja do centro da cidade com um nome bem comprido para quebrar linha no menu",
    };
    await serve(page, [long, ...ORGANIZATIONS, SECOND_ORGANIZATION]);
    await page.goto("/products");
    await storeMenu(page).click();
    // a click only lands if nothing covers the option: Playwright checks what is hit
    const option = page.getByRole("menuitemradio", {
      exact: true,
      name: "Loja do teste",
    });
    await expect(option).toBeVisible();
    const menu = await page.getByRole("menu").boundingBox();
    expect(menu?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((menu?.x ?? 0) + (menu?.width ?? 0)).toBeLessThanOrEqual(360);
    // the name of the store wraps, never cut; the e-mail is whole
    await expect(identity(page)).toContainText(long.name);
    await expect(
      identity(page).getByText(EMAIL, { exact: true })
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(option).toBeHidden();
    await expect(storeMenu(page)).toBeFocused();
    await storeMenu(page).click();
    await option.click();
    // a radio item keeps the menu open
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await storeMenu(page).click();
    await expect(identity(page)).toContainText("Loja do teste");
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

  test("Sair no menu da loja do cabeçalho encerra a sessão, em 2 toques", async ({
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

/* -------------------------------------------------------------------------- */
/* The eight destinations, the tabs, the old addresses, Pendências and the folding column                           */
/* -------------------------------------------------------------------------- */

const pathOf = (page: Page) => {
  const url = new URL(page.url());
  return `${url.pathname}${url.search}`;
};

/** The text of the Pendências link: its name and the drawn count (its accessible name says the count in words). */
const PENDENCIAS_WITH_COUNT = "Pendências1";

const tabList = (page: Page, name: string) =>
  page.getByRole("tablist", { exact: true, name });

test.describe("os 9 destinos e as abas (1280 px)", () => {
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
      ["Despesas", "/expenses"],
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
      label: "Resultado e metas",
      path: "/dashboard",
      tabs: [
        ["Resultado", "/dashboard"],
        ["Metas", "/dashboard?aba=metas"],
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
        ["Seus dados", "/configuracoes?aba=seus-dados"],
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
    await expect(chip(page).locator(".sync-status-short")).toHaveAttribute(
      "title",
      NEEDS_INTERNET_TITLE
    );
    await list.getByRole("tab", { exact: true, name: "Produtos" }).click();
    await expect(strip).toHaveCount(0);
    await expect(chip(page).locator(".sync-status-short")).not.toHaveAttribute(
      "title",
      NEEDS_INTERNET_TITLE
    );
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

  test("Despesas: o segmento vem do endereço (?ver=), o inválido cai em Lançamentos no lugar e trocar de segmento reescreve sem passo", async ({
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
      await page.goto(`/expenses?ver=${ver}`);
      await expect(
        segments.getByRole("tab", { exact: true, name: segment })
      ).toHaveAttribute("aria-selected", "true");
    }

    await page.goto("/expenses?ver=xyz");
    const steps = await page.evaluate(() => history.length);
    await expect.poll(() => pathOf(page)).toBe("/expenses");
    await expect(
      segments.getByRole("tab", { exact: true, name: "Lançamentos" })
    ).toHaveAttribute("aria-selected", "true");
    expect(await page.evaluate(() => history.length)).toBe(steps);

    await segments
      .getByRole("tab", { exact: true, name: "Recorrentes" })
      .click();
    await expect.poll(() => pathOf(page)).toBe("/expenses?ver=recorrentes");
    expect(await page.evaluate(() => history.length)).toBe(steps);
  });

  test("o endereço da aba Despesas que saiu do Resultado abre a tela de Despesas no lugar, sem carga nova, e ?aba=metas segue em Metas", async ({
    page,
  }) => {
    await serve(page);
    const loads: string[] = [];
    page.on("request", (request) => {
      if (request.isNavigationRequest()) {
        loads.push(new URL(request.url()).pathname);
      }
    });
    for (const [old, address] of [
      ["/dashboard?aba=despesas", "/expenses"],
      ["/dashboard?aba=despesas&ver=categorias", "/expenses?ver=categorias"],
      ["/dashboard?ver=recorrentes&aba=despesas", "/expenses?ver=recorrentes"],
    ] as const) {
      loads.length = 0;
      // biome-ignore lint/performance/noAwaitInLoops: one address at a time
      await page.goto(old);
      await expect.poll(() => pathOf(page)).toBe(address);
      await expect(
        page.getByRole("heading", { level: 1, name: "Despesas" })
      ).toBeVisible();
      await expect(sidebar(page).locator('[aria-current="page"]')).toHaveText(
        "Despesas"
      );
      // the one load is the one of the address typed: the rewrite to /expenses asked the network for nothing
      expect(loads).toEqual(["/dashboard"]);
    }
    await page.goto("/dashboard?aba=metas");
    await expect(
      tabList(page, "Resultado e metas").getByRole("tab", {
        exact: true,
        name: "Metas",
      })
    ).toHaveAttribute("aria-selected", "true");
    await expect.poll(() => pathOf(page)).toBe("/dashboard?aba=metas");
  });

  test("Despesas é um destino: marca o item atual, o Resultado leva a ela e o chip diz que a tela precisa de internet", async ({
    context,
    page,
  }) => {
    await serve(page);
    await page.goto("/dashboard");
    await page
      .getByRole("link", { exact: true, name: "Despesas do período" })
      .click();
    await expect.poll(() => pathOf(page)).toBe("/expenses");
    const current = sidebar(page).locator('[aria-current="page"]');
    await expect(current).toHaveCount(1);
    await expect(current).toHaveText("Despesas");
    await expect(current).toHaveAttribute("href", "/expenses");
    // the Resultado has no Despesas tab any more
    await expect(page.getByRole("tab", { name: "Despesas" })).toHaveCount(0);
    await expect(chip(page)).toContainText("Tudo sincronizado", {
      timeout: 20_000,
    });
    await context.setOffline(true);
    await expect(chip(page).locator(".sync-status-short")).toHaveAttribute(
      "title",
      NEEDS_INTERNET_TITLE
    );
  });

  test("quem não pode registrar despesa não tem o item Despesas nem o link do Resultado; o endereço abre a tela como sempre", async ({
    page,
  }) => {
    await serve(
      page,
      ORGANIZATIONS.map((organization) => ({
        ...organization,
        role: "cashier",
      }))
    );
    await page.goto("/dashboard");
    await expect(
      sidebar(page).getByRole("link", { name: "Resultado" })
    ).toBeVisible();
    await expect(sidebar(page).getByRole("link")).toHaveText(
      DESTINATIONS.filter((label) => label !== "Despesas")
    );
    await expect(
      page.getByRole("link", { exact: true, name: "Despesas do período" })
    ).toHaveCount(0);
    await page.goto("/dashboard?aba=despesas");
    await expect.poll(() => pathOf(page)).toBe("/expenses");
    await expect(
      page.getByRole("heading", { level: 1, name: "Despesas" })
    ).toBeVisible();
    await expect(sidebar(page).locator('[aria-current="page"]')).toHaveCount(0);
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
    // folded, the column has no help nor legal link, and the header does not change
    await expect(
      page.locator('[data-slot="sidebar"]').getByRole("link", { name: "Ajuda" })
    ).toHaveCount(0);
    await expect(page.getByRole("contentinfo")).toHaveCount(0);
    await expect(page.locator("[data-header-help]")).toBeVisible();
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
        "Despesas",
        "Configurações",
        "Ajuda e contato",
      ]);
      // "Sair" is in the menu of the header, not in "Mais"
      await expect(
        panel.getByRole("button", { exact: true, name: "Sair" })
      ).toHaveCount(0);
      // no folding on the phone
      await expect(
        page.getByRole("button", { name: "Recolher menu" })
      ).toHaveCount(0);
    });
  }
});

test.describe("pé do menu: primeiros passos e teste grátis", () => {
  const STEPS_NAME = "Primeiros passos, 2 de 3 concluídos";
  const TRIAL_NAME =
    "Teste grátis, primeira cobrança em 10/11, abrir Assinatura";

  const stepsLink = (page: Page) =>
    page.getByRole("link", { exact: true, name: STEPS_NAME });
  const trialLink = (page: Page) =>
    page.getByRole("link", { exact: true, name: TRIAL_NAME });

  test("1280 px: os dois itens no pé da lateral, cada um levando ao seu lugar", async ({
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
    // out of the destinations, at the foot, in order: steps, then trial, and nothing after them
    await expect(
      sidebar(page).getByRole("link", { name: "Primeiros passos" })
    ).toHaveCount(0);
    const steps = await stepsLink(page).boundingBox();
    const trial = await trialLink(page).boundingBox();
    expect(steps?.y ?? 0).toBeLessThan(trial?.y ?? 0);
    await expect(
      page.locator('[data-sidebar="footer"]').getByRole("link")
    ).toHaveCount(2);
    // two lines each, taller than a destination (32 px) and not cut by it
    expect(steps?.height ?? 0).toBeGreaterThan(40);
    expect(trial?.height ?? 0).toBeGreaterThan(48);
    for (const link of [stepsLink(page), trialLink(page)]) {
      // biome-ignore lint/performance/noAwaitInLoops: one link at a time
      const cut = await link.evaluate(
        (element) => element.scrollHeight > element.clientHeight
      );
      expect(cut).toBe(false);
    }
    expect(reads.plan).toBe(1);
    await trialLink(page).click();
    await page.waitForURL("**/configuracoes?aba=assinatura");
    await expect(trialLink(page)).toBeVisible();
    // the Assinatura shows nothing of the plan offline (AS-8): the foot of its menu neither
    await page.context().setOffline(true);
    await expect(trialLink(page)).toHaveCount(0);
    await page.context().setOffline(false);
    await expect(trialLink(page)).toBeVisible();
  });

  test("sem billing:manage (papel sem a permissão), nada da assinatura aparece nem é lido, nem em Mais", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    const reads = await serveFoot(page, { role: "cashier" });
    await page.goto("/products");
    // the steps are not of the billing: they stay
    await expect(stepsLink(page)).toBeVisible();
    await page.waitForLoadState("networkidle");
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
    // the store is loaded (the menu of the header has its name) and the network is quiet: only then is the
    // absence worth something
    await expect(storeMenu(page)).toContainText("Loja do teste");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("[data-menu-progress]")).toHaveCount(0);
    await expect(page.getByText("Teste grátis")).toHaveCount(0);
    expect(reads.plan).toBe(0);
  });

  test("sem passos lidos (a loja já vendeu) e fora do teste: o pé da lateral fica vazio", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await serveFoot(page, { steps: null });
    const reads = { active: 0 };
    await page.route("**/rpc/billing/readPlan", (route) => {
      reads.active += 1;
      return route.fulfill(
        json({ ...TRIAL_PLAN, nextCharge: null, state: "active" })
      );
    });
    await page.goto("/products");
    // the plan was read and answered: only then is the absence of the trial worth something
    await expect.poll(() => reads.active).toBe(1);
    // the store is loaded (the menu of the header has its name) and the network is quiet: only then is the
    // absence worth something
    await expect(storeMenu(page)).toContainText("Loja do teste");
    await page.waitForLoadState("networkidle");
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

  test("AC-4.3: no pior caso (Pendências, primeiros passos e teste grátis), Mais cabe em 360×720 sem rolar; a 360×640 só a lista rola por dentro", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 720, width: 360 });
    await serveFoot(page, {});
    await leaveOneRefused(page);
    await page.goto("/products");
    await expect(bottomBar(page)).toBeVisible();
    await more(page).click();
    const panel = page.getByRole("dialog", { name: "Mais" });
    await expect(
      panel.getByRole("link", {
        exact: true,
        name: "Pendências, 1 registro recusado",
      })
    ).toBeVisible();
    await expect(
      panel.getByRole("link", { exact: true, name: STEPS_NAME })
    ).toBeVisible();
    await expect(
      panel.getByRole("link", { exact: true, name: TRIAL_NAME })
    ).toBeVisible();
    const scroller = panel.locator(":scope > div");
    await expect
      .poll(() =>
        scroller.evaluate((node) => node.scrollHeight <= node.clientHeight)
      )
      .toBe(true);
    // nor does the list of destinations scroll inside it: Ajuda e contato is whole
    const list = panel.locator('[data-sidebar="content"]');
    expect(
      await list.evaluate((node) => node.scrollHeight <= node.clientHeight)
    ).toBe(true);
    // the last line of the sheet, the legal pages, is on the screen
    await expect(panel.locator("[data-sheet-legal]")).toBeInViewport({
      ratio: 1,
    });

    // 80 px shorter: the sheet still does not scroll as a whole, the footer stays and the list scrolls to Ajuda e contato
    await page.setViewportSize({ height: 640, width: 360 });
    await expect
      .poll(() =>
        scroller.evaluate((node) => node.scrollHeight <= node.clientHeight)
      )
      .toBe(true);
    await expect(panel.locator("[data-sheet-legal]")).toBeInViewport({
      ratio: 1,
    });
    await panel
      .getByRole("link", { exact: true, name: "Ajuda e contato" })
      .scrollIntoViewIfNeeded();
    await expect(
      panel.getByRole("link", { exact: true, name: "Ajuda e contato" })
    ).toBeInViewport({ ratio: 1 });
  });

  test("360 px: as duas linhas ficam em Mais, antes dos links legais", async ({
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
    const legal = panel.locator("[data-sheet-legal]");
    const stepsBox = await steps.boundingBox();
    const trialBox = await trial.boundingBox();
    const legalBox = await legal.boundingBox();
    expect(stepsBox?.y ?? 0).toBeLessThan(trialBox?.y ?? 0);
    expect((trialBox?.y ?? 0) + (trialBox?.height ?? 0)).toBeLessThanOrEqual(
      legalBox?.y ?? 0
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

const DPO_LINK = /^Escrever ao encarregado de dados: /;
const MAILTO = /^mailto:.+@.+/;

const helpLink = (page: Page) =>
  page.getByRole("link", { exact: true, name: "Ajuda e contato" });

async function expectHelpPage(page: Page) {
  await expect.poll(() => pathOf(page)).toBe("/ajuda");
  await expect(
    page.getByRole("heading", {
      exact: true,
      level: 1,
      name: "Ajuda e contato",
    })
  ).toBeVisible();
  await expect(page).toHaveTitle("Ajuda e contato · Polaris");
  const support = page.getByRole("link", {
    name: `Escrever para o suporte: ${SUPPORT_ADDRESS}`,
  });
  await expect(support).toHaveText(SUPPORT_ADDRESS);
  await expect(support).toHaveAttribute("href", `mailto:${SUPPORT_ADDRESS}`);
  await expect(page.getByRole("link", { name: DPO_LINK })).toHaveAttribute(
    "href",
    MAILTO
  );
}

test.describe("Ajuda e contato", () => {
  test("no celular, Mais leva a Ajuda em 2 toques, e a página marca Mais", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await serve(page);
    await page.goto("/sales/history");
    let taps = 0;
    await more(page).click();
    taps += 1;
    const panel = page.getByRole("dialog", { name: "Mais" });
    // after the destinations (Configurações is the last of them), before the foot
    const links = panel
      .getByRole("navigation", { name: "Principal" })
      .getByRole("link");
    await expect(links.last()).toHaveText("Ajuda e contato");
    await expect(links.nth(-2)).toHaveText("Configurações");
    await panel
      .getByRole("link", { exact: true, name: "Ajuda e contato" })
      .click();
    taps += 1;
    expect(taps).toBe(2);
    await expectHelpPage(page);
    await expect(more(page).locator("[data-bottom-mark]")).toHaveCount(1);
    await more(page).click();
    await expect(
      page
        .getByRole("dialog", { name: "Mais" })
        .locator('[aria-current="page"]')
    ).toHaveText("Ajuda e contato");
  });

  test("no celular, a linha do Mais é um item comum como os destinos, e a página não rola de lado", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await serve(page);
    await page.goto("/ajuda");
    await expectHelpPage(page);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true);
    const boxes = await Promise.all(
      [
        page.getByRole("link", {
          name: `Escrever para o suporte: ${SUPPORT_ADDRESS}`,
        }),
        page.getByRole("link", { name: DPO_LINK }),
      ].map((link) => link.boundingBox())
    );
    for (const box of boxes) {
      // the link is the text; its area of touch (`touch-hit`) reaches 44 px around it
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(20);
    }
    await more(page).click();
    const panel = page.getByRole("dialog", { name: "Mais" });
    const item = panel.getByRole("link", {
      exact: true,
      name: "Ajuda e contato",
    });
    const sibling = panel.getByRole("link", {
      exact: true,
      name: "Configurações",
    });
    // an ordinary item of the sheet, the same as the destinations above it (`SidebarMenuButton`); measured once the
    // sheet has settled: while it enters, the two boxes can differ by a fraction of a pixel
    const sizes = async () => {
      const [itemBox, siblingBox] = await Promise.all([
        item.boundingBox(),
        sibling.boundingBox(),
      ]);
      return {
        height: itemBox?.height === siblingBox?.height,
        tall: (itemBox?.height ?? 0) >= 32,
        width: itemBox?.width === siblingBox?.width,
      };
    };
    await expect.poll(sizes).toEqual({ height: true, tall: true, width: true });
  });

  test("no desktop, o ? do cabeçalho abre Ajuda em 1 toque, na lateral aberta e na recolhida", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await serve(page);
    await page.goto("/products");
    await expect(sidebar(page).getByRole("link")).toHaveText(DESTINATIONS);
    // the column has no help nor legal link: they are in the header
    await expect(
      page.locator('[data-slot="sidebar"]').getByRole("link", {
        name: "Ajuda e contato",
      })
    ).toHaveCount(0);
    const help = page.locator("[data-app-header]").getByRole("link", {
      exact: true,
      name: "Ajuda e contato",
    });
    const box = await help.boundingBox();
    expect(box?.width).toBe(40);
    expect(box?.height).toBe(40);
    await help.click();
    await expectHelpPage(page);
    await expect(help).toHaveAttribute("aria-current", "page");
    // no destination of the sidebar is marked on Ajuda
    await expect(sidebar(page).locator("[aria-current]")).toHaveCount(0);

    // folded: the same "?", and the column has no link of its own for it
    await page.keyboard.press("Control+b");
    await expect(helpLink(page)).toHaveCount(1);
    await expect(help).toBeVisible();
  });

  test("nenhuma página tem rodapé legal; no celular, Ajuda, Termos e Política ficam a 2 toques no menu da loja", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await serve(page);
    await page.goto("/customers");
    await expect(storeMenu(page)).toBeVisible();
    await expect(page.getByRole("contentinfo")).toHaveCount(0);
    await expect(
      page.getByRole("link", { exact: true, name: "Termos de Uso" })
    ).toHaveCount(0);
    await storeMenu(page).click();
    const menu = page.getByRole("menu");
    for (const [name, href] of [
      ["Termos de Uso (abre em outra aba)", "/termos"],
      ["Política de Privacidade (abre em outra aba)", "/privacidade"],
    ] as const) {
      const item = menu.getByRole("menuitem", { exact: true, name });
      // biome-ignore lint/performance/noAwaitInLoops: one link at a time
      await expect(item).toHaveAttribute("href", href);
      await expect(item).toHaveAttribute("target", "_blank");
      await expect(item).toHaveAttribute("rel", "noopener noreferrer");
    }
    await menu
      .getByRole("menuitem", { exact: true, name: "Ajuda e contato" })
      .click();
    await expectHelpPage(page);
  });

  test("a conta sem loja abre a Ajuda, e as outras páginas seguem pedindo a loja", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await serve(page, []);
    await page.goto("/ajuda");
    await expectHelpPage(page);
    await expect(
      page.getByRole("region", { name: "Dados pessoais" })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Abra a sua loja" })
    ).toHaveCount(0);
    await page.goto("/products");
    await expect(
      page.getByRole("heading", { name: "Abra a sua loja" })
    ).toBeVisible();
  });

  test("no primeiro acesso a conta aparece com o Sair, e Sair encerra a sessão", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    const state = await serve(page, []);
    // without the session the server refuses the read, as it does: the app then goes to the sign-in screen
    await page.route("**/rpc/organization/listMine", (route) =>
      state.signOutCalls > 0
        ? route.fulfill({
            ...json({ code: "UNAUTHORIZED", defined: false, status: 401 }),
            status: 401,
          })
        : route.fallback()
    );
    await page.goto("/");
    await expect(
      page.getByRole("heading", { level: 1, name: "Abra a sua loja" })
    ).toBeVisible();
    await expect(
      page.getByText(`Entrou como ${EMAIL}. Não é você?`)
    ).toBeVisible();
    const leave = page.getByRole("button", { exact: true, name: "Sair" });
    await expect(leave).toBeVisible();
    await leave.click();
    await expect.poll(() => state.signOutCalls).toBe(1);
    await expect(page).toHaveURL(ENTRAR);
    await expect(
      page.getByRole("heading", { level: 1, name: "Entrar" })
    ).toBeVisible();
  });

  test("no primeiro acesso com o runtime ligado, o Sair que falha mantém o aviso de dados apagados", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await serve(page, []);
    await page.route("**/api/auth/sign-out", (route) =>
      route.fulfill({
        body: "{}",
        contentType: "application/json",
        headers: { ...WORKER_MARK },
        status: 500,
      })
    );
    await page.goto("/");
    await page.getByRole("button", { exact: true, name: "Sair" }).click();
    await expect(page.getByRole("alert")).toHaveText(
      "Os dados deste aparelho foram apagados, mas não foi possível encerrar a sessão. Recarregue a página."
    );
    await expect(
      page.getByRole("heading", { level: 1, name: "Abra a sua loja" })
    ).toBeVisible();
  });

  test("com a leitura das lojas falhando, a Ajuda abre e as outras páginas mostram o erro", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
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
    await page.goto("/ajuda");
    await expectHelpPage(page);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.goto("/products");
    await expect(
      page.getByRole("heading", { name: "Não foi possível abrir o Polaris" })
    ).toBeVisible();
  });

  test("com a sessão acabada na leitura das lojas, a Ajuda abre e o aviso da sessão aparece", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await serve(page);
    await page.route("**/rpc/organization/listMine", (route) =>
      route.fulfill({
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
      })
    );
    await page.goto("/ajuda");
    await expectHelpPage(page);
    await expect(
      page.getByText("Sua sessão acabou. Entre de novo para continuar.")
    ).toBeVisible();
  });

  test("sem conexão, a página aberta segue inteira e os links de e-mail continuam lá", async ({
    context,
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await serve(page);
    await page.goto("/ajuda");
    await expectHelpPage(page);
    const requests: string[] = [];
    page.on("request", (request) =>
      requests.push(new URL(request.url()).pathname)
    );
    await context.setOffline(true);
    await expectHelpPage(page);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(
      page.getByText("O Polaris não tem chat nem telefone.", { exact: false })
    ).toBeVisible();
    // the page asks nothing of the server (AC-5): no form, no field, and nothing after it opened
    await expect(
      page.locator("main form, main input, main textarea")
    ).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(
      requests.filter(
        (path) => path.startsWith("/rpc/") && !path.startsWith("/rpc/sync/")
      )
    ).toEqual([]);
  });
});

test.describe("a altura mínima do conteúdo vem do cabeçalho", () => {
  test("no celular o conteúdo ocupa a janela entre o cabeçalho e a barra, e a página curta não rola", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await serve(page);
    await page.goto("/ajuda");
    await expectHelpPage(page);
    const header = await page.locator("[data-app-header]").boundingBox();
    expect(header?.height).toBe(48);
    const main = await page.locator("main#conteudo").evaluate((element) => ({
      minHeight: Number.parseFloat(getComputedStyle(element).minHeight),
    }));
    // the window minus the header (`--app-header`) and the 3.375 rem the bar reserves (`--app-bottom-bar`)
    expect(main.minHeight).toBeCloseTo(740 - 48 - 54, 0);
    // the panel of the content fills the window down to the bar
    const panel = await page.locator("[data-app-panel]").boundingBox();
    expect(panel?.height ?? 0).toBeGreaterThanOrEqual(740 - 48 - 54);
  });

  test("a 1280 px não há altura mínima e o cabeçalho tem 56 px", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await serve(page);
    await page.goto("/ajuda");
    await expectHelpPage(page);
    expect(
      await page
        .locator("main#conteudo")
        .evaluate((main) => getComputedStyle(main).minHeight)
    ).toBe("auto");
    expect(
      (await page.locator("[data-app-header]").boundingBox())?.height
    ).toBe(56);
  });
});
