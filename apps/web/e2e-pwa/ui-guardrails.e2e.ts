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
  CHECK_CONTEXTS,
  COLOR_SCHEME,
  MOTION_CONTEXT,
  SCREENS,
  type UiCheck,
  type UiContext,
  type UiScreen,
  VIEWPORTS,
} from "./ui-screens";

/**
 * The interface guardrails (t180): what the UX review finds by measuring, measured on every screen of
 * `ui-screens.ts`, each check only on the axes that can change its result (`CHECK_CONTEXTS`, with the table in
 * docs/runbooks/testes-de-tela.md). Each check has a control case below that
 * proves it catches the fault it is for (a check that never fails proves nothing). Adding a screen:
 * docs/runbooks/testes-de-tela.md.
 *
 *   1. nothing leaves its container nor the viewport      4. colors only in OKLCH and tokens: scripts/ui-source-rules.test.ts
 *   2. touch area of 44/48 px, neighbors do not overlap   5. motion: overlays only fade; nothing animates with reduce
 *   3. axe, WCAG 2.2 A and AA                              6. keyboard focus draws the 3 px ring
 */

const touchName = (touch: boolean) => (touch ? "com toque" : "com mouse");
const contextName = ({ theme, touch, viewport }: UiContext) =>
  `${viewport} px · ${touchName(touch)} · tema ${theme}`;

/** The browser options of a context: a phone is mobile, the wide screen with touch is a tablet. */
const contextOptions = ({ theme, touch, viewport }: UiContext) => ({
  colorScheme: COLOR_SCHEME[theme],
  hasTouch: touch,
  isMobile: touch && VIEWPORTS[viewport].width < 760,
  viewport: VIEWPORTS[viewport],
});

