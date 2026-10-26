/// <reference lib="dom" />
import type { Browser, BrowserContextOptions, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  readMotion,
  runningMotion,
  startMotionRecorder,
} from "./ui-guardrails";
import { historyStates } from "./ui-history-states";
import { homeStates } from "./ui-home-states";
import { SCREENS } from "./ui-screens";

/**
 * The levels of motion on a phone (t386, ADR 0103 "Níveis de movimento", src/lib/motion-level.ts), in the project
 * `chromium-celular` of playwright.pwa.config.ts (Chromium, touch, 360×740), the only one that runs this file. Every
 * test starts by proving the page is a phone (`pointer: coarse` emulated and `data-motion="essential"`): a run whose
 * emulation gave a fine pointer would test the desktop thinking it is a phone, so it fails loudly instead.
 *
 * a) the filter bar never asks for the `motion` chunk and a pill goes at once, with no style of motion;
 * b) the chart is drawn finished on the first frame: no clip of the reveal, and the path and the y axis already at the
 *    final scale one frame after the change from 7 to 30 days;
 * c) the essential motion still runs (the pulse of the skeleton, the press of a button) and nothing else does;
 * d) control: the desktop and the tablet are `full`, the bar loads its layer and the pill animates;
 * e) with `prefers-reduced-motion` the level is `none`;
 * h) the form Dialog (t331) opens and closes at once on a phone, with no animation on the box or on the veil; on the
 *    desktop the same dialog animates;
 * g) the sales history, the first screen on the filter bar (t391), asks for neither the `motion` chunk nor the layer on
 *    a phone, and its pills go at once; on the desktop the same page loads the layer.
 */
const MOTION_CHUNK = /\/assets\/motion-[\w-]+\.js$/;
const CHARTS_CHUNK = /\/assets\/charts-[\w-]+\.js$/;
const LAYER_CHUNK = /\/assets\/filter-bar-motion-[\w-]+\.js$/;
const CLIENT_ITEM = /^Cliente/;
const CLIENT_PILL = /^Cliente: .*, editar$/;
const WEEK_LABEL =
  /^Vendas líquidas por dia, de 17\/10 a 23\/10, dados de exemplo$/;
/** What may move on a phone: the pulse of the skeleton (an animation) and the press of a button (a transition). */
const ESSENTIAL_NAMES = new Set(["pulse", "transform"]);

const PHONE: BrowserContextOptions = {
  hasTouch: true,
  isMobile: true,
  viewport: { height: 740, width: 360 },
};
const DESKTOP: BrowserContextOptions = {
  hasTouch: false,
  isMobile: false,
  viewport: { height: 800, width: 1280 },
};
const TABLET: BrowserContextOptions = {
  hasTouch: true,
  isMobile: true,
  viewport: { height: 1180, width: 820 },
};

const level = (page: Page) =>
  page.evaluate(() => document.documentElement.dataset.motion ?? "");

/** Fails loudly when the page is not a phone: a fine pointer would make every check below a desktop check. */
async function expectPhone(page: Page) {
  const coarse = await page.evaluate(
    () => matchMedia("(pointer: coarse)").matches
  );
  expect(
    coarse,
    "a emulação do celular não deu pointer: coarse; o teste mediria um desktop"
  ).toBe(true);
  expect(await level(page), "o celular é o nível essential").toBe("essential");
}

async function openGallery(page: Page) {
  await page.goto("/ui-galeria");
  await expect(
    page.getByRole("heading", { name: "Galeria da interface" })
  ).toBeVisible();
  await expect(bar(page)).toBeVisible();
}

const bar = (page: Page) =>
  page.getByRole("search", { exact: true, name: "Filtrar vendas" });

/** The requests of the page whose path matches, from now on. */
function watchRequests(page: Page, pattern: RegExp) {
  const seen: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (pattern.test(path)) {
      seen.push(path);
    }
  });
  return seen;
}

