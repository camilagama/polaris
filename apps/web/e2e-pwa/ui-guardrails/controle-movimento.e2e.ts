/// <reference lib="dom" />
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { SCREENS } from "../ui-screens";
import { configureMatrix, openScreen } from "./matrix";
import { readMotion, runningMotion } from "./measures";

configureMatrix();

/** What the panel of the phone was doing when its own exit animation began. */
interface ExitStart {
  closing: boolean;
  duration: number;
  open: boolean;
}

/**
 * Records, inside the page and at the `animationstart` of the panel's own `exit` animation, what the panel was doing:
 * `data-closing` set, still open, and the duration of the animation. The event comes once the animation exists and
 * before it can end, so the reading depends on no round trip of the test (the exit lasts 200 ms and a loaded runner
 * outlasts that between two calls). With `reopenWith`, that button is clicked in the same task, while the exit runs.
 */
async function watchExitStart(panel: Locator, reopenWith?: Locator) {
  const reopen = (await reopenWith?.elementHandle()) ?? null;
  await panel.evaluate(
    (node: HTMLDialogElement, trigger: HTMLElement | SVGElement | null) => {
      const seen = window as unknown as { exitStart: ExitStart | null };
      seen.exitStart = null;
      const onStart = (event: AnimationEvent) => {
        if (event.animationName !== "exit" || event.pseudoElement !== "") {
          return;
        }
        node.removeEventListener("animationstart", onStart);
        const exit = node
          .getAnimations()
          .find((item) => (item as CSSAnimation).animationName === "exit");
        seen.exitStart = {
          closing: node.hasAttribute("data-closing"),
          duration: Number(exit?.effect?.getComputedTiming().duration),
          open: node.open,
        };
        (trigger as HTMLElement | null)?.click();
      };
      node.addEventListener("animationstart", onStart);
    },
    reopen
  );
}

const exitStart = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { exitStart: ExitStart | null }).exitStart
  );

/**
 * The guard of the panel waits 300 ms of wall clock for `animationend`. On a loaded runner the main thread can stall
 * longer than that between the request and the frame that starts the exit animation, and the guard then closes the panel
 * before any animation exists. This stretches the timers of exactly 300 ms by a factor the test sets, so the cases that
 * look at the animation are not at the mercy of the runner; the case of the guard itself runs unstretched.
 */
interface ExitGuardScale {
  guard: number;
  stretched: number;
}

const stretchExitGuard = (page: Page) =>
  page.addInitScript(() => {
    const scale: ExitGuardScale = { guard: 1, stretched: 0 };
    (window as unknown as { exitGuardScale: ExitGuardScale }).exitGuardScale =
      scale;
    const real = window.setTimeout.bind(window);
    window.setTimeout = ((
      handler: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay === 300 && scale.guard !== 1) {
        scale.stretched += 1;
      }
      return real(handler, delay === 300 ? 300 * scale.guard : delay, ...args);
    }) as typeof window.setTimeout;
  });

const setExitGuardScale = (page: Page, guard: number) =>
  page.evaluate((value) => {
    (
      window as unknown as { exitGuardScale: ExitGuardScale }
    ).exitGuardScale.guard = value;
  }, guard);

const stretchedGuards = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { exitGuardScale: ExitGuardScale }).exitGuardScale
        .stretched
  );

/** A desktop window of 360 px with a mouse: the panel of the phone and the `full` level of motion. */
const NARROW_MOUSE = {
  colorScheme: "light",
  hasTouch: false,
  isMobile: false,
  viewport: { height: 740, width: 360 },
} as const;

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
      await stretchExitGuard(page);
      await openScreen(homeSold, page);
      expect(
        await page.evaluate(() => document.documentElement.dataset.motion)
      ).toBe("full");
      await setExitGuardScale(page, 5);
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
        await watchExitStart(panel);
        const stretchedBefore = await stretchedGuards(page);
        await ask();
        // when the exit animation begins the panel is still there, closing, and the animation lasts 200 ms
        await expect
          .poll(() => exitStart(page), { message: "a saída animada começou" })
          .toEqual({ closing: true, duration: 200, open: true });
        // the stretch reached the guard of this exit (the counter is cumulative, so it is compared with its value before
        // the way out was asked for): without it nothing here would fail
        expect(await stretchedGuards(page)).toBeGreaterThan(stretchedBefore);
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
      await watchExitStart(panel, more);
      await close();
      // the trigger was clicked at the start of the exit, which is what this case is about
      await expect
        .poll(() => exitStart(page), { message: "a saída animada começou" })
        .toEqual({ closing: true, duration: 200, open: true });
      // longer than the stretched guard (1.5 s): a close that was only postponed would have happened by now
      await page.waitForTimeout(1700);
      expect(
        await panel.evaluate((node: HTMLDialogElement) => ({
          closing: node.hasAttribute("data-closing"),
          open: node.open,
        }))
      ).toEqual({ closing: false, open: true });
      await close();
      await expect(panel).toBeHidden();
      // no `animationend` (a browser that skips the animation): the real guard of 300 ms closes it
      await setExitGuardScale(page, 1);
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
