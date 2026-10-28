/// <reference lib="dom" />
import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  VISUAL_BROWSER_VERSION,
  VISUAL_WS_ENV,
} from "../scripts/visual-browser";
import { COLOR_SCHEME, SCREENS, type UiScreen, VIEWPORTS } from "./ui-screens";

/**
 * Visual regression: one state per screen of `ui-screens.ts`, plus the error and empty states the guardrails already
 * measure, at 360 (phone, touch) and 1280 (mouse) px, in the light and dark themes, against the baselines in
 * `ui-visual.e2e.ts-snapshots/`. The browser is the Chromium of the pinned Playwright image
 * (`scripts/visual-browser.ts`); `bun run test:visual:update` draws the baselines again in that image
 * (docs/runbooks/testes-de-tela.md, "Regressão visual").
 *
 * What makes two runs draw the same pixels: the image, the app's own fonts awaited, no animation, caret or motion,
 * the network idle plus one frame, the page clock fixed in the São Paulo zone, and the fixed fixtures of the states.
 */

/** The states, by their name in `SCREENS`, and the name of their baseline files. */
const VISUAL_STATES = [
  ["entrar", "entrar"],
  ["entrar senha incorreta", "entrar-senha-incorreta"],
  ["criar conta", "criar-conta"],
  ["texto legal não abriu", "texto-legal-erro"],
  ["primeiro acesso", "primeiro-acesso"],
  ["aceite", "aceite"],
  ["venda com itens", "venda-com-itens"],
  ["venda erro nos campos", "venda-erro-nos-campos"],
  ["estoque lista", "estoque-lista"],
  ["estoque vazio", "estoque-vazio"],
  ["estoque erro ao ler", "estoque-erro"],
  ["despesas lista", "despesas-lista"],
  ["resultado mês incompleto e gráfico de vendas", "resultado-grafico"],
  ["resultado sem dados", "resultado-vazio"],
  ["início com vendas", "inicio-com-vendas"],
  ["início erro nos números", "inicio-erro"],
  ["assinatura oferta com Pix", "assinatura-oferta"],
  ["histórico lista", "historico-lista"],
  ["detalhe da venda aberto", "detalhe-da-venda"],
  ["peças do shell 404", "shell-404"],
  ["produtos lista", "produtos-lista"],
  ["clientes lista", "clientes-lista"],
  ["catálogo público no ar", "catalogo-no-ar"],
  ["perfis de pagamento lista", "pagamento-lista"],
  ["aparelhos lista", "aparelhos-lista"],
  ["pendências vazio", "pendencias-vazio"],
] as const;

/**
 * The regions that change by nature, hidden from the comparison: the only masks of the spec. Each entry names the
 * baseline file and why.
 */
const MASKS: Partial<
  Record<(typeof VISUAL_STATES)[number][1], (page: Page) => Locator[]>
> = {};

/** The page clock of every state that does not fix its own (`ui-home-states.ts` and others set theirs on top). */
const CLOCK = new Date("2026-10-23T15:00:00.000Z");

const CONTEXTS = [
  { theme: "claro", touch: true, viewport: "360" },
  { theme: "escuro", touch: true, viewport: "360" },
  { theme: "claro", touch: false, viewport: "1280" },
  { theme: "escuro", touch: false, viewport: "1280" },
] as const;

const SCREENSHOT = {
  animations: "disabled",
  caret: "hide",
  maxDiffPixelRatio: 0.001,
  scale: "css",
  threshold: 0.2,
  // two equal screenshots in a row of a tall page take more than the default 5 s on a loaded runner
  timeout: 20_000,
} as const;

function screenNamed(name: string): UiScreen {
  const screen = SCREENS.find((candidate) => candidate.name === name);
  if (!screen) {
    throw new Error(`ui-screens.ts has no state named "${name}"`);
  }
  return screen;
}

// a renamed state fails the load of the file, not a silent hole in the matrix
const STATES = VISUAL_STATES.map(([name, file]) => ({
  file,
  screen: screenNamed(name),
}));

/** Longer than any animation of the app driven by script, which `animations: "disabled"` does not stop. */
const SCRIPTED_MOTION_MS = 5000;

/** The network idle, the app's fonts, the scripted motion run to its end, and one more frame painted after all. */
async function settle(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  // the line charts morph with `motion` on requestAnimationFrame and ignore `reduce`: the page clock (faked by
  // `clock.install`) runs their frames to the end, so the capture never lands in the middle of one
  await page.clock.runFor(SCRIPTED_MOTION_MS);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      })
  );
}

/**
 * The whole page in the window, drawn before the capture: `fullPage` grows the window while it captures, and the
 * charts, which measure their box with a ResizeObserver, could be drawn for the passing size.
 */
