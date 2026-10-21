/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  axeFaults,
  focusFaults,
  overflowFaults,
  overlayMovement,
  readMotion,
  runningMotion,
  startMotionRecorder,
  touchFaults,
} from "./ui-guardrails";
import {
  SCREENS,
  THEMES,
  type UiCheck,
  type UiScreen,
  VIEWPORTS,
} from "./ui-screens";

/**
 * The interface guardrails (t180): what the UX review finds by measuring, measured on every screen of
 * `ui-screens.ts`, at 320, 360 and 1280 px, in the light and the dark theme. Each check has a control case below that
 * proves it catches the fault it is for (a check that never fails proves nothing). Adding a screen:
 * docs/runbooks/testes-de-tela.md.
 *
 *   1. nothing leaves its container nor the viewport      4. colors only in OKLCH and tokens: scripts/ui-source-rules.test.ts
 *   2. touch area of 44/48 px, neighbors do not overlap   5. motion: overlays only fade; nothing animates with reduce
 *   3. axe, WCAG 2.2 A and AA                              6. keyboard focus draws the 3 px ring
 */

// The contexts of the matrix: a phone has touch; the wide screen runs with the mouse and again with touch (a
// tablet), where the 48 px areas exist (`pointer: coarse`).
const CONTEXTS = [
  ...VIEWPORTS.filter((viewport) => viewport.width < 760).map((viewport) => ({
    touch: true,
    viewport,
  })),
  ...VIEWPORTS.filter((viewport) => viewport.width >= 760).flatMap(
    (viewport) => [
      { touch: false, viewport },
      { touch: true, viewport },
    ]
  ),
];

const touchName = (touch: boolean) => (touch ? "com toque" : "com mouse");

test.beforeEach(({ browserName }, testInfo) => {
  test.skip(
    browserName !== "chromium" || testInfo.project.name !== "chromium-desktop",
    "the matrix sets its own viewports and touch: the Pixel 5 project would repeat it"
  );
});

async function openScreen(screen: UiScreen, page: Page) {
  await page.addInitScript(startMotionRecorder);
  await screen.open(page, page.context());
}

/** What the browser finds must be exactly what the screen lists as waiting for its migration (nothing, if migrated). */
const expected = (screen: UiScreen, check: UiCheck) =>
  [...(screen.known?.[check] ?? [])].sort();

for (const screen of SCREENS) {
  for (const { touch, viewport } of CONTEXTS) {
    for (const theme of THEMES) {
      const where = `${screen.name} · ${viewport.name} px · ${touchName(touch)} · tema ${theme.name}`;
      const context = {
        colorScheme: theme.colorScheme,
        hasTouch: touch,
        isMobile: touch && viewport.width < 760,
        viewport: { height: viewport.height, width: viewport.width },
      };

      test.describe(where, () => {
        test.use(context);

        // One page load for the checks that only read: each reports on its own (soft), so a run shows every fault.
        test("contêiner, toque, axe e foco", async ({ page }) => {
          await openScreen(screen, page);
          expect
            .soft(
              (await overflowFaults(page)).sort(),
              "1. nada sai do contêiner"
            )
            .toEqual(expected(screen, "overflow"));
          if (touch) {
            expect
              .soft(
                (
                  await touchFaults(page, {
                    exemptInlineLinks: true,
                    minimum: screen.status === "migrated" ? 48 : 44,
                  })
                ).sort(),
                "2. área de toque"
              )
              .toEqual(expected(screen, "touch"));
          }
          expect
            .soft((await axeFaults(page)).sort(), "3. axe WCAG 2.2 A e AA")
            .toEqual(expected(screen, "axe"));
          expect
            .soft((await focusFaults(page)).sort(), "6. foco de 3 px")
            .toEqual(expected(screen, "focus"));
        });

        test("as sobreposições só desvanecem", async ({ page }) => {
          test.skip(!screen.exercise, "the screen has no overlay");
          await openScreen(screen, page);
          await screen.exercise?.(page);
          const records = await readMotion(page);
          // the recorder saw overlays animate: an empty list of faults is not a recorder that saw nothing
          expect(records.some((record) => record.overlay)).toBe(true);
          expect(overlayMovement(records)).toEqual([]);
        });
      });

      test.describe(`${where} · movimento reduzido`, () => {
        test.use({ ...context, reducedMotion: "reduce" });

        test("com prefers-reduced-motion: reduce nada anima", async ({
          page,
        }) => {
          await openScreen(screen, page);
          await screen.exercise?.(page);
          expect(runningMotion(await readMotion(page))).toEqual([]);
        });
      });
    }
  }
}

// ---- control cases: each check fails on the fault it is for -----------------------------------------------

