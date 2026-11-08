/// <reference lib="dom" />

import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  EMAIL,
  leaveOneRefused,
  ORGANIZATION_ID,
  ORGANIZATIONS,
  SECOND_ORGANIZATION,
  serve,
  serveFoot,
} from "./shell-server";
import { WORKER_MARK } from "./worker-mark";

/** The button of the menu of the store in the header: what the menu holds, then the store. */
const STORE_MENU_NAME = /^Loja, conta e ajuda: /;

/**
 * The header of the shell and the frame around the content: one height in every state, nothing inside it that moves
 * or wraps, the menu of the store with the account, Ajuda, the legal pages and "Sair" two taps away, and no sideways
 * scroll on the page, the sidebar or "Mais" at any width, zoom, theme or text size.
 */

/** "Loja, conta e ajuda", then the store, the visible label of the button from 760 px. */
const storeMenu = (page: Page) =>
  page.getByRole("button", { name: STORE_MENU_NAME });
const header = (page: Page) => page.locator("[data-app-header]");
const chip = (page: Page) => page.locator(".sync-status");
const more = (page: Page) =>
  page.getByRole("button", { exact: true, name: "Mais" });

/** The height of the header at 100 % of the text: 48 px on the phone, 56 px from 760 px. */
const headerHeight = (width: number) => (width < 760 ? 48 : 56);

/**
 * Every short text the chip can show (`syncStatusLabel`), with three digits where a count goes: the width of the chip
 * is what changes between its states, never its height.
 */
const CHIP_TEXTS = [
  "Sincronizado",
  "Atualizando",
  "Enviando 999",
  "Offline",
  "Offline · 999",
  "Atenção: 999",
  "Ocupado",
  "Ocupado · 999",
  "Envio falhou",
  "Envio pausado",
  "Sem offline",
  "Sem acesso",
  "Conecte-se",
  "Preparando",
];

const LONG_STORE =
  "Loja de roupas, calçados e acessórios do centro da cidade de São José dos Campos";
const LONG_EMAIL =
  "atendimento.da.loja.de.roupas.do.centro.da.cidade@exemplo-de-dominio-comprido.com.br";

const rpcError = (route: Route, code: string, status: number, data?: unknown) =>
  route.fulfill({
    body: JSON.stringify({
      json: { code, data, defined: false, message: code, status },
      meta: [],
    }),
    contentType: "application/json",
    headers: { ...WORKER_MARK },
    status,
  });

interface Box {
  height: number;
  width: number;
  x: number;
  y: number;
}

/** Where the parts of the header are: the header itself, the chip, "?" and the button of the menu of the store. */
function measure(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) {
        return null;
      }
      const rect = element.getBoundingClientRect();
      return {
        height: rect.height,
        width: rect.width,
        x: rect.x,
        y: rect.y,
      };
    };
    return {
      brand: box('[data-app-header] a[href="/"]'),
      chip: box("[data-app-header] .sync-status"),
      header: box("[data-app-header]"),
      help: box("[data-header-help]"),
      menu: box("[data-store-menu]"),
      viewport: document.documentElement.clientWidth,
    };
  });
}

const right = (box: Box | null) => (box ? box.x + box.width : 0);

/** The places that must never scroll sideways: the page, the column of the sidebar and the sheet of "Mais". */
function sideScroll(page: Page, withDocument: boolean) {
  return page.evaluate((document_) => {
    const found: string[] = [];
    const check = (element: Element | null, name: string) => {
      if (element && element.scrollWidth > element.clientWidth) {
        found.push(`${name}: ${element.scrollWidth} > ${element.clientWidth}`);
      }
    };
    if (document_) {
      check(document.documentElement, "documento");
    }
    for (const [selector, name] of [
      ["[data-app-header] > div", "cabeçalho"],
      ['[data-slot="sidebar-inner"]', "lateral"],
      ["dialog[data-mobile] > div", "Mais"],
    ] as const) {
      const container = document.querySelector(selector);
      if (container && container.getClientRects().length > 0) {
        check(container, name);
        // the parts of the header are not containers: their 44 px areas of touch may pass their own box, inside
        // the padding of the header
        const parts =
          name === "cabeçalho" ? [] : Array.from(container.children);
        for (const child of parts) {
          check(
            child,
            `${name} > ${child.getAttribute("data-sidebar") ?? child.tagName}`
          );
        }
      }
    }
    return found;
  }, withDocument);
}