/** The distinct contexts of the map, each with the checks that run on it: one page load serves them all. */
function contextsOfChecks() {
  const byKey = new Map<string, { checks: UiCheck[]; context: UiContext }>();
  for (const check of Object.keys(CHECK_CONTEXTS) as UiCheck[]) {
    for (const context of CHECK_CONTEXTS[check]) {
      const key = contextName(context);
      const entry = byKey.get(key) ?? { checks: [], context };
      entry.checks.push(check);
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()];
}

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

// a check with no context would vanish without a test or a warning (a green run that ran nothing)
for (const [check, contexts] of Object.entries(CHECK_CONTEXTS)) {
  if (contexts.length === 0) {
    throw new Error(`CHECK_CONTEXTS lists no context for the check "${check}"`);
  }
}

for (const screen of SCREENS) {
  for (const { checks, context } of contextsOfChecks()) {
    const where = `${screen.name} · ${contextName(context)}`;
    const runs = (check: UiCheck) => checks.includes(check);

    test.describe(where, () => {
      test.use(contextOptions(context));

      // One page load for the checks that only read: each reports on its own (soft), so a run shows every fault.
      test(`verificações: ${checks.join(", ")}`, async ({ page }) => {
        await openScreen(screen, page);
        // the context is what the name says: the 48 px areas of the touch check exist only with `pointer: coarse`
        expect(
          await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
          "o contexto tem o ponteiro que o nome diz"
        ).toBe(context.touch);
        if (runs("overflow")) {
          expect
            .soft(
              (await overflowFaults(page)).sort(),
              "1. nada sai do contêiner"
            )
            .toEqual(expected(screen, "overflow"));
        }
        if (runs("touch")) {
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
        if (runs("axe")) {
          expect
            .soft((await axeFaults(page)).sort(), "3. axe WCAG 2.2 A e AA")
            .toEqual(expected(screen, "axe"));
        }
        if (runs("focus")) {
          expect
            .soft((await focusFaults(page)).sort(), "6. foco de 3 px")
            .toEqual(expected(screen, "focus"));
        }
      });
    });
  }

  // Motion (5): once per state, in one context, and once more with reduce.
  const motionWhere = `${screen.name} · ${contextName(MOTION_CONTEXT)}`;
  test.describe(`${motionWhere} · movimento`, () => {
    test.use(contextOptions(MOTION_CONTEXT));

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

  test.describe(`${motionWhere} · movimento reduzido`, () => {
    test.use({ ...contextOptions(MOTION_CONTEXT), reducedMotion: "reduce" });

    test("com prefers-reduced-motion: reduce nada anima", async ({ page }) => {
      await openScreen(screen, page);
      await screen.exercise?.(page);
      expect(runningMotion(await readMotion(page))).toEqual([]);
    });
  });
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
      // a link in a line of text is exempt from the size; links in a row, with only blanks between them, are not
      const line = document.createElement("p");
      line.append("Leia os ");
      const inLine = document.createElement("a");
      inLine.href = "#";
      inLine.textContent = "termos de uso";
      line.append(inLine, " antes de seguir.");
      const row = document.createElement("nav");
      for (const name of ["Entrar", "Ajuda"]) {
        const link = document.createElement("a");
        link.href = "#";
        link.textContent = name;
        row.append(link, " ");
      }
      // the field has the area of the group; a button at its end has only its own: one of 20 px without
      // `touch-hit` fails, and one with it passes
      const field = document.createElement("div");
      field.dataset.slot = "input-group";
      field.style.display = "flex";
      field.style.height = "48px";
      field.style.marginTop = "40px";
      const input = document.createElement("input");
      input.setAttribute("aria-label", "Campo do controle");
      const end = document.createElement("button");
      end.textContent = "Dentro do campo";
      end.style.height = "20px";
      const kept = document.createElement("button");
      kept.textContent = "Com área própria";
      kept.className = "touch-hit";
      kept.style.height = "20px";
      kept.style.position = "relative";
      field.append(input, end, kept);
      main?.append(small, first, second, line, row, field);
    });
    const faults = (await touchFaults(page, check)).join("\n");
    expect(faults).toContain('button "Dentro do campo" tem área de toque');
    expect(faults).not.toContain('input "Campo do controle"');
    expect(faults).not.toContain('button "Com área própria"');
    expect(faults).toContain('button "Pequeno" tem área de toque');
    expect(faults).not.toContain('a "termos de uso" tem área de toque');
    expect(faults).toContain('a "Entrar" tem área de toque');
    expect(faults).toContain('a "Ajuda" tem área de toque');
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

  test("6. botão sem contorno de foco, ou só com sombra suave, é pego; o halo de 3 px passa", async ({
    page,
  }) => {
    await openScreen(gallery, page);
    expect(await focusFaults(page)).toEqual([]);
    await page.evaluate(() => {
      const main = document.querySelector("main");
      const bare = document.createElement("button");
      bare.textContent = "Sem foco visível";
      bare.style.outline = "none";
      const soft = document.createElement("button");
      soft.textContent = "Só sombra suave";
      soft.style.outline = "none";
      soft.style.boxShadow = "0 1px 3px 0 rgb(0 0 0 / 0.1)";
      const ring = document.createElement("button");
      ring.textContent = "Com halo de 3 px";
      ring.style.outline = "none";
      ring.style.boxShadow = "0 0 0 3px rgb(0 100 200)";
      main?.append(bare, soft, ring);
    });
    expect((await focusFaults(page)).sort()).toEqual(
      [
        'button "Só sombra suave" não mostra o contorno de foco de 3 px',
        'button "Sem foco visível" não mostra o contorno de foco de 3 px',
      ].sort()
    );
  });

  test("6. um campo de várias partes (data e hora) não encerra a volta de Tab antes dos controles que vêm depois", async ({
    page,
  }) => {
    await openScreen(gallery, page);
    await page.evaluate(() => {
      const field = document.createElement("input");
      field.type = "datetime-local";
      field.setAttribute("aria-label", "Data e hora do controle");
      field.style.outline = "none";
      field.style.boxShadow = "0 0 0 3px rgb(0 100 200)";
      const after = document.createElement("button");
      after.textContent = "Depois do campo";
      after.style.outline = "none";
      after.style.boxShadow = "0 0 0 3px rgb(0 100 200)";
      document.querySelector("main")?.append(field, after);
    });
    // each part of the field is a stop of Tab on the same element: the button after it is still reached
    expect(await focusFaults(page)).toEqual([]);
  });

  test("6. a volta de Tab começa no alto da página, mesmo depois de um clique no meio dela", async ({
    page,
  }) => {
    await openScreen(gallery, page);
    await page.evaluate(() => {
      const main = document.querySelector("main");
      const first = document.createElement("button");
      first.textContent = "Primeiro da página";
      first.style.boxShadow = "0 0 0 3px rgb(0 100 200)";
      main?.prepend(first);
    });
    // a click in the middle of the page moves the starting point of Tab there
    await page.getByRole("button", { name: "Limpar" }).first().click();
    expect(await focusFaults(page)).toEqual([]);
  });

  test("6. um controle que o teclado não alcança é pego", async ({ page }) => {
    await openScreen(gallery, page);
    await page.evaluate(() => {
      const thief = document.createElement("button");
      thief.textContent = "Rouba o foco";
      thief.addEventListener("focus", () => thief.blur());
      document.querySelector("main")?.append(thief);
    });
    expect(await focusFaults(page)).toEqual([
      'button "Rouba o foco" está na ordem de Tab e o teclado não chega nele',
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
      // long enough for a busy machine to sample the growing overlay in more than one pose
      fades.animate([{ opacity: 0 }, { opacity: 1 }], 3000);
      grows.animate(
        [
          { opacity: 0, transform: "scale(0.8)" },
          { opacity: 1, transform: "scale(1)" },
        ],
        3000
      );
    });
    // the recorder samples once per frame: wait until it has seen the growing overlay in a second pose
    await expect
      .poll(async () => overlayMovement(await readMotion(page)).length)
      .toBe(1);
    const records = await readMotion(page);
    const moves = overlayMovement(records);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toContain('div "cresce"');
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
    await expect
      .poll(async () =>
        runningMotion(await readMotion(page)).map((record) => record.duration)
      )
      .toEqual([2000]);
    await context.close();
  });
});
