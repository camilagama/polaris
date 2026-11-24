/// <reference lib="dom" />

import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { axeFaults } from "../../e2e-pwa/ui-guardrails/measures";
import {
  assertNoPageScroll,
  assertNothingClipped,
  expectReflowFont,
  openReflowViewport,
  reflowTest,
} from "../reflow";
import { FakeServer, goal, openHome, placeOf, region, SOLD } from "./shared";

const POSITION = /\d de \d/;
/** The page's rule for `prefers-reduced-motion` leaves a hair of a duration, not a zero (theme.css). */
const NO_DURATION = /^(?:0s|1e-05s)$/;

const progress = (percent: string) => ({
  percent,
  periodEnded: false,
  reached: false,
  value: "1000.00",
});

const named = (n: number, name: string, percent: string) =>
  goal({
    id: `0199c2d0-0000-7000-8000-00000000030${n}`,
    name,
    progress: progress(percent),
  });

/** Three active goals, in the order the server may send them: 20 %, 85 % and 60 %. */
const THREE = [
  named(1, "Vendas de novembro", "20.0"),
  named(2, "Meta da loja", "85.0"),
  named(3, "Pedidos do mês", "60.0"),
];

const withGoals = (goals: unknown[]) => new FakeServer({ ...SOLD, goals });

const openGoalName = (meta: Locator) =>
  meta.locator('[data-goal-slide="open"] p.font-medium');

const next = (meta: Locator) =>
  meta.getByRole("button", { name: "Próxima meta" });
const previous = (meta: Locator) =>
  meta.getByRole("button", { name: "Meta anterior" });

async function height(meta: Locator) {
  return (await placeOf(meta)).height;
}

async function swipe(page: Page, slides: Locator, dx: number, dy = 0) {
  const box = await slides.boundingBox();
  const x = (box?.x ?? 0) + (box?.width ?? 0) / 2;
  const y = (box?.y ?? 0) + 40;
  const base = { isPrimary: true, pointerId: 7, pointerType: "touch" };
  await slides.dispatchEvent("pointerdown", {
    ...base,
    clientX: x,
    clientY: y,
  });
  await slides.dispatchEvent("pointerup", {
    ...base,
    clientX: x + dx,
    clientY: y + dy,
  });
  await page.evaluate(() => undefined);
}