async function openShell(page: Page, path = "/products") {
  await page.goto(path);
  await expect(page.locator("main h1")).toBeVisible();
  await expect(chip(page)).toBeVisible({ timeout: 20_000 });
}

type Measured = Awaited<ReturnType<typeof measure>>;

/** One state of the chip against the first: same height, same places, on screen, left to right with no overlap. */
function expectSamePlaces(
  first: Measured,
  now: Measured,
  width: number,
  label: string
) {
  expect(now.header?.height, label).toBe(first.header?.height);
  // one line: the chip keeps its height, and it shrinks (an ellipsis) instead of pushing its neighbors
  expect(now.chip?.height, label).toBe(first.chip?.height);
  expect(
    Math.abs(right(now.chip) - right(first.chip)),
    label
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs((now.menu?.x ?? 0) - (first.menu?.x ?? 0)),
    label
  ).toBeLessThanOrEqual(1);
  const after = width >= 760 ? now.help : now.menu;
  if (width >= 760) {
    expect(
      Math.abs((now.help?.x ?? 0) - (first.help?.x ?? 0)),
      label
    ).toBeLessThanOrEqual(1);
  }
  expect(right(now.menu), label).toBeLessThanOrEqual(now.viewport);
  expect(now.chip?.x ?? -1, label).toBeGreaterThanOrEqual(0);
  if (now.brand && now.brand.width > 0) {
    expect(right(now.brand), label).toBeLessThanOrEqual(now.chip?.x ?? 0);
  }
  expect(right(now.chip), label).toBeLessThanOrEqual(after?.x ?? 0);
}

const setText = (page: Page, text: string) =>
  page.evaluate((value) => {
    const short = document.querySelector(
      "[data-app-header] .sync-status-short"
    );
    if (short) {
      short.textContent = value;
    }
  }, text);

test.describe("AC-1.1 e AC-1.2: a mesma altura e o mesmo lugar em todos os estados do chip", () => {
  for (const width of [320, 360, 1280]) {
    test(`${width} px: cada texto do chip, com 100 % e 200 % de texto`, async ({
      page,
    }) => {
      await page.setViewportSize({ height: 800, width });
      await serve(page);
      await openShell(page);
      for (const scale of ["100%", "200%"]) {
        // biome-ignore lint/performance/noAwaitInLoops: one size of the text at a time
        await page.evaluate((size) => {
          document.documentElement.style.fontSize = size;
        }, scale);
        // the column is as wide as 16 rem: it grows with the text, and the header waits for it
        await settled(page);
        const first = await measure(page);
        if (scale === "100%") {
          expect(first.header?.height).toBe(headerHeight(width));
        }
        for (const text of CHIP_TEXTS) {
          // biome-ignore lint/performance/noAwaitInLoops: one state at a time
          await setText(page, text);
          expectSamePlaces(
            first,
            await measure(page),
            width,
            `${width} px, texto ${scale}, chip "${text}"`
          );
        }
      }
    });
  }

  test("o chip encolhe com reticências a 320 px e a frase inteira fica no nome acessível", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 320 });
    await serve(page);
    await openShell(page);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    await setText(page, "Ocupado · 999");
    const clipped = await page
      .locator("[data-app-header] .sync-status-short")
      .evaluate((element) => ({
        ellipsis: getComputedStyle(element).textOverflow,
        wraps: getComputedStyle(element.parentElement as Element).whiteSpace,
      }));
    expect(clipped).toEqual({ ellipsis: "ellipsis", wraps: "nowrap" });
    await expect(header(page).locator(".sync-status .sr-only")).not.toBeEmpty();
  });

  test("1280 px: a dica vale sobre o ícone, o texto, o recheio e a borda, sem mudar o que o leitor de tela diz", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await serve(page);
    await openShell(page);
    const sentence = (await chip(page).locator(".sr-only").textContent()) ?? "";
    expect(sentence).not.toBe("");
    const box = await chip(page).boundingBox();
    expect(box).not.toBeNull();
    const { height, width, x, y } = box as NonNullable<typeof box>;
    const middle = y + height / 2;
    const points = {
      borda: [x + 0.5, middle],
      icone: [x + 12, middle],
      recheio: [x + width - 3, middle],
      texto: [x + width / 2, middle],
    } as const;
    for (const [where, [left, top]] of Object.entries(points)) {
      // biome-ignore lint/performance/noAwaitInLoops: one point at a time
      const tip = await page.evaluate(
        ([pointX, pointY]) => {
          const hit = document.elementFromPoint(pointX, pointY);
          return {
            inside: Boolean(hit?.closest(".sync-status")),
            title: hit?.closest("[title]")?.getAttribute("title") ?? null,
          };
        },
        [left, top]
      );
      expect(tip, where).toEqual({ inside: true, title: sentence });
    }
    for (const attribute of ["title", "aria-label", "aria-describedby"]) {
      // biome-ignore lint/performance/noAwaitInLoops: one attribute at a time
      expect(await chip(page).getAttribute(attribute), attribute).toBeNull();
    }
    const session = await page.context().newCDPSession(page);
    const { nodes } = await session.send("Accessibility.getFullAXTree");
    const spoken = nodes.filter(
      (node) =>
        node.name?.value === sentence || node.description?.value === sentence
    );
    expect(
      spoken.filter((node) => node.description?.value === sentence)
    ).toEqual([]);
    expect(
      spoken.filter((node) => node.name?.value === sentence)
    ).not.toHaveLength(0);
  });
});

