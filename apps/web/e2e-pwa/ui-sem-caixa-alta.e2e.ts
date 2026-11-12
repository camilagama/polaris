/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { COLOR_SCHEME, SCREENS, VIEWPORTS } from "./ui-screens";

/**
 * The app has no capital letters set by the style: a label is written in sentence case and shown as written.
 * Every visible element of the screens of the start, the result and its tabs, the history, the detail, the stock,
 * the products, the customers, the expenses, the settings and the subscription is read with `getComputedStyle`;
 * one with `text-transform: uppercase` is reported with the text it holds.
 */
const SWEPT = [
  "início ",
  "resultado ",
  "histórico ",
  "detalhe da ",
  "estoque ",
  "produtos ",
  "clientes ",
  "despesas ",
  "categorias ",
  "aparelhos ",
  "perfis de pagamento ",
  "catálogo público ",
  "pendências ",
  "assinatura ",
];

function uppercaseFaults(page: Page) {
  return page.evaluate(() => {
    const found: string[] = [];
    let measured = 0;
    for (const element of document.body.querySelectorAll("*")) {
      if (!element.checkVisibility()) {
        continue;
      }
      measured += 1;
      if (getComputedStyle(element).textTransform === "uppercase") {
        const text = (element.textContent ?? "").trim().slice(0, 40);
        found.push(`${element.tagName.toLowerCase()} "${text}"`);
      }
    }
    return { found, measured };
  });
}

const CONTEXTS = [
  { theme: "claro", touch: true, viewport: "360" },
  { theme: "claro", touch: false, viewport: "1280" },
] as const;

test.describe.configure({ mode: "parallel" });

test.beforeEach(({ browserName }, testInfo) => {
  test.skip(
    browserName !== "chromium" || testInfo.project.name !== "chromium-desktop",
    "the screens set their own viewports and touch"
  );
});

const swept = SCREENS.filter((screen) =>
  SWEPT.some((prefix) => screen.name.startsWith(prefix))
);

test("a varredura cobre as telas do corte, não uma lista vazia", () => {
  expect(swept.length).toBeGreaterThan(40);
  for (const prefix of SWEPT) {
    expect(
      swept.some((screen) => screen.name.startsWith(prefix)),
      prefix
    ).toBe(true);
  }
});

test("o controle acha o texto em caixa alta e ignora o que não se vê", async ({
  page,
}) => {
  await page.setContent(
    `<main>
       <p id="a" style="text-transform: uppercase">Total do período</p>
       <p style="text-transform: uppercase; display: none">Escondido</p>
       <p style="text-transform: none">Total do período</p>
     </main>`
  );
  const { found, measured } = await uppercaseFaults(page);
  expect(measured).toBe(3);
  expect(found).toEqual(['p "Total do período"']);
});

for (const screen of swept) {
  for (const { theme, touch, viewport } of CONTEXTS) {
    test.describe(`${screen.name} · ${viewport} px`, () => {
      test.use({
        colorScheme: COLOR_SCHEME[theme],
        hasTouch: touch,
        isMobile: touch,
        viewport: VIEWPORTS[viewport],
      });

      test("nenhum elemento visível está em caixa alta", async ({ page }) => {
        await screen.open(page, page.context());
        const { found, measured } = await uppercaseFaults(page);
        expect(measured).toBeGreaterThan(0);
        expect(found).toEqual([]);
      });
    });
  }
}
