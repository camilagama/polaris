/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  axeFaults,
  focusFaults,
  overflowFaults,
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
 * The interface guardrails: what the UX review finds by measuring, measured on every screen of
 * `ui-screens.ts`, each check only on the axes that can change its result (`CHECK_CONTEXTS`, with the table in
 * docs/runbooks/testes-de-tela.md). Each check has a control case below that
 * proves it catches the fault it is for (a check that never fails proves nothing). Adding a screen:
 * docs/runbooks/testes-de-tela.md.
 *
 *   1. nothing leaves its container nor the viewport      4. colors only in OKLCH and tokens: scripts/ui-source-rules.test.ts
 *   2. touch area of 44 px, neighbors do not overlap      5. motion: nothing animates with reduce
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

// One file with hundreds of tests that share nothing (each opens its own page): without this the whole file is one
// group and runs in a single worker, however many there are.
test.describe.configure({ mode: "parallel" });

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
        // the context is what the name says: the 44 px areas of the touch check exist only with `pointer: coarse`
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
            .toEqual([]);
        }
        if (runs("touch")) {
          expect
            .soft(
              (
                await touchFaults(page, {
                  exemptInlineLinks: true,
                  minimum: 44,
                })
              ).sort(),
              "2. área de toque"
            )
            .toEqual([]);
        }
        if (runs("axe")) {
          expect
            .soft((await axeFaults(page)).sort(), "3. axe WCAG 2.2 A e AA")
            .toEqual([]);
        }
        if (runs("focus")) {
          expect
            .soft((await focusFaults(page)).sort(), "6. foco de 3 px")
            .toEqual([]);
        }
      });
    });
  }

  // Motion (5): once per state, in one context, and once more with reduce.
  const motionWhere = `${screen.name} · ${contextName(MOTION_CONTEXT)}`;
  test.describe(`${motionWhere} · movimento reduzido`, () => {
    test.use({ ...contextOptions(MOTION_CONTEXT), reducedMotion: "reduce" });

    test("com prefers-reduced-motion: reduce nada anima", async ({ page }) => {
      await openScreen(screen, page);
      await screen.exercise?.(page);
      expect(runningMotion(await readMotion(page))).toEqual([]);
    });
  });
}