/** The states of the shell that are not the chip's: none of them changes the height of the header. */
test.describe("AC-1.1, AC-1.4 e AC-2.2: a altura do cabeçalho nos estados da casca", () => {
  for (const width of [320, 360, 1280]) {
    test(`${width} px: carregando, erro, sessão acabada, aceite pendente, nomes longos, menu e Mais abertos, sem conexão`, async ({
      page,
    }) => {
      await page.setViewportSize({ height: 740, width });
      const expected = headerHeight(width);
      const heights: Record<string, number | undefined> = {};
      const read = async (state: string) => {
        heights[state] = (await header(page).boundingBox())?.height;
      };

      await page.unrouteAll({ behavior: "ignoreErrors" });
      await serve(page);
      await page.route("**/rpc/organization/listMine", (route) =>
        rpcError(route, "INTERNAL_SERVER_ERROR", 500)
      );
      await page.goto("/products");
      await expect(
        page.getByRole("heading", { name: "Não foi possível abrir o Polaris" })
      ).toBeVisible();
      await read("erro de carregamento");

      await page.route("**/rpc/organization/listMine", (route) =>
        rpcError(route, "UNAUTHORIZED", 401)
      );
      await page.goto("/ajuda");
      await expect(
        page.getByText("Sua sessão acabou. Entre de novo para continuar.")
      ).toBeVisible();
      await read("sessão encerrada");

      await page.route("**/rpc/organization/listMine", (route) =>
        rpcError(route, "FORBIDDEN", 403, {
          pending: [
            { document: "terms", version: 1 },
            { document: "privacy", version: 1 },
          ],
          reason: "legal_acceptance_required",
        })
      );
      await page.goto("/ajuda");
      await expect(page.getByText("Ler e aceitar")).toBeVisible();
      await read("aceite pendente");
      // the first frame: the store is still being read, and the header already has its height
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await serve(page);
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route("**/rpc/organization/listMine", async (route) => {
        await held;
        await route.fallback();
      });
      await page.goto("/products");
      await expect(page.getByText("Carregando sua loja…")).toBeVisible();
      await read("carregando a loja");
      release();
      await expect(storeMenu(page)).toHaveAccessibleName(
        "Loja, conta e ajuda: Loja do teste"
      );

      await page.unrouteAll({ behavior: "ignoreErrors" });
      await serve(page, [
        { ...SECOND_ORGANIZATION, id: ORGANIZATION_ID, name: LONG_STORE },
        SECOND_ORGANIZATION,
      ]);
      await page.route("**/api/auth/get-session", (route) =>
        route.fulfill({
          body: JSON.stringify({ user: { email: LONG_EMAIL, id: "u" } }),
          contentType: "application/json",
          headers: { ...WORKER_MARK },
        })
      );
      await page.goto("/products");
      await expect(storeMenu(page)).toContainText("Loja de roupas");
      await read("nome de loja e e-mail longos");
      await storeMenu(page).click();
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      // the whole name and e-mail, wrapped and never cut, inside the screen
      const identity = page.locator("[data-store-identity]");
      await expect(identity).toContainText(LONG_STORE);
      await expect(identity).toContainText(LONG_EMAIL);
      expect(
        await identity.evaluate(
          (element) => element.scrollWidth <= element.clientWidth
        )
      ).toBe(true);
      const menuBox = await menu.boundingBox();
      expect(menuBox?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((menuBox?.x ?? 0) + (menuBox?.width ?? 0)).toBeLessThanOrEqual(
        width
      );
      await read("menu da loja aberto");
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      if (width < 760) {
        await more(page).click();
        await expect(page.getByRole("dialog", { name: "Mais" })).toBeVisible();
        await read("Mais aberta");
        await page.keyboard.press("Escape");
      }
      await page.context().setOffline(true);
      await expect(chip(page)).toContainText("Offline");
      await read("sem conexão");
      await page.context().setOffline(false);

      expect(heights).toEqual(
        Object.fromEntries(Object.keys(heights).map((key) => [key, expected]))
      );
    });
  }

  test("o menu aberto não empurra a página nem muda o cabeçalho", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await serve(page);
    await openShell(page);
    // where the page starts and the header ends (the content may still grow below, as it reads)
    const places = async () => {
      const main = await page.locator("main#conteudo").boundingBox();
      const top = await header(page).boundingBox();
      return { header: top?.height, mainX: main?.x, mainY: main?.y };
    };
    const before = await places();
    await storeMenu(page).click();
    await expect(page.getByRole("menu")).toBeVisible();
    expect(await places()).toEqual(before);
  });
});

