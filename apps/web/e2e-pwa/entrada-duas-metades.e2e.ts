/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { entryStates } from "./ui-entry-states";
import { axeFaults } from "./ui-guardrails/measures";

/**
 * A entrada em duas metades a partir de 1024 px (S-50): a metade direita só decora, o cartão fica onde estava (no
 * alto, a 96 px) em todos os estados, e abaixo de 1024 px a página é a de uma coluna de antes.
 */
const CARD_TOP = 96;
const TOLERANCE = 1;
const ART = '[data-entry-art=""]';
const PHRASE =
  "Vendas, estoque e resultado da sua loja, no celular e sem internet.";

test.beforeEach(({ browserName }, testInfo) => {
  test.skip(
    browserName !== "chromium" || testInfo.project.name !== "chromium-desktop",
    "layout de desktop, medido uma vez"
  );
});

const cardBox = (page: Page) =>
  page.locator('main [data-slot="card"]').first().boundingBox();

async function open(page: Page, width: number) {
  await page.setViewportSize({ height: 800, width });
  await entryStates.signIn(page);
}

test("a 1023 px a tela é de uma coluna e a metade direita não existe para ninguém", async ({
  page,
}) => {
  await open(page, 1023);
  await expect(page.locator(ART)).toBeHidden();
  await expect(page.getByText(PHRASE)).toBeHidden();
  const box = await cardBox(page);
  expect(box?.width).toBeCloseTo(380, 0);
  const middle = 1023 / 2;
  expect((box?.x ?? 0) + (box?.width ?? 0) / 2).toBeCloseTo(middle, 0);
  expect(box?.y).toBeCloseTo(CARD_TOP, 0);
});

test("a 1024 px há duas metades: o cartão de 380 px no alto da esquerda, o painel de altura inteira à direita", async ({
  page,
}) => {
  await open(page, 1024);
  const art = page.locator(ART);
  await expect(art).toBeVisible();
  const panel = await art.boundingBox();
  expect(panel).toMatchObject({ height: 800, width: 512, x: 512, y: 0 });
  const card = await cardBox(page);
  expect(card?.width).toBeCloseTo(380, 0);
  expect((card?.x ?? 0) + (card?.width ?? 0) / 2).toBeCloseTo(256, 0);
  expect(card?.y).toBeCloseTo(CARD_TOP, 0);
  await expect(art.locator('svg[data-skeleton-art="home"]')).toBeVisible();
  await expect(art.getByText(PHRASE)).toBeVisible();
});

const STATES = [
  ["só o Google", entryStates.googleOnly],
  ["entrar", entryStates.signIn],
  ["e-mail incompleto", entryStates.signInEmailIncomplete],
  ["e-mail completo (senha aberta)", entryStates.signInEmailComplete],
  ["preenchido pelo gerenciador", entryStates.signInFilled],
  ["desafio bloqueado", entryStates.signInBlocked],
  ["senha incorreta", entryStates.signInIncorrect],
  ["pausado", entryStates.signInPaused],
  ["sem conexão, sessão acabou", entryStates.signInOffline],
  ["criar conta", entryStates.signUp],
  ["criar conta, aceite faltando", entryStates.signUpAcceptMissing],
  ["criar conta, desafio bloqueado", entryStates.signUpBlocked],
  ["criar conta, regra recusada", entryStates.signUpRuleRefused],
  ["criar conta, confirme seu e-mail", entryStates.signUpConfirm],
] as const;

for (const [name, state] of STATES) {
  test(`o cartão fica a 96 px do topo, crescer não o move: ${name}`, async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await state(page, page.context());
    const box = await cardBox(page);
    expect(Math.abs((box?.y ?? Number.NaN) - CARD_TOP)).toBeLessThanOrEqual(
      TOLERANCE
    );
  });
}

test("a metade direita não tem nada focável nem nome acessível, e o Tab é o de uma coluna", async ({
  page,
}) => {
  await open(page, 1280);
  const art = await page.evaluate((selector) => {
    const root = document.querySelector(selector);
    return {
      focusable: root?.querySelectorAll(
        'a, button, input, select, textarea, [tabindex], [contenteditable=""], [contenteditable="true"]'
      ).length,
      hidden: root?.getAttribute("aria-hidden"),
      named: root?.querySelectorAll("[aria-label], [aria-labelledby], title")
        .length,
    };
  }, ART);
  expect(art).toEqual({ focusable: 0, hidden: "true", named: 0 });

  const activeName = () =>
    page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      return active?.closest("[data-entry-art]")
        ? "ART"
        : ((active?.textContent?.trim() ||
            active?.getAttribute("aria-label") ||
            active?.tagName) ??
            "");
    });
  const order = async () => {
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    return [1, 2, 3, 4, 5, 6].reduce(
      async (done, _step) => {
        const names = await done;
        await page.keyboard.press("Tab");
        return [...names, await activeName()];
      },
      Promise.resolve([] as string[])
    );
  };
  const wide = await order();
  expect(wide).not.toContain("ART");
  await open(page, 1023);
  expect(await order()).toEqual(wide);
  expect(await axeFaults(page)).toEqual([]);
});

async function mediaRequestsAt(page: Page, width: number) {
  const fresh = await page.context().newPage();
  const urls: string[] = [];
  fresh.on("request", (request) => {
    const type = request.resourceType();
    if (type === "image" || type === "font" || type === "media") {
      urls.push(`${type} ${request.url()}`);
    }
  });
  await fresh.setViewportSize({ height: 800, width });
  await entryStates.signIn(fresh);
  await fresh.close();
  return urls;
}

test("nenhuma requisição a mais: nem imagem, nem fonte, nem mídia a 1280 px em relação a 1023 px", async ({
  page,
}) => {
  const [narrow, wide] = await Promise.all([
    mediaRequestsAt(page, 1023),
    mediaRequestsAt(page, 1280),
  ]);
  expect(wide).toEqual(narrow);
});

test("zoom de 200% a 1280 px (640 px úteis): cai numa coluna, sem rolagem horizontal", async ({
  page,
}) => {
  await open(page, 640);
  await expect(page.locator(ART)).toBeHidden();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
  const box = await cardBox(page);
  expect((box?.x ?? 0) + (box?.width ?? 0) / 2).toBeCloseTo(320, 0);
});

for (const scheme of ["light", "dark"] as const) {
  test(`a frase usa --foreground sobre --muted, tema ${scheme} (a razão está em contraste-v5.1.md)`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await open(page, 1280);
    const painted = await page.locator(ART).evaluate((element) => {
      const resolve = (
        property: "background-color" | "color",
        token: string
      ) => {
        const probe = document.createElement("span");
        probe.style.setProperty(property, `var(${token})`);
        element.append(probe);
        const value = getComputedStyle(probe).getPropertyValue(property);
        probe.remove();
        return value;
      };
      const phrase = element.querySelector("p") as HTMLElement;
      return {
        background: getComputedStyle(element).backgroundColor,
        expectedBackground: resolve("background-color", "--muted"),
        expectedText: resolve("color", "--foreground"),
        text: getComputedStyle(phrase).color,
      };
    });
    expect(painted.background).toBe(painted.expectedBackground);
    expect(painted.text).toBe(painted.expectedText);
  });
}