/** A desktop window of 360 px with a mouse: the panel of the phone and the `full` level of motion. */
const NARROW_MOUSE = {
  colorScheme: "light",
  hasTouch: false,
  isMobile: false,
  viewport: { height: 740, width: 360 },
} as const;

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

  const homeSold = SCREENS.find(
    (screen) => screen.name === "início com vendas"
  );
  if (!homeSold) {
    throw new Error(
      "ui-screens.ts must list the Início with sales: the sheet control cases run on it"
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
    const check = { exemptInlineLinks: true, minimum: 44 };
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
      // the controls of a group: from 24 px with no area of their own, but 8 px apart; closer than that, or smaller, fail
      const group = (name: string, gap: number, size: number) => {
        const box = document.createElement("div");
        box.dataset.targetGroup = "";
        box.style.display = "flex";
        box.style.gap = `${gap}px`;
        box.style.marginTop = "40px";
        for (const part of ["um", "dois"]) {
          const button = document.createElement("button");
          button.textContent = `${name} ${part}`;
          button.style.height = `${size}px`;
          button.style.width = `${size}px`;
          box.append(button);
        }
        return box;
      };
      main?.append(
        small,
        first,
        second,
        line,
        row,
        field,
        group("Afastado", 8, 24),
        group("Junto", 2, 24),
        group("Miúdo", 8, 20)
      );
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
    expect(faults).not.toContain("Afastado");
    expect(faults).toContain(
      'a área de toque de button "Junto um" se sobrepõe à de button "Junto dois"'
    );
    expect(faults).toContain(
      'button "Miúdo um" tem área de toque de 20 × 20 px (mínimo 24)'
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

  test("6. com um diálogo aberto a volta de Tab gira dentro dele, sem contar as sentinelas do Base UI; o que perde o contorno é pego", async ({
    page,
  }) => {
    await openScreen(gallery, page);
    await page.getByRole("button", { name: "Abrir diálogo" }).click();
    await page.getByRole("dialog").waitFor();
    expect(await focusFaults(page)).toEqual([]);
    await page.evaluate(() => {
      const bare = document.createElement("button");
      bare.textContent = "Sem foco visível";
      bare.style.outline = "none";
      document.querySelector("[role=dialog]")?.append(bare);
    });
    expect(await focusFaults(page)).toEqual([
      'button "Sem foco visível" não mostra o contorno de foco de 3 px',
    ]);
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

  test("5. sem reduce e no nível full (janela de 360 px com mouse), o popover e os outros animam (100 ms do shadcn) e o painel recolhível anima a altura (200 ms); a verificação com reduce não passa por não haver animação", async ({
    browser,
  }) => {
    // with touch at 360 px the level is `essential` and these do not animate (motion-level.e2e.ts)
    const context = await browser.newContext(NARROW_MOUSE);
    try {
      const page = await context.newPage();
      await openScreen(gallery, page);
      expect(
        await page.evaluate(() => document.documentElement.dataset.motion)
      ).toBe("full");
      // a panel that mounts open does not animate on the first paint: the recorder, installed before the page, saw none
      await expect(page.getByText("Condomínio, todo dia 10.")).toBeVisible();
      expect(
        (await readMotion(page)).filter(
          (record) => record.name === "collapsible-down"
        )
      ).toEqual([]);
      // half way (100 ms of 200): paused there, the box is taller than 0 and shorter than the end
      const halfway = await page.evaluate(async () => {
        const trigger = [...document.querySelectorAll("button")].find(
          (button) => button.textContent === "Despesas recorrentes"
        );
        const root = trigger?.closest('[data-slot="collapsible"]');
        if (!(trigger && root)) {
          throw new Error("the gallery has no collapsible panel");
        }
        trigger.click();
        // the panel is not in the page while closed: it appears with the click
        let panel: Element | null = null;
        let animation: Animation | undefined;
        for (let frame = 0; frame < 120 && !animation; frame += 1) {
          // biome-ignore lint/performance/noAwaitInLoops: one frame at a time
          await new Promise((resolve) => requestAnimationFrame(resolve));
          panel = root.querySelector('[data-slot="collapsible-content"]');
          animation = panel
            ?.getAnimations()
            .find(
              (item) =>
                (item as CSSAnimation).animationName === "collapsible-down"
            );
        }
        if (!(panel && animation)) {
          throw new Error("the panel did not start the opening animation");
        }
        animation.pause();
        animation.currentTime = 100;
        const middle = panel.getBoundingClientRect().height;
        animation.finish();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        return { end: panel.getBoundingClientRect().height, middle };
      });
      expect(halfway.middle).toBeGreaterThan(0);
      expect(halfway.middle).toBeLessThan(halfway.end);
      // closed again: the exercise of the gallery opens it itself
      await page.getByRole("button", { name: "Despesas recorrentes" }).click();
      await page
        .getByText("Aluguel e internet, todo dia 5.")
        .waitFor({ state: "detached" });
      await gallery.exercise?.(page);
      const running = runningMotion(await readMotion(page));
      expect(running.some((record) => record.duration === 100)).toBe(true);
      expect(
        running.some(
          (record) =>
            record.name === "collapsible-down" && record.duration === 200
        )
      ).toBe(true);
    } finally {
      await context.close();
    }
  });

  test("5. sem reduce e no nível full (janela de 360 px com mouse), o painel do celular sai animado (200 ms) por Esc, véu e Fechar, reabrir na saída fica aberto e a guarda o fecha se o animationend não vem", async ({
    browser,
  }) => {
    // with touch at 360 px the level is `essential` and the panel closes at once (motion-level.e2e.ts): the animated
    // exit is the narrow desktop window's, the same panel with a mouse
    const context = await browser.newContext(NARROW_MOUSE);
    try {
      const page = await context.newPage();
      await openScreen(homeSold, page);
      expect(
        await page.evaluate(() => document.documentElement.dataset.motion)
      ).toBe("full");
      const more = page.getByRole("button", { exact: true, name: "Mais" });
      const panel = page.getByRole("dialog", { name: "Mais" });
      const close = () => page.keyboard.press("Escape");
      const veil = () => page.mouse.click(8, 400);
      const button = () =>
        panel.getByRole("button", { exact: true, name: "Fechar" }).click();
      for (const [, ask] of [
        ["Esc", close],
        ["véu", veil],
        ["Fechar", button],
      ] as const) {
        // biome-ignore lint/performance/noAwaitInLoops: one way out at a time
        await more.click();
        await expect(panel).toBeVisible();
        // the entrance is over before the exit is asked for
        await panel.evaluate((node: HTMLDialogElement) =>
          Promise.all(node.getAnimations().map((item) => item.finished))
        );
        await ask();
        // right after the request the panel is still there, closing, and the 200 ms exit animation runs
        expect(
          await panel.evaluate((node: HTMLDialogElement) => ({
            closing: node.hasAttribute("data-closing"),
            exit: node
              .getAnimations()
              .some((item) => (item as CSSAnimation).animationName === "exit"),
            open: node.open,
          }))
        ).toEqual({ closing: true, exit: true, open: true });
        await expect(panel).toBeHidden();
        await expect(more).toBeFocused();
        await expect(more).toHaveAttribute("aria-expanded", "false");
      }
      // asked to open again while it leaves (the "Sair" warning does it): it stays open
      await more.click();
      await expect(panel).toBeVisible();
      await panel.evaluate((node: HTMLDialogElement) =>
        Promise.all(node.getAnimations().map((item) => item.finished))
      );
      await close();
      await more.evaluate((node: HTMLButtonElement) => node.click());
      await page.waitForTimeout(600);
      expect(
        await panel.evaluate((node: HTMLDialogElement) => ({
          closing: node.hasAttribute("data-closing"),
          open: node.open,
        }))
      ).toEqual({ closing: false, open: true });
      await close();
      await expect(panel).toBeHidden();
      // no `animationend` (a browser that skips the animation): the guard of 300 ms closes it
      await page.evaluate(() => {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(
          "dialog[data-closing], dialog[data-closing]::backdrop { animation: none !important }"
        );
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      });
      await more.click();
      await expect(panel).toBeVisible();
      await close();
      await expect(panel).toBeHidden({ timeout: 1500 });
      await expect(more).toBeFocused();
    } finally {
      await context.close();
    }
  });

  test("5. sem reduce e no nível full, um segundo Esc enquanto o painel do celular sai fecha de uma vez, sem erro na página", async ({
    browser,
  }) => {
    const context = await browser.newContext(NARROW_MOUSE);
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await openScreen(homeSold, page);
      const more = page.getByRole("button", { exact: true, name: "Mais" });
      const panel = page.getByRole("dialog", { name: "Mais" });
      await more.click();
      await expect(panel).toBeVisible();
      await panel.evaluate((node: HTMLDialogElement) =>
        Promise.all(node.getAnimations().map((item) => item.finished))
      );
      // what the panel was doing when each Escape arrived: read in the page, in the same task as the key, because the
      // exit lasts 200 ms and a round trip of the test can outlast it
      await panel.evaluate((node: HTMLDialogElement) => {
        const seen: boolean[] = [];
        (window as unknown as { escapes: boolean[] }).escapes = seen;
        document.addEventListener(
          "keydown",
          (event) => {
            if (event.key === "Escape") {
              seen.push(node.hasAttribute("data-closing"));
            }
          },
          true
        );
      });
      await Promise.all([
        page.keyboard.press("Escape"),
        page.keyboard.press("Escape"),
      ]);
      expect(
        await page.evaluate(
          () => (window as unknown as { escapes: boolean[] }).escapes
        ),
        "o 2º Esc tem de chegar com o painel já saindo"
      ).toEqual([false, true]);
      await expect(panel).toBeHidden();
      await expect(more).toBeFocused();
      await expect(more).toHaveAttribute("aria-expanded", "false");
      // a closed dialog is out of the role tree: `panel` no longer finds it, the attribute still does
      expect(
        await page
          .locator('dialog[aria-label="Mais"]')
          .evaluate((node: HTMLDialogElement) => ({
            closing: node.hasAttribute("data-closing"),
            open: node.open,
          }))
      ).toEqual({ closing: false, open: false });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("5. com reduce, o painel do celular fecha de uma vez, sem animação de saída", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      colorScheme: "light",
      hasTouch: true,
      isMobile: true,
      reducedMotion: "reduce",
      viewport: { height: 740, width: 360 },
    });
    const page = await context.newPage();
    await openScreen(homeSold, page);
    const more = page.getByRole("button", { exact: true, name: "Mais" });
    const panel = page.locator('dialog[data-slot="sidebar"]');
    await more.click();
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { exact: true, name: "Fechar" }).click();
    // closed in the click itself: not marked as closing, nothing left running
    expect(
      await panel.evaluate((node: HTMLDialogElement) => ({
        closing: node.hasAttribute("data-closing"),
        open: node.open,
      }))
    ).toEqual({ closing: false, open: false });
    await expect(more).toBeFocused();
    expect(runningMotion(await readMotion(page))).toEqual([]);
    await context.close();
  });

  test("5. com reduce, uma animação que escapa da regra é pega e a comum não", async ({
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
      // the reduce rule of theme.css is global and `!important`: only an inline `!important` gets past it
      const escapes = document.createElement("p");
      escapes.textContent = "escapa do reduce";
      escapes.style.setProperty(
        "animation",
        "controle-pulso 2s infinite",
        "important"
      );
      document.querySelector("main")?.append(escapes);
      const common = document.createElement("p");
      common.className = "controle-pulso";
      common.textContent = "animação comum";
      document.querySelector("main")?.append(common);
    });
    await expect
      .poll(async () =>
        runningMotion(await readMotion(page)).map((record) => record.duration)
      )
      .toEqual([2000]);
    await context.close();
  });
});