test.describe("a Meta do Início em carrossel", () => {
  test("abre pela mais perto de ser batida e a seta leva à de 60 % e depois à de 20 %", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await openHome(page, withGoals(THREE));
    const meta = region(page, "Meta");
    await expect(openGoalName(meta)).toHaveText("Meta da loja");
    await expect(meta).toContainText("1 de 3");
    await next(meta).click();
    await expect(openGoalName(meta)).toHaveText("Pedidos do mês");
    await expect(meta).toContainText("2 de 3");
    await next(meta).click();
    await expect(openGoalName(meta)).toHaveText("Vendas de novembro");
    await expect(meta).toContainText("3 de 3");
    await previous(meta).click();
    await expect(openGoalName(meta)).toHaveText("Pedidos do mês");
  });

  test("as setas sem destino ficam, desligadas, e a troca é anunciada", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await openHome(page, withGoals(THREE));
    const meta = region(page, "Meta");
    const announcement = meta.locator("[data-goal-announcement]");
    await expect(previous(meta)).toHaveAttribute("aria-disabled", "true");
    await expect(next(meta)).not.toHaveAttribute("aria-disabled", "true");
    await expect(announcement).toHaveText("");
    await next(meta).click();
    await expect(announcement).toHaveText("Meta 2 de 3: Pedidos do mês");
    await next(meta).click();
    await expect(announcement).toHaveText("Meta 3 de 3: Vendas de novembro");
    await expect(next(meta)).toHaveAttribute("aria-disabled", "true");
    await expect(previous(meta)).not.toHaveAttribute("aria-disabled", "true");
    await next(meta).focus();
    await page.keyboard.press("Enter");
    await expect(openGoalName(meta)).toHaveText("Vendas de novembro");
    await expect(next(meta)).toBeFocused();
  });

  test("o teclado troca a meta, o foco fica na seta e só a meta aberta entra na leitura", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await openHome(page, withGoals(THREE));
    const meta = region(page, "Meta");
    await next(meta).focus();
    await page.keyboard.press("Enter");
    await expect(openGoalName(meta)).toHaveText("Pedidos do mês");
    await expect(next(meta)).toBeFocused();
    await page.keyboard.press("Space");
    await expect(openGoalName(meta)).toHaveText("Vendas de novembro");
    await expect(next(meta)).toBeFocused();
    await expect(meta.locator('[data-goal-slide="closed"]')).toHaveCount(2);
    await expect(meta.getByRole("img")).toHaveCount(1);
    expect(await axeFaults(page, "#home-goal")).toEqual([]);
  });

  test("a altura do bloco é a mesma nas três metas, também com um nome que quebra em linhas", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    const longName =
      "Meta de vendas líquidas da loja do centro e do shopping para a temporada de fim de ano";
    await openHome(
      page,
      withGoals([
        THREE[0],
        named(2, longName, "85.0"),
        named(3, "Pedidos do mês", "60.0"),
      ])
    );
    const meta = region(page, "Meta");
    await expect(openGoalName(meta)).toHaveText(longName);
    const heights = [await height(meta)];
    await next(meta).click();
    heights.push(await height(meta));
    await next(meta).click();
    heights.push(await height(meta));
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(1);
  });

  test("com uma meta só não há setas nem contador, e o pé continua a única saída", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await openHome(page, withGoals([THREE[1]]));
    const meta = region(page, "Meta");
    await expect(meta.getByRole("img")).toBeVisible();
    await expect(meta.locator("[data-goal-stepper]")).toHaveCount(0);
    await expect(meta).not.toContainText(POSITION);
    await expect(meta.getByRole("link", { name: "Ver as metas" })).toHaveCount(
      1
    );
  });

  test("com três metas o pé diz Ver as 3 metas e é o único link do bloco", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await openHome(page, withGoals(THREE));
    const links = region(page, "Meta").getByRole("link");
    await expect(links).toHaveCount(1);
    await expect(links).toHaveText("Ver as 3 metas");
  });

  test("a meta vista não é guardada: ao abrir de novo, abre pela regra", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    const server = withGoals(THREE);
    await openHome(page, server);
    const meta = region(page, "Meta");
    await next(meta).click();
    await expect(openGoalName(meta)).toHaveText("Pedidos do mês");
    await page.reload();
    await expect(openGoalName(region(page, "Meta"))).toHaveText("Meta da loja");
  });
});

test.describe("o movimento da troca da Meta", () => {
  for (const [setting, duration, label] of [
    ["no-preference", "0.15s", "150 ms"],
    ["reduce", NO_DURATION, "nada"],
  ] as const) {
    test(`no desktop com reducedMotion ${setting}, a troca dura ${label}`, async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: setting });
      await page.setViewportSize({ height: 800, width: 1280 });
      await openHome(page, withGoals(THREE));
      const meta = region(page, "Meta");
      await expect(openGoalName(meta)).toHaveText("Meta da loja");
      await expect(meta.locator("[data-goal-slide]").first()).toHaveCSS(
        "transition-duration",
        duration
      );
    });
  }
});