/** The first tap opens the menu of the store; the second reaches any of the four; from 760 px, "?" is one tap. */
async function expectTwoTaps(page: Page, width: number, label: string) {
  await storeMenu(page).click();
  const menu = page.getByRole("menu");
  const items = menu.getByRole("menuitem");
  await expect(items, label).toHaveText([
    "Ajuda e contato",
    "Termos de Uso (abre em outra aba)",
    "Política de Privacidade (abre em outra aba)",
    "Sair",
  ]);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  if (width >= 760) {
    await expect(
      header(page).getByRole("link", { exact: true, name: "Ajuda e contato" }),
      label
    ).toBeVisible();
  }
}

test.describe("AC-2.1: Sair, Ajuda, Termos e Política a 2 toques em toda rota da casca", () => {
  const ROUTES = [
    "/",
    "/sales",
    "/sales/history",
    "/inventory",
    "/products",
    "/customers",
    "/dashboard",
    "/configuracoes",
    "/configuracoes?aba=aparelhos",
    "/attention",
    "/ajuda",
    "/uma-pagina-que-nao-existe",
  ];
  for (const width of [360, 1280]) {
    test(`${width} px, com e sem conexão`, async ({ page }) => {
      await page.setViewportSize({ height: 800, width });
      await serve(page);
      for (const path of ROUTES) {
        // biome-ignore lint/performance/noAwaitInLoops: one page at a time
        await page.goto(path);
        await expect(storeMenu(page)).toBeVisible();
        for (const offline of [false, true]) {
          // biome-ignore lint/performance/noAwaitInLoops: online, then offline
          await page.context().setOffline(offline);
          await expectTwoTaps(
            page,
            width,
            `${path} a ${width} px${offline ? ", sem conexão" : ""}`
          );
        }
        await page.context().setOffline(false);
      }
    });
  }
});