/** Clicks the X of the Cliente pill and says whether the pill is still in the page one frame later. */
const pillAfterOneFrame = (page: Page) =>
  page.evaluate(async () => {
    document
      .querySelector<HTMLButtonElement>('[aria-label="Tirar o filtro Cliente"]')
      ?.click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => setTimeout(resolve, 40));
    return document.querySelector('[aria-label^="Cliente: "]') !== null;
  });

/** Adds the Cliente pill back by the menu and returns the inline style of its frame. */
async function addedPillStyle(page: Page) {
  await bar(page).getByRole("button", { exact: true, name: "Filtrar" }).click();
  await page
    .getByRole("menu", { name: "Filtrar por" })
    .getByRole("menuitem", { name: CLIENT_ITEM })
    .click();
  return bar(page)
    .getByRole("button", { name: CLIENT_PILL })
    .evaluate(
      (element) =>
        element.closest('[data-slot="filter-pill"]')?.getAttribute("style") ??
        ""
    );
}

/**
 * The drawing of the area chart: its path and the labels of its axes with their place (the labels are HTML over the
 * drawing, and the y axis ones slide to a new scale with a transition of their own, which only the place shows).
 */
const drawing = (image: ReturnType<Page["getByRole"]>) =>
  image.evaluate((element) => {
    const root = element.closest("[data-chart]") ?? element;
    const { top } = root.getBoundingClientRect();
    return {
      path: element.querySelector("svg path[stroke]")?.getAttribute("d") ?? "",
      ticks: [...root.querySelectorAll(".text-chart-label")]
        .map(
          (label) =>
            `${label.textContent}@${Math.round(label.getBoundingClientRect().top - top)}`
        )
        .join("|"),
    };
  });

async function inContext(
  browser: Browser,
  options: BrowserContextOptions,
  run: (page: Page) => Promise<void>
) {
  const context = await browser.newContext(options);
  try {
    await run(await context.newPage());
  } finally {
    await context.close();
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(startMotionRecorder);
});

test("a) no celular a barra não pede o motion (a camada animada, o único caminho dela até ele, nunca vem) e a pílula sai e entra de uma vez, sem estilo de movimento", async ({
  browser,
}) => {
  // with no service worker the requests are the page's own: the precache downloads every file of the build, motion
  // included, on any device (that is the offline chart). The gallery's charts preload motion with their chunk when
  // they mount (`__vitePreload` of on-demand.tsx); the bar has no static way to it (the build guard
  // `motionLoadProblems`), so its only way is the layer, which must never be asked for, and touching the bar asks for
  // nothing more
  await inContext(
    browser,
    { ...PHONE, serviceWorkers: "block" },
    async (page) => {
      await page.route(CHARTS_CHUNK, (route) => route.abort());
      const layer = watchRequests(page, LAYER_CHUNK);
      await openGallery(page);
      await expectPhone(page);
      await page.waitForLoadState("networkidle");
      const motion = watchRequests(page, MOTION_CHUNK);
      expect(await pillAfterOneFrame(page)).toBe(false);
      expect(await addedPillStyle(page)).toBe("");
      await page.keyboard.press("Escape");
      await page.waitForLoadState("networkidle");
      expect(motion).toEqual([]);
      expect(layer).toEqual([]);
    }
  );
});

test("b) no celular o gráfico aparece pronto: sem o clip da revelação, e o caminho e o eixo Y já na escala final um quadro depois da troca de 7 para 30 dias", async ({
  page,
}) => {
  // the gallery: the area chart has no clip group (it exists only while the reveal runs)
  await page.goto("/ui-galeria");
  await expectPhone(page);
  const week = page
    .getByRole("region", { name: "Gráficos de área" })
    .getByRole("img", { name: WEEK_LABEL });
  await expect(week.locator("svg path[stroke]").first()).toBeVisible();
  await expect(week.locator("svg g[clip-path]")).toHaveCount(0);
  const first = await drawing(week);
  await page.waitForTimeout(1300);
  expect(await drawing(week)).toEqual(first);

  // the Início: 7 to 30 days changes the data of the same chart; the frame after the click is already the final one
  await homeStates.sold(page);
  await expectPhone(page);
  const chart = page.locator("[data-chart-area]").first();
  await expect(chart.locator("svg path[stroke]").first()).toBeVisible();
  await expect(chart.locator("svg g[clip-path]")).toHaveCount(0);
  const seven = await drawing(chart);
  await page.getByRole("tab", { name: "30 dias" }).click();
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(resolve))
  );
  const next = await drawing(chart);
  expect(next.path).not.toBe(seven.path);
  expect(next.ticks).toContain("R$ 2.000@");
  await page.waitForTimeout(1300);
  expect(await drawing(chart)).toEqual(next);
});

