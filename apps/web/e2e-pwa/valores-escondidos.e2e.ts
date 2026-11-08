/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { skipOutsideChromium } from "../e2e/reflow";
import { expenseStates } from "./ui-expense-states";
import { historyStates } from "./ui-history-states";

/**
 * "Esconder valores" on the lists: with the choice on, the history and the expenses, with their totals, write no amount in reais in their
 * text, names, titles or alternative texts, and say "valor escondido" in its place; with it off, the "R$" is in the same
 * text, size and color as the number (`sm` and `md`), and the figures of the column end in the same x.
 */
skipOutsideChromium();

const VIEWPORTS = [
  { height: 740, name: "360", width: 360 },
  { height: 800, name: "1280", width: 1280 },
] as const;
const THEMES = ["claro", "escuro"] as const;
const REAIS = /R\$\s?\d/;
const WRITTEN_AMOUNT = /^R\$ [\d.]+,\d{2}$/;

const SCREENS = [
  { name: "Histórico", open: historyStates.list },
  { name: "Despesas", open: expenseStates.list },
] as const;

async function useDevice(
  page: Page,
  viewport: (typeof VIEWPORTS)[number],
  theme: (typeof THEMES)[number],
  hidden: boolean
) {
  await page.setViewportSize(viewport);
  await page.addInitScript(
    ({ stored, valores }) => {
      window.localStorage.setItem("polaris-tema", stored);
      if (valores) {
        window.localStorage.setItem("polaris-valores", "escondidos");
      }
    },
    { stored: theme, valores: hidden }
  );
}

/** Every place a screen reader or a search can read an amount: the text, and the names, titles and alternatives. */
async function amountsWritten(page: Page) {
  const written = await page.evaluate(() => {
    const texts: string[] = [document.body.innerText];
    for (const element of document.querySelectorAll(
      "[aria-label],[title],[alt]"
    )) {
      for (const name of ["aria-label", "title", "alt"]) {
        texts.push(element.getAttribute(name) ?? "");
      }
    }
    return texts;
  });
  return written.filter((text) => REAIS.test(text));
}

for (const theme of THEMES) {
  for (const viewport of VIEWPORTS) {
    for (const screen of SCREENS) {
      test(`${screen.name}: escondidos, nenhum valor em reais e "valor escondido" no lugar (${viewport.name}, ${theme})`, async ({
        page,
      }) => {
        await useDevice(page, viewport, theme, true);
        await screen.open(page);
        await expect(
          page.locator("[data-masked-money]").first()
        ).toBeAttached();
        expect(await amountsWritten(page)).toEqual([]);
        await expect(page.getByText("valor escondido").first()).toBeAttached();
      });

      test(`${screen.name}: visíveis, os valores aparecem inteiros (${viewport.name}, ${theme})`, async ({
        page,
      }) => {
        await useDevice(page, viewport, theme, false);
        await screen.open(page);
        await expect(page.locator("[data-masked-money]")).toHaveCount(0);
        expect(
          REAIS.test(await page.evaluate(() => document.body.innerText))
        ).toBe(true);
      });
    }
  }
}

for (const theme of THEMES) {
  for (const viewport of VIEWPORTS) {
    test(`Histórico: o R$ é do tamanho e da cor do número, e a coluna acaba no mesmo x (${viewport.name}, ${theme})`, async ({
      page,
    }) => {
      await useDevice(page, viewport, theme, false);
      await historyStates.list(page);
      const amounts = page
        .getByRole("list", { name: "Vendas" })
        .locator("[data-money]");
      expect(await amounts.count()).toBeGreaterThan(2);
      const measured = await amounts.evaluateAll((roots) =>
        roots.map((root) => {
          const style = getComputedStyle(root);
          return {
            apart: root.querySelector("[data-money-currency]") !== null,
            fontVariantNumeric: style.fontVariantNumeric,
            right: root.getBoundingClientRect().right,
            text: root.textContent ?? "",
          };
        })
      );
      for (const amount of measured) {
        expect(amount.text).toMatch(WRITTEN_AMOUNT);
        expect(amount.apart).toBe(false);
        expect(amount.fontVariantNumeric).toContain("tabular-nums");
        expect(Math.abs(amount.right - (measured[0]?.right ?? 0))).toBeLessThan(
          1.01
        );
      }
    });
  }
}