test.describe("AC-2.3: teclado, foco e alvos", () => {
  test("o menu abre pelo teclado, Esc fecha e devolve o foco; alvos de 44 px no toque, círculo de 32 px", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await serve(page);
    await openShell(page);
    await storeMenu(page).focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitemradio").first()).toBeFocused();
    await settled(page);
    for (const item of await menu
      .locator('[role="menuitem"], [role="menuitemradio"]')
      .all()) {
      // biome-ignore lint/performance/noAwaitInLoops: one item at a time
      expect((await item.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
        44
      );
    }
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(storeMenu(page)).toBeFocused();
    const circle = await storeMenu(page).locator("span").first().boundingBox();
    expect([circle?.width, circle?.height]).toEqual([32, 32]);
    // the area of touch around the circle reaches 44 px
    const area = await storeMenu(page).evaluate((element) => {
      const before = getComputedStyle(element, "::before");
      return before.content === "none"
        ? 0
        : element.getBoundingClientRect().height -
            2 * Number.parseFloat(before.top);
    });
    expect(area).toBeGreaterThanOrEqual(44);
  });

  test("AC-4.5: o foco ao rolar fica abaixo do cabeçalho e Ir para o conteúdo é o primeiro alvo", async ({
    page,
  }) => {
    for (const [width, height] of [
      [360, 48],
      [1280, 56],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: one width at a time
      await page.setViewportSize({ height: 740, width });
      await serve(page);
      await openShell(page);
      expect(
        await page.evaluate(
          () => getComputedStyle(document.documentElement).scrollPaddingTop
        )
      ).toBe(`${height}px`);
      await page.keyboard.press("Tab");
      await expect(
        page.getByRole("link", { exact: true, name: "Ir para o conteúdo" })
      ).toBeFocused();
    }
  });
});

/** The page as it is, with the zoom of the browser at 200 %, and with the text of the browser at 200 %. */
const CONDITIONS = [
  { text: "100%", zoom: 1 },
  { text: "100%", zoom: 2 },
  { text: "200%", zoom: 1 },
] as const;

/**
 * The one state where the screen itself has no room: from 760 px the open column is 16 rem, so with the text at 200 %
 * it takes 512 of 768 px and leaves 256 px to the content of the page, whose words are wider than that. The header,
 * the column and "Mais" are still checked there; only the document is not.
 */
const NARROW_CONTENT = new Set([
  "/ajuda, 768 px, zoom 100 %, texto 200%, lateral aberta",
]);

/** Waits for what is moving (the column that folds, the sheet that enters or leaves) to end before measuring. */
const settled = (page: Page) =>
  page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .map((animation) => animation.finished.catch(() => undefined))
    )
  );

/** At one width: the page, then "Mais" open below 760 px; the column open, then folded from 1024 px. */
async function lookEveryState(
  page: Page,
  cssWidth: number,
  state: string,
  found: string[]
) {
  const look = async (name: string) => {
    await settled(page);
    for (const line of await sideScroll(page, !NARROW_CONTENT.has(name))) {
      found.push(`${name}: ${line}`);
    }
  };
  if (cssWidth < 760) {
    await look(state);
    await more(page).click();
    const sheet = page.getByRole("dialog", { name: "Mais" });
    await expect(sheet).toBeVisible();
    await look(`${state}, Mais aberta`);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    return;
  }
  await look(`${state}, lateral aberta`);
  if (cssWidth < 1024) {
    return;
  }
  const collapse = page.getByRole("button", {
    exact: true,
    name: "Recolher menu",
  });
  await collapse.click();
  await expect(
    page.locator('[data-slot="sidebar"][data-state="collapsed"]')
  ).toHaveCount(1);
  await look(`${state}, lateral recolhida`);
  await page
    .getByRole("button", { exact: true, name: "Expandir menu" })
    .click();
  await expect(collapse).toBeVisible();
}

/** Ajuda in every condition, and Produtos at the zoom, a screen whose own toolbar is not the shell's. */
const PAGES = [
  ["/ajuda", CONDITIONS],
  ["/products", CONDITIONS.filter((condition) => condition.text === "100%")],
] as const;