test("c) no celular o essencial continua (o pulso do Skeleton, o botão afundando no toque) e nada mais se move no Início com o painel Mais", async ({
  page,
}) => {
  await openGallery(page);
  await expectPhone(page);
  const pulse = await page
    .locator('[data-slot="skeleton"]')
    .first()
    .evaluate((element) =>
      element.getAnimations().map((animation) => ({
        duration: Number(animation.effect?.getComputedTiming().duration),
        name: (animation as CSSAnimation).animationName,
      }))
    );
  expect(pulse).toEqual([{ duration: 2000, name: "pulse" }]);
  // the press of a button: it sinks at once (`scale` 0.98 while pressed), with no transition of its colors
  const confirm = page
    .getByRole("region", { name: "Botões" })
    .getByRole("button", { name: "Confirmar venda" });
  const box = await confirm.boundingBox();
  expect(box).not.toBeNull();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    const pressed = await confirm.evaluate((element) => {
      const style = getComputedStyle(element);
      return { duration: style.transitionDuration, scale: style.scale };
    });
    await page.mouse.up();
    expect(pressed).toEqual({ duration: "0s", scale: "0.98" });
  }

  // the Início with sales, with the "Mais" panel opened and closed: whatever ran was essential
  const home = SCREENS.find((screen) => screen.name === "início com vendas");
  if (!home?.exercise) {
    throw new Error(
      "ui-screens.ts must list the Início with sales and its exercise"
    );
  }
  await home.open(page, page.context());
  await expectPhone(page);
  await home.exercise(page);
  const moved = runningMotion(await readMotion(page)).filter(
    (record) => !ESSENTIAL_NAMES.has(record.name)
  );
  expect(moved).toEqual([]);
});

test('d) no celular o painel "Mais" abre e fecha de uma vez, pelo caminho direto do reduce', async ({
  page,
}) => {
  await homeStates.sold(page);
  await expectPhone(page);
  const more = page.getByRole("button", { exact: true, name: "Mais" });
  const panel = page.locator('dialog[data-slot="sidebar"]');
  await more.click();
  await expect(panel).toBeVisible();
  expect(
    await panel.evaluate((node: HTMLDialogElement) =>
      node.getAnimations().map((item) => (item as CSSAnimation).animationName)
    )
  ).toEqual([]);
  await panel.getByRole("button", { exact: true, name: "Fechar" }).click();
  // closed in the click itself: not marked as closing
  expect(
    await panel.evaluate((node: HTMLDialogElement) => ({
      closing: node.hasAttribute("data-closing"),
      open: node.open,
    }))
  ).toEqual({ closing: false, open: false });
  await expect(more).toBeFocused();
});

