/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  assertNothingClipped,
  expectReflowFont,
  openReflowViewport,
  skipOutsideChromium,
} from "../e2e/reflow";

/**
 * `Money` in the gallery (`/ui-galeria`, sections "Dinheiro" and "Cartão de KPI e Esconder valores"): hiding the values
 * changes the words and nothing about the type. In `lg` and `xl` the font size, the weight and the color of the "R$"
 * and of the number are the same with the amount showing and hidden, at 360 and at 1280 px, in both themes; the hidden
 * page has no digit of an amount in its text, its names or its titles, and says "valor escondido"; "R$" and number never
 * fall on two lines at 320 px with the browser font at 20 px, from `sm` to `xl`.
 */
skipOutsideChromium();

const VIEWPORTS = [
  { height: 740, name: "360", width: 360 },
  { height: 800, name: "1280", width: 1280 },
] as const;
const THEMES = ["claro", "escuro"] as const;
const SIZES = ["sm", "md", "lg", "xl"] as const;
const DIGIT = /\d/;

interface Typography {
  color: string;
  fontSize: string;
  fontWeight: string;
}

async function openGallery(page: Page, theme: string) {
  await page.addInitScript((stored) => {
    window.localStorage.setItem("polaris-tema", stored);
  }, theme);
  await page.goto("/ui-galeria");
  await expect(
    page.getByRole("heading", { name: "Galeria da interface" })
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

const hideValues = (page: Page) =>
  page.getByRole("main").getByRole("button", { name: "Esconder valores" });

/** The type of the "R$" and of the number of each amount of `lg` and `xl` of the gallery, and of the hero values of its cards. */
async function measure(page: Page) {
  return await page.evaluate(() => {
    const read = (element: Element): Typography => {
      const style = getComputedStyle(element);
      return {
        color: style.color,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
      };
    };
    const roots = [
      ...document.querySelectorAll(
        "[data-gallery-money] p:nth-child(n+3) [data-money], [data-kpi-value] [data-money]"
      ),
    ];
    return roots.map((root) => ({
      negative: root.textContent?.startsWith("-") ?? false,
      currency: read(root.querySelector("[data-money-currency]") as Element),
      number: read(root.querySelector("[data-money-number]") as Element),
    }));
  });
}

for (const theme of THEMES) {
  for (const viewport of VIEWPORTS) {
    test(`o R$ e o número mantêm tamanho, peso e cor ao esconder (${viewport.name}, ${theme})`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await openGallery(page, theme);
      const toggle = hideValues(page);
      await expect(toggle).toHaveAttribute("aria-pressed", "false");

      const shown = await measure(page);
      // lg and xl, two amounts each, and the two hero values of the cards
      expect(shown).toHaveLength(6);
      for (const amount of shown) {
        expect(Number.parseFloat(amount.currency.fontSize)).toBeLessThan(
          Number.parseFloat(amount.number.fontSize)
        );
        expect(amount.currency.fontWeight).toBe("500");
        expect(amount.currency.color).toBe(amount.number.color);
      }

      await toggle.scrollIntoViewIfNeeded();
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator("[data-masked-money]").first()).toBeVisible();

      const masked = await measure(page);
      expect(masked).toHaveLength(shown.length);
      masked.forEach((amount, index) => {
        const before = shown[index] as (typeof shown)[number];
        expect(amount.currency.fontSize).toBe(before.currency.fontSize);
        expect(amount.currency.fontWeight).toBe(before.currency.fontWeight);
        expect(amount.number.fontSize).toBe(before.number.fontSize);
        expect(amount.number.fontWeight).toBe(before.number.fontWeight);
        expect(amount.currency.color).toBe(amount.number.color);
        // the color of a negative is a hint of the sign, so it does not survive the mask
        expect(amount.number.color).toBe(
          before.negative
            ? (shown[0] as (typeof shown)[number]).number.color
            : before.number.color
        );
      });
    });
  }
}

test("escondido, os valores da galeria não têm dígito no texto, no nome nem no título, e dizem 'valor escondido'", async ({
  page,
}) => {
  await page.setViewportSize(VIEWPORTS[0]);
  await openGallery(page, "claro");
  await hideValues(page).click();
  const dinheiro = page.getByRole("region", { name: "Dinheiro" });
  await expect(dinheiro.locator("[data-money]")).toHaveCount(8);
  const scopes = [
    dinheiro,
    page.getByRole("region", { name: "Cartão de KPI e Esconder valores" }),
  ];
  const found = await Promise.all(
    scopes.map((scope) =>
      scope.locator("[data-money]").evaluateAll((roots) =>
        roots.map((root) => ({
          names: `${root.getAttribute("aria-label") ?? ""}${root.getAttribute("title") ?? ""}`,
          spoken: root.nextElementSibling?.textContent ?? "",
          text: (root as HTMLElement).innerText,
        }))
      )
    )
  );
  for (const amounts of found) {
    expect(amounts.length).toBeGreaterThan(0);
    for (const amount of amounts) {
      expect(`${amount.text}${amount.names}`).not.toMatch(DIGIT);
      expect(amount.spoken).toBe("valor escondido");
    }
  }
});

/** Where each amount of the section sits: on one line, with the "R$" and the number side by side. */
async function amountLines(page: Page) {
  const dinheiro = page.getByRole("region", { name: "Dinheiro" });
  return await dinheiro.locator("[data-money]").evaluateAll((amounts) =>
    amounts.map((amount) => {
      const box = (element: Element | null) =>
        element?.getBoundingClientRect() ?? null;
      const first = box(
        amount.querySelector("[data-money-currency]") ?? amount
      );
      const last = box(amount.querySelector("[data-money-number]") ?? amount);
      return {
        inside: amount.getBoundingClientRect().right <= window.innerWidth,
        lines: amount.getClientRects().length,
        sameLine: Boolean(
          first && last && last.top < first.bottom && first.top < last.bottom
        ),
      };
    })
  );
}

async function expectOneLine(page: Page) {
  const lines = await amountLines(page);
  expect(lines).toHaveLength(SIZES.length * 2);
  expect(
    lines.filter((line) => line.lines !== 1 || !line.sameLine || !line.inside)
  ).toEqual([]);
  await assertNothingClipped(page.getByRole("region", { name: "Dinheiro" }));
}

test("R$ e número ficam na mesma linha a 320 px com a fonte do navegador em 20 px, de sm a xl, visíveis e escondidos", async ({
  page,
}) => {
  await openReflowViewport(page);
  await openGallery(page, "claro");
  await expectReflowFont(page);
  await expectOneLine(page);
  await hideValues(page).click();
  await expect(page.locator("[data-masked-money]").first()).toBeVisible();
  await expectOneLine(page);
});