async function runConditions(
  page: Page,
  conditions: readonly (typeof CONDITIONS)[number][],
  prefix: string,
  found: string[]
) {
  for (const width of [360, 768, 1280, 1440]) {
    for (const { text, zoom } of conditions) {
      // the zoom of 200 % is the page laid out in half the CSS pixels, as the browser does; a phone has no such
      // zoom (pinching does not lay the page out again): its 200 % is the text
      if (zoom === 2 && width < 760) {
        continue;
      }
      const cssWidth = Math.round(width / zoom);
      // biome-ignore lint/performance/noAwaitInLoops: one state at a time
      await page.setViewportSize({
        height: Math.round(800 / zoom),
        width: cssWidth,
      });
      await page.evaluate((size) => {
        document.documentElement.style.fontSize = size;
      }, text);
      await lookEveryState(
        page,
        cssWidth,
        `${prefix}${width} px, zoom ${zoom * 100} %, texto ${text}`,
        found
      );
    }
  }
}

test.describe("AC-1.6: nenhuma rolagem de lado, na página, na lateral e em Mais", () => {
  for (const scheme of ["light", "dark"] as const) {
    test(`tema ${scheme === "light" ? "claro" : "escuro"}: 360, 768, 1280 e 1440 px, com zoom de 200 % e texto a 200 %, lateral aberta, recolhida e Mais aberta`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ height: 800, width: 1280 });
      // the worst case of the column and of "Mais": Pendências, Primeiros passos and Teste grátis all on
      await serveFoot(page, { name: LONG_STORE });
      await leaveOneRefused(page);
      const found: string[] = [];
      // Ajuda in every condition (its content is text that wraps: what is measured is the shell), and Produtos, a
      // screen with a toolbar and tabs, at the zoom
      for (const [path, conditions] of PAGES) {
        // biome-ignore lint/performance/noAwaitInLoops: one page at a time
        await page.setViewportSize({ height: 800, width: 1280 });
        await openShell(page, path);
        for (const attribute of ["data-menu-first-steps", "data-menu-trial"]) {
          // biome-ignore lint/performance/noAwaitInLoops: one item at a time
          await expect(page.locator(`[${attribute}]`)).toBeVisible();
        }
        await expect(
          page.getByRole("link", {
            exact: true,
            name: "Pendências, 1 registro recusado",
          })
        ).toBeVisible();
        await runConditions(page, conditions, `${path}, `, found);
      }
      expect(found).toEqual([]);
    });
  }

  test("a coluna recolhida de 3 rem: nenhum item passa da largura dela", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await serveFoot(page, {});
    await leaveOneRefused(page);
    await openShell(page);
    const inner = page.locator('[data-slot="sidebar-inner"]');
    // the three items that have the most to say are all there, so what is measured is the folded column in its worst case
    for (const name of [
      "Pendências, 1 registro recusado",
      "Primeiros passos, 2 de 3 concluídos",
      "Teste grátis, primeira cobrança em 10/11, abrir Assinatura",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one link at a time
      await expect(
        inner.getByRole("link", { exact: true, name })
      ).toBeVisible();
    }
    await page
      .getByRole("button", { exact: true, name: "Recolher menu" })
      .click();
    await expect.poll(async () => (await inner.boundingBox())?.width).toBe(48);
    const wider = await inner.evaluate((column) => {
      const edge = column.getBoundingClientRect().right;
      return Array.from(
        column.querySelectorAll("a, button:not([data-sidebar=rail])")
      )
        .filter((element) => element.getClientRects().length > 0)
        .filter((element) => element.getBoundingClientRect().right > edge + 0.5)
        .map((element) => element.textContent?.trim() || element.tagName);
    });
    expect(wider).toEqual([]);
    // no help nor legal link in the column, open or folded
    await expect(inner.getByRole("link", { name: "Ajuda" })).toHaveCount(0);
    await expect(inner.getByRole("link", { name: "Termos" })).toHaveCount(0);
  });
});

