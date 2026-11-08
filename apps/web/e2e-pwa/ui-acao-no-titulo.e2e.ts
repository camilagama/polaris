/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { SCREENS, VIEWPORTS } from "./ui-screens";

/**
 * The main action of a screen sits on the line of its title: at the right of it with a mouse (760 px and more), right
 * under it and as wide as the screen on a phone, before any card and never inside one. It is the first control after
 * the title in the tab order. "Importar planilha" is the outline button beside "Novo produto" on the wide screen and,
 * on a phone, comes after the list instead of stacking a second 44 px button under the first.
 */
const LINE_GAP = 16;

const ACTIONS = [
  { action: "Novo cliente", heading: "Clientes", screen: "clientes lista" },
  { action: "Novo produto", heading: "Produtos", screen: "produtos lista" },
  { action: "Nova despesa", heading: "Despesas", screen: "despesas lista" },
  {
    action: "Novo perfil",
    heading: "Formas de receber",
    screen: "perfis de pagamento lista",
  },
] as const;

const CONTEXTS = [
  { name: "1280 com mouse", touch: false, viewport: VIEWPORTS["1280"] },
  { name: "360 com toque", touch: true, viewport: VIEWPORTS["360"] },
] as const;

interface Geometry {
  afterTitleInTabOrder: boolean;
  beforeAnyCard: boolean;
  button: { bottom: number; left: number; right: number; top: number };
  inCard: boolean;
  title: { bottom: number; left: number; right: number; top: number };
  viewportWidth: number;
}

function geometryOf(
  page: Page,
  action: string,
  heading: string
): Promise<Geometry> {
  return page.evaluate(
    ([name, headingText]) => {
      const everything = [...document.querySelectorAll("*")];
      const precedes = (first: Element, second: Element) =>
        everything.indexOf(first) < everything.indexOf(second);
      const title = [...document.querySelectorAll("h1")].find(
        (candidate) => candidate.textContent?.trim() === headingText
      ) as HTMLElement;
      const button = [...document.querySelectorAll("button")].find(
        (candidate) => candidate.textContent?.trim() === name
      ) as HTMLElement;
      const card = document.querySelector('[data-slot="card"]');
      const box = (element: Element) => {
        const { bottom, left, right, top } = element.getBoundingClientRect();
        return { bottom, left, right, top };
      };
      const next = [
        ...document.querySelectorAll<HTMLElement>("button, a[href], input"),
      ].find(
        (control) =>
          !control.hasAttribute("disabled") && precedes(title, control)
      );
      return {
        afterTitleInTabOrder:
          next !== undefined && (title.parentElement?.contains(next) ?? false),
        beforeAnyCard: card === null || precedes(button, card),
        button: box(button),
        inCard: button.closest('[data-slot="card"]') !== null,
        title: box(title),
        viewportWidth: innerWidth,
      };
    },
    [action, heading] as const
  );
}

test.beforeEach(({ browserName }, testInfo) => {
  test.skip(
    browserName !== "chromium" || testInfo.project.name !== "chromium-desktop",
    "the matrix sets its own viewports and touch"
  );
});

for (const { action, heading, screen: screenName } of ACTIONS) {
  const screen = SCREENS.find((candidate) => candidate.name === screenName);
  for (const context of CONTEXTS) {
    test.describe(`${screenName} · ${context.name}`, () => {
      test.use({
        hasTouch: context.touch,
        isMobile: context.touch,
        viewport: context.viewport,
      });

      test(`${action} fica na linha do título, fora de cartão`, async ({
        page,
      }) => {
        expect(
          screen,
          `a tela "${screenName}" não está em SCREENS`
        ).toBeDefined();
        await screen?.open(page, page.context());
        const shape = await geometryOf(page, action, heading);
        expect(shape.inCard, "dentro de um cartão").toBe(false);
        expect(shape.beforeAnyCard, "depois de um cartão").toBe(true);
        expect(shape.afterTitleInTabOrder, "logo depois do título no Tab").toBe(
          true
        );
        expect(shape.button.top).toBeLessThanOrEqual(
          shape.title.bottom + LINE_GAP
        );
        if (context.touch) {
          expect(shape.button.top, "abaixo do título").toBeGreaterThanOrEqual(
            shape.title.bottom - 1
          );
          expect(
            shape.button.right - shape.button.left,
            "largura da tela"
          ).toBeGreaterThan(shape.viewportWidth - 48);
        } else {
          expect(shape.button.left, "à direita do título").toBeGreaterThan(
            shape.title.right
          );
          expect(shape.button.right, "na borda direita").toBeGreaterThan(
            shape.viewportWidth / 2
          );
        }
      });
    });
  }
}

const PRODUCTS = SCREENS.find(
  (candidate) => candidate.name === "produtos lista"
);
const importButton = (page: Page) =>
  page.getByRole("button", { name: "Importar planilha" });

test.describe("Importar planilha · 1280 com mouse", () => {
  test.use({ hasTouch: false, viewport: VIEWPORTS["1280"] });

  test("é o botão de contorno ao lado de Novo produto, na mesma linha", async ({
    page,
  }) => {
    await PRODUCTS?.open(page, page.context());
    const shape = await geometryOf(page, "Novo produto", "Produtos");
    const box = await importButton(page).boundingBox();
    expect(box).not.toBeNull();
    const imported = box as NonNullable<typeof box>;
    expect(Math.abs(imported.y - shape.button.top)).toBeLessThanOrEqual(2);
    expect(imported.x + imported.width).toBeLessThanOrEqual(shape.button.left);
  });
});

test.describe("Importar planilha · 360 com toque", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: VIEWPORTS["360"] });

  test("não empilha um segundo botão de 44 px e abre com um toque", async ({
    page,
  }) => {
    await PRODUCTS?.open(page, page.context());
    const shape = await geometryOf(page, "Novo produto", "Produtos");
    const box = await importButton(page).boundingBox();
    expect(box).not.toBeNull();
    const imported = box as NonNullable<typeof box>;
    expect(
      imported.y,
      "o botão de importar está colado embaixo do Novo produto"
    ).toBeGreaterThan(shape.button.bottom + 100);
    await importButton(page).tap();
    await expect(
      page.getByRole("dialog", { name: "Importar planilha" })
    ).toBeVisible();
  });
});

test.describe("Nova despesa · a partir de outra parte da tela", () => {
  test.use({ hasTouch: false, viewport: VIEWPORTS["1280"] });

  test("volta para Lançamentos e abre o formulário, com o resultado à vista", async ({
    page,
  }) => {
    const screen = SCREENS.find(
      (candidate) => candidate.name === "despesas lista"
    );
    await screen?.open(page, page.context());
    await page.getByRole("tab", { name: "Recorrentes" }).click();
    await expect(
      page.getByRole("tab", { name: "Recorrentes" })
    ).toHaveAttribute("aria-selected", "true");
    await page
      .getByRole("button", { exact: true, name: "Nova despesa" })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Nova despesa" })
    ).toBeVisible();
    await expect(
      page.locator('[role="tab"]', { hasText: "Lançamentos" })
    ).toHaveAttribute("aria-selected", "true");
  });
});