test.describe("controle: cada verificação pega a falha", () => {
  test.use({
    colorScheme: "light",
    hasTouch: true,
    isMobile: true,
    viewport: { height: 740, width: 360 },
  });
  const gallery = SCREENS.find((screen) => screen.name === "galeria");
  if (!gallery) {
    throw new Error(
      "ui-screens.ts must list the gallery: the control cases run on it"
    );
  }

  test("1. um elemento largo, um link de 100% com padding, uma palavra longa e um elemento além da tela são pegos", async ({
    page,
  }) => {
    await openScreen(gallery, page);
    expect(await overflowFaults(page)).toEqual([]);
    await page.evaluate(() => {
      // each fault in a box of its own, so one does not widen the box of the next
      const box = (name: string) => {
        const element = document.createElement("section");
        element.setAttribute("aria-label", name);
        element.style.width = "200px";
        document.querySelector("main")?.append(element);
        return element;
      };
      const wide = document.createElement("div");
      wide.textContent = "Elemento largo demais";
      wide.style.width = "300px";
      box("elemento").append(wide);
      const link = document.createElement("a");
      link.href = "#";
      link.textContent = "Link de largura cheia";
      link.style.display = "block";
      link.style.boxSizing = "content-box";
      link.style.width = "100%";
      link.style.padding = "0 24px";
      box("link").append(link);
      const word = document.createElement("p");
      word.textContent = "Supercalifragilisticexpialidocious";
      box("palavra").append(word);
    });
    const inBox = (await overflowFaults(page)).join("\n");
    expect(inBox).toContain('div "Elemento largo demais" sai de section');
    expect(inBox).toContain('a "Link de largura cheia" sai de section');
    expect(inBox).toContain('o texto de p "Supercalifragilisticexpialidoc"');

    await page.evaluate(() => {
      const beyond = document.createElement("div");
      beyond.textContent = "Mais larga que a tela";
      beyond.style.width = "900px";
      document.querySelector("main")?.append(beyond);
    });
    const beyondScreen = (await overflowFaults(page)).join("\n");
    expect(beyondScreen).toContain('div "Mais larga que a tela" sai da tela');
    expect(beyondScreen).toContain("a página rola de lado");
  });

  test("2. um botão pequeno e dois botões com áreas que se encontram", async ({
    page,
  }) => {
    await openScreen(gallery, page);
    const check = { exemptInlineLinks: true, minimum: 48 };
    expect(await touchFaults(page, check)).toEqual([]);
    await page.evaluate(() => {
      const main = document.querySelector("main");
      const small = document.createElement("button");
      small.textContent = "Pequeno";
      small.style.height = "20px";
      const first = document.createElement("button");
      first.textContent = "Vizinho um";
      const second = document.createElement("button");
      second.textContent = "Vizinho dois";
      for (const button of [first, second]) {
        button.style.display = "block";
        button.style.height = "60px";
        button.style.width = "120px";
      }
      second.style.marginTop = "-20px";
      main?.append(small, first, second);
    });
    const faults = (await touchFaults(page, check)).join("\n");
    expect(faults).toContain('button "Pequeno" tem área de toque');
    expect(faults).toContain(
      'a área de toque de button "Vizinho um" se sobrepõe à de button "Vizinho dois"'
    );
  });

  test("3. o axe acusa texto sem contraste", async ({ page }) => {
    await openScreen(gallery, page);
    expect(await axeFaults(page)).toEqual([]);
    await page.evaluate(() => {
      const text = document.createElement("p");
      text.textContent = "Texto quase invisível";
      text.style.color = "rgb(200, 200, 200)";
      text.style.backgroundColor = "rgb(210, 210, 210)";
      document.querySelector("main")?.append(text);
    });
    expect(
      (await axeFaults(page)).map((fault) => fault.split(":")[0])
    ).toContain("color-contrast");
  });

  test("6. um botão sem contorno de foco é pego, e a ordem de Tab sem ele passa", async ({
    page,
  }) => {
    await openScreen(gallery, page);
    expect(await focusFaults(page)).toEqual([]);
    await page.evaluate(() => {
      const button = document.createElement("button");
      button.textContent = "Sem foco visível";
      button.style.outline = "none";
      document.querySelector("main")?.append(button);
    });
    expect(await focusFaults(page)).toEqual([
      'button "Sem foco visível" não mostra o contorno de foco de 3 px',
    ]);
  });

  test("5. uma sobreposição que cresce é pega; a que só desvanece passa", async ({
    page,
  }) => {
    await openScreen(gallery, page);
    await page.evaluate(() => {
      const portal = document.createElement("div");
      portal.setAttribute("data-ui", "");
      const fades = document.createElement("div");
      const grows = document.createElement("div");
      fades.textContent = "só desvanece";
      grows.textContent = "cresce";
      portal.append(fades, grows);
      document.body.append(portal);
      fades.animate([{ opacity: 0 }, { opacity: 1 }], 400);
      grows.animate(
        [
          { opacity: 0, transform: "scale(0.8)" },
          { opacity: 1, transform: "scale(1)" },
        ],
        400
      );
    });
    await page.waitForTimeout(600);
    const records = await readMotion(page);
    expect(overlayMovement(records)).toHaveLength(1);
    expect(runningMotion(records).length).toBeGreaterThan(0);
  });

  test("5. com reduce, uma animação fora da regra é pega e a da interface não", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      colorScheme: "light",
      reducedMotion: "reduce",
      viewport: { height: 740, width: 360 },
    });
    const page = await context.newPage();
    await openScreen(gallery, page);
    expect(runningMotion(await readMotion(page))).toEqual([]);
    await page.evaluate(() => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(
        "@keyframes controle-pulso { from { opacity: 0.2 } to { opacity: 1 } } .controle-pulso { animation: controle-pulso 2s infinite }"
      );
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      const outside = document.createElement("p");
      outside.className = "controle-pulso";
      outside.textContent = "fora da interface nova";
      document.body.append(outside);
      const inside = document.createElement("p");
      inside.className = "controle-pulso";
      inside.textContent = "dentro de [data-ui]";
      document.querySelector("main")?.append(inside);
    });
    await page.waitForTimeout(300);
    expect(
      runningMotion(await readMotion(page)).map((record) => record.duration)
    ).toEqual([2000]);
    await context.close();
  });
});
