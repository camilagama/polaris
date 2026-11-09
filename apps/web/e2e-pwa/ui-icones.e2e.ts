/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { COLOR_SCHEME, SCREENS, VIEWPORTS } from "./ui-screens";

/**
 * Icons come in three sizes, 12 (in a chip), 16 (the default) and 18 (the phone's bar and the tabs), always with a
 * stroke of 2, so a screen does not mix five sizes and two weights. Every Lucide `svg` drawn on the screens of the
 * start, the result, the history, the stock and the settings is measured; one with another width or stroke is
 * reported with where it is.
 */
const ICON_SIZES = [12, 16, 18] as const;
const ICON_STROKE = 2;

const SWEPT = [
  "início ",
  "resultado ",
  "histórico ",
  "estoque ",
  "aparelhos ",
  "perfis de pagamento ",
  "catálogo público ",
  "pendências ",
  "assinatura ",
];

interface IconFault {
  at: string;
  stroke: number;
  width: number;
}

async function iconFaults(
  page: Page,
  sizes: readonly number[] = ICON_SIZES,
  stroke: number = ICON_STROKE
): Promise<string[]> {
  const found = await page.evaluate(() =>
    [...document.querySelectorAll("svg.lucide")]
      .map((svg): IconFault | null => {
        const box = svg.getBoundingClientRect();
        if (box.width === 0) {
          return null;
        }
        const label = (element: Element | null) =>
          element?.getAttribute("aria-label") ||
          element?.textContent?.trim().slice(0, 24) ||
          element?.tagName.toLowerCase() ||
          "";
        const host = svg.closest("button, a, li, p, h1, h2, h3, span, div");
        return {
          at: `${svg.getAttribute("class")?.split(" ").at(1) ?? "svg"} em ${label(host)}`,
          stroke: Number.parseFloat(getComputedStyle(svg).strokeWidth),
          width: Math.round(box.width * 100) / 100,
        };
      })
      .filter((fault): fault is IconFault => fault !== null)
  );
  return found
    .filter((icon) => !sizes.includes(icon.width) || icon.stroke !== stroke)
    .map((icon) => `${icon.at}: ${icon.width}px, traço ${icon.stroke}`);
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

test("o controle reprova um ícone de 14 px, um de 20 px e um traço de 2,5", async ({
  page,
}) => {
  await page.setContent(
    `<svg class="lucide lucide-a" width="14" height="14" stroke-width="2"></svg>
     <svg class="lucide lucide-b" width="20" height="20" stroke-width="2"></svg>
     <svg class="lucide lucide-c" width="12" height="12" stroke-width="2.5"></svg>
     <svg class="lucide lucide-d" width="16" height="16" stroke-width="2"></svg>`
  );
  expect(await iconFaults(page)).toEqual([
    "lucide-a em : 14px, traço 2",
    "lucide-b em : 20px, traço 2",
    "lucide-c em : 12px, traço 2.5",
  ]);
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

      test("todo ícone tem 12, 16 ou 18 px e traço 2", async ({ page }) => {
        await screen.open(page, page.context());
        expect(await iconFaults(page)).toEqual([]);
      });
    });
  }
}