test("e) controle: o desktop de 1280 px com mouse e o tablet de 820×1180 com toque ficam full; no desktop a barra carrega a camada animada e a pílula sai animada", async ({
  browser,
}) => {
  await inContext(
    browser,
    { ...DESKTOP, serviceWorkers: "block" },
    async (page) => {
      await page.route(CHARTS_CHUNK, (route) => route.abort());
      const motion = watchRequests(page, MOTION_CHUNK);
      const layer = watchRequests(page, LAYER_CHUNK);
      await openGallery(page);
      expect(await level(page)).toBe("full");
      // the layer arrives by import() after the first paint
      await expect.poll(() => layer.length).toBe(1);
      await expect.poll(() => motion.length).toBe(1);
      await expect
        .poll(() =>
          bar(page)
            .locator('[data-slot="filter-pill"]')
            .first()
            .evaluate((element) => element.getAttribute("style") ?? "")
        )
        .not.toBe("");
      expect(await pillAfterOneFrame(page)).toBe(true);
      expect(await addedPillStyle(page)).toContain("opacity");
    }
  );
  await inContext(browser, TABLET, async (page) => {
    await openGallery(page);
    expect(
      await page.evaluate(() => matchMedia("(pointer: coarse)").matches)
    ).toBe(true);
    expect(await level(page)).toBe("full");
  });
  // a narrow window on the desktop is no phone: no touch, full
  await inContext(
    browser,
    { ...DESKTOP, viewport: { height: 740, width: 360 } },
    async (page) => {
      await openGallery(page);
      expect(await level(page)).toBe("full");
    }
  );
});

test("f) com prefers-reduced-motion o nível é none, no celular e no desktop", async ({
  browser,
}) => {
  for (const options of [PHONE, DESKTOP]) {
    // biome-ignore lint/performance/noAwaitInLoops: one context at a time, on a busy machine
    await inContext(
      browser,
      { ...options, reducedMotion: "reduce" },
      async (page) => {
        await openGallery(page);
        expect(await level(page)).toBe("none");
      }
    );
  }
});

test("g) no celular o Histórico (a barra de filtros na tela) não pede o motion nem a camada animada, e a pílula sai de uma vez; no desktop a mesma tela carrega a camada", async ({
  browser,
}) => {
  await inContext(
    browser,
    { ...PHONE, serviceWorkers: "block" },
    async (page) => {
      await page.route(CHARTS_CHUNK, (route) => route.abort());
      const layer = watchRequests(page, LAYER_CHUNK);
      const motion = watchRequests(page, MOTION_CHUNK);
      await historyStates.filters(page);
      await expectPhone(page);
      await page
        .getByRole("button", { name: "Tirar o filtro Situação" })
        .click();
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(resolve))
      );
      expect(
        await page.locator('[aria-label^="Situação: "]').count(),
        "a pílula sai no quadro do clique"
      ).toBe(0);
      await page.waitForLoadState("networkidle");
      expect(motion).toEqual([]);
      expect(layer).toEqual([]);
    }
  );
  await inContext(
    browser,
    { ...DESKTOP, serviceWorkers: "block" },
    async (page) => {
      await page.route(CHARTS_CHUNK, (route) => route.abort());
      const layer = watchRequests(page, LAYER_CHUNK);
      await historyStates.filters(page);
      expect(await level(page)).toBe("full");
      await expect.poll(() => layer.length).toBe(1);
    }
  );
});

/** The `animation-name` the box and the veil of the form Dialog compute, once it is open. */
async function dialogAnimations(page: Page) {
  await page.goto("/ui-galeria");
  await page.getByRole("button", { name: "Abrir formulário" }).click();
  const dialog = page.getByRole("dialog", { name: "Novo cadastro" });
  await expect(dialog).toBeVisible();
  return dialog.evaluate((box) => {
    const veil = document.querySelector('[data-slot="dialog-overlay"]');
    return {
      box: getComputedStyle(box).animationName,
      veil: veil ? getComputedStyle(veil).animationName : "",
    };
  });
}

test("h) no celular o diálogo de formulário abre sem animação, na caixa e no véu; no desktop o mesmo diálogo anima", async ({
  browser,
  page,
}) => {
  const phone = await dialogAnimations(page);
  await expectPhone(page);
  expect(phone).toEqual({ box: "none", veil: "none" });
  await inContext(
    browser,
    { ...DESKTOP, serviceWorkers: "block" },
    async (desktop) => {
      const animations = await dialogAnimations(desktop);
      expect(await level(desktop)).toBe("full");
      expect(animations.box).not.toBe("none");
      expect(animations.veil).not.toBe("none");
    }
  );
});