test.describe("AC-5: a moldura e o painel", () => {
  const colors = (page: Page) =>
    page.evaluate(() => {
      const style = (selector: string) => {
        const element = document.querySelector(selector);
        return element ? getComputedStyle(element) : null;
      };
      const panel = style("[data-app-panel]");
      return {
        bar: style("[data-bottom-bar]")?.backgroundColor ?? null,
        header: style("[data-app-header]")?.backgroundColor ?? null,
        panel: panel?.backgroundColor ?? null,
        panelOverflow: panel?.overflow ?? null,
        radius: panel?.borderTopLeftRadius ?? null,
        ring: panel
          ? [
              panel.borderTopWidth,
              panel.borderLeftWidth,
              panel.borderRightWidth,
            ]
          : null,
        sidebar: style('[data-slot="sidebar-inner"]')?.backgroundColor ?? null,
      };
    });

  for (const scheme of ["light", "dark"] as const) {
    test(`tema ${scheme === "light" ? "claro" : "escuro"}: a 1280 px, a lateral e o cabeçalho são uma cor, o painel tem o canto e o anel, aberta e recolhida; a 360 px, sem canto`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ height: 800, width: 1280 });
      await serve(page);
      await openShell(page);
      for (const folded of [false, true]) {
        if (folded) {
          // biome-ignore lint/performance/noAwaitInLoops: open, then folded
          await page
            .getByRole("button", { exact: true, name: "Recolher menu" })
            .click();
        }
        await expect(page.locator('[data-slot="sidebar"]')).toHaveAttribute(
          "data-state",
          folded ? "collapsed" : "expanded"
        );
        await settled(page);
        const frame = await colors(page);
        expect(frame.header).toBe(frame.sidebar);
        expect(frame.panel).not.toBe(frame.header);
        expect(frame.radius).toBe("14px");
        expect(frame.ring).toEqual(["1px", "1px", "0px"]);
        // nothing of the content is cut by the corner
        expect(frame.panelOverflow).toBe("visible");
        const panel = await page.locator("[data-app-panel]").boundingBox();
        const side = await page
          .locator('[data-slot="sidebar-inner"]')
          .boundingBox();
        const top = await header(page).boundingBox();
        // the panel meets the column and the header, with no strip between them
        expect(panel?.x).toBe((side?.x ?? 0) + (side?.width ?? 0));
        expect(panel?.y).toBe((top?.y ?? 0) + (top?.height ?? 0));
      }
      // the header has no blur and is opaque
      expect(
        await header(page).evaluate((element) => ({
          blur: getComputedStyle(element).backdropFilter,
        }))
      ).toEqual({ blur: "none" });

      await page.setViewportSize({ height: 740, width: 360 });
      await expect(more(page)).toBeVisible();
      const phone = await colors(page);
      expect(phone.header).toBe(phone.bar);
      expect(phone.panel).not.toBe(phone.header);
      expect(phone.radius).toBe("0px");
      expect(phone.ring).toEqual(["0px", "0px", "0px"]);
    });
  }
});

test.describe("AC-4: a folha Mais só com navegação", () => {
  test("a 360 px, os itens têm 44 px e a folha não tem a conta, o tema nem o Sair", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 640, width: 360 });
    await serve(page, [...ORGANIZATIONS, SECOND_ORGANIZATION]);
    await openShell(page);
    await more(page).click();
    const sheet = page.getByRole("dialog", { name: "Mais" });
    await expect(sheet).toBeVisible();
    const links = sheet
      .getByRole("navigation", { name: "Principal" })
      .getByRole("link");
    for (const link of await links.all()) {
      // biome-ignore lint/performance/noAwaitInLoops: one item at a time
      expect((await link.boundingBox())?.height).toBe(44);
    }
    await expect(sheet).not.toContainText(EMAIL);
    await expect(sheet.getByRole("combobox")).toHaveCount(0);
    await expect(sheet.getByRole("radiogroup")).toHaveCount(0);
    await expect(sheet.getByRole("button", { name: "Sair" })).toHaveCount(0);
    const legal = sheet.locator("[data-sheet-legal] a");
    await expect(legal).toHaveText([
      "Termos de Uso",
      "Política de Privacidade",
    ]);
    await expect(legal.first()).toHaveCSS("font-size", "12px");
    for (const link of await legal.all()) {
      // biome-ignore lint/performance/noAwaitInLoops: one link at a time
      await expect(link).toHaveAttribute("target", "_blank");
      await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
  });
});