test.describe("a Meta em carrossel no toque", () => {
  test.use({ hasTouch: true });

  test("arrastar para o lado troca a meta e um gesto na vertical não troca", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await openHome(page, withGoals(THREE));
    const meta = region(page, "Meta");
    const slides = meta.locator("[data-goal-slides]");
    await expect(openGoalName(meta)).toHaveText("Meta da loja");
    await expect(slides).toHaveCSS("touch-action", "pan-y");
    await swipe(page, slides, -90);
    await expect(openGoalName(meta)).toHaveText("Pedidos do mês");
    await swipe(page, slides, 90);
    await expect(openGoalName(meta)).toHaveText("Meta da loja");
    await swipe(page, slides, 10, 120);
    await swipe(page, slides, 30);
    await expect(openGoalName(meta)).toHaveText("Meta da loja");
    await swipe(page, slides, 90);
    await expect(openGoalName(meta)).toHaveText("Meta da loja");
  });

  test("o navegador que assume a rolagem cancela o gesto, e um segundo dedo não o reinicia", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await openHome(page, withGoals(THREE));
    const meta = region(page, "Meta");
    const slides = meta.locator("[data-goal-slides]");
    const box = await slides.boundingBox();
    const x = (box?.x ?? 0) + (box?.width ?? 0) / 2;
    const y = (box?.y ?? 0) + 40;
    const finger = { pointerType: "touch" };
    await slides.dispatchEvent("pointerdown", {
      ...finger,
      clientX: x,
      clientY: y,
      isPrimary: true,
      pointerId: 7,
    });
    await slides.dispatchEvent("pointercancel", {
      ...finger,
      isPrimary: true,
      pointerId: 7,
    });
    await slides.dispatchEvent("pointerup", {
      ...finger,
      clientX: x - 120,
      clientY: y,
      isPrimary: true,
      pointerId: 7,
    });
    await expect(openGoalName(meta)).toHaveText("Meta da loja");
    await slides.dispatchEvent("pointerdown", {
      ...finger,
      clientX: x,
      clientY: y,
      isPrimary: true,
      pointerId: 8,
    });
    await slides.dispatchEvent("pointerdown", {
      ...finger,
      clientX: x - 150,
      clientY: y,
      isPrimary: false,
      pointerId: 9,
    });
    await slides.dispatchEvent("pointerup", {
      ...finger,
      clientX: x + 10,
      clientY: y,
      isPrimary: true,
      pointerId: 8,
    });
    await expect(openGoalName(meta)).toHaveText("Meta da loja");
  });

  test("as setas têm alvo de 44 px e a troca é seca no celular", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await openHome(page, withGoals(THREE));
    const meta = region(page, "Meta");
    const targets = await Promise.all(
      [previous(meta), next(meta)].map((button) =>
        button.evaluate((element) => {
          const hit = getComputedStyle(element, "::before");
          return {
            height: Number.parseFloat(hit.height),
            width: Number.parseFloat(hit.width),
          };
        })
      )
    );
    for (const target of targets) {
      expect(target.height).toBeGreaterThanOrEqual(44);
      expect(target.width).toBeGreaterThanOrEqual(44);
    }
    const slide = meta.locator("[data-goal-slide]").first();
    await expect(slide).toHaveCSS("transition-duration", "0s");
  });
});

test.describe("Meta em carrossel a 320 px com a letra do navegador em 20 px", () => {
  reflowTest(
    "o título, o contador, as setas e o percentual do anel cabem, sem corte nem rolagem",
    async ({ page }) => {
      await openReflowViewport(page, { fontPixels: 20, width: 320 });
      await openHome(page, withGoals(THREE));
      await expectReflowFont(page, 20);
      const meta = region(page, "Meta");
      await expect(meta.locator('[data-goal-slide="open"]')).toContainText(
        "85,0%"
      );
      await expect(meta).toContainText("1 de 3");
      await expect(previous(meta)).toBeVisible();
      await expect(next(meta)).toBeVisible();
      await assertNothingClipped(meta);
      await assertNoPageScroll(page);
      const box = await meta.boundingBox();
      const inners = await Promise.all(
        [
          meta.getByRole("heading", { name: "Meta" }),
          previous(meta),
          next(meta),
        ].map((part) => part.boundingBox())
      );
      for (const inner of inners) {
        expect(inner?.x ?? 0).toBeGreaterThanOrEqual((box?.x ?? 0) - 1);
        expect((inner?.x ?? 0) + (inner?.width ?? 0)).toBeLessThanOrEqual(
          (box?.x ?? 0) + (box?.width ?? 0) + 1
        );
      }
      const before = await height(meta);
      await next(meta).click();
      await expect(meta).toContainText("2 de 3");
      expect(Math.abs((await height(meta)) - before)).toBeLessThan(1);
    }
  );
});