async function showWholePage(page: Page, width: number) {
  const pageHeight = () =>
    page.evaluate(() => document.documentElement.scrollHeight);
  await settle(page);
  // a page as tall as the window (`min-h-dvh` plus a margin) grows with it: grow the window until it stops
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each size is measured after the last one is drawn
    const height = await pageHeight();
    if (height === page.viewportSize()?.height) {
      break;
    }
    await page.setViewportSize({ height, width });
    await settle(page);
  }
  expect(await pageHeight(), "a página inteira cabe na janela").toBe(
    page.viewportSize()?.height
  );
}

/**
 * The CPU of the browser, read from a page of the app (the hints exist only in a secure context). `navigator.platform`
 * says "Linux x86_64" on every Linux (the reduced user agent); the high-entropy hints do not.
 */
async function expectImagePlatform(page: Page) {
  const platform = await page.evaluate(async () => {
    const hints = await (
      navigator as Navigator & {
        userAgentData: {
          getHighEntropyValues: (keys: string[]) => Promise<{
            architecture: string;
            bitness: string;
            platform: string;
          }>;
        };
      }
    ).userAgentData.getHighEntropyValues(["architecture", "bitness"]);
    return `${hints.platform} ${hints.architecture} ${hints.bitness}`;
  });
  expect(platform, "a plataforma da imagem fixa").toBe("Linux x86 64");
}

test.describe.configure({ mode: "parallel" });

test.use({
  deviceScaleFactor: 1,
  locale: "pt-BR",
  reducedMotion: "reduce",
  timezoneId: "America/Sao_Paulo",
});

// A baseline is drawn only by the browser the launcher starts from the image (a remote Chromium of the pinned version;
// its CPU is checked on the app's page, before each capture): a run against any other browser fails before it writes.
test.beforeEach(({ browser }) => {
  expect(
    process.env[VISUAL_WS_ENV],
    "o navegador da imagem fixa (bun run test:visual ou test:visual:update)"
  ).toBeTruthy();
  expect(browser.version(), "o Chromium da imagem fixa").toBe(
    VISUAL_BROWSER_VERSION
  );
});

test("a pasta de baselines tem exatamente as imagens da lista", () => {
  const info = test.info();
  const folder = dirname(info.snapshotPath("x.png"));
  const suffix = `-${info.project.name}-${process.platform}.png`;
  const expected = STATES.flatMap(({ file }) =>
    CONTEXTS.map(
      ({ theme, viewport }) => `${file}-${viewport}-${theme}${suffix}`
    )
  ).sort();
  // a state taken out of the list must take its images with it
  expect(readdirSync(folder).sort()).toEqual(expected);
});

test("as fontes do app carregaram: Geist e Geist Mono, sem fonte do sistema", async ({
  page,
}) => {
  await page.goto("/entrar");
  await page.getByRole("heading", { level: 1 }).first().waitFor();
  await expectImagePlatform(page);
  const fonts = await page.evaluate(async () => {
    const families = ["Geist Variable", "Geist Mono Variable"];
    // a family nobody uses is fetched only on demand: ask for both, from the app's own files
    await Promise.all(
      families.map((family) => document.fonts.load(`16px "${family}"`))
    );
    await document.fonts.ready;
    return families.map((family) => ({
      check: document.fonts.check(`16px "${family}"`),
      family,
      // `check` is also true for a family with no face at all: count the faces loaded from the app
      loaded: [...document.fonts].filter(
        (face) =>
          face.family.replaceAll('"', "") === family && face.status === "loaded"
      ).length,
    }));
  });
  expect(fonts).toEqual([
    { check: true, family: "Geist Variable", loaded: 1 },
    { check: true, family: "Geist Mono Variable", loaded: 1 },
  ]);
  // the body text is drawn with Geist: the computed family starts with it, so no system face stands in
  const bodyFamily = await page.evaluate(
    () => getComputedStyle(document.body).fontFamily
  );
  expect(bodyFamily.startsWith('"Geist Variable"'), bodyFamily).toBe(true);
});

for (const { file, screen } of STATES) {
  for (const context of CONTEXTS) {
    const { theme, touch, viewport } = context;
    test.describe(`${screen.name} · ${viewport} px · tema ${theme}`, () => {
      test.use({
        colorScheme: COLOR_SCHEME[theme],
        hasTouch: touch,
        isMobile: touch,
        viewport: VIEWPORTS[viewport],
      });

      test("igual à baseline", async ({ page }) => {
        await page.clock.install({ time: CLOCK });
        await screen.open(page, page.context());
        await expectImagePlatform(page);
        await showWholePage(page, VIEWPORTS[viewport].width);
        await expect(page).toHaveScreenshot(
          `${file}-${viewport}-${theme}.png`,
          {
            ...SCREENSHOT,
            mask: MASKS[file]?.(page) ?? [],
          }
        );
      });
    });
  }
}
