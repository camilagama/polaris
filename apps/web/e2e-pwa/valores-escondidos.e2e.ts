/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { skipOutsideChromium } from "../e2e/reflow";
import { expenseStates } from "./ui-expense-states";
import { historyStates } from "./ui-history-states";
import { saleDetailStates } from "./ui-sale-detail-states";
import { stockStates } from "./ui-stock-states";

/**
 * "Esconder valores" on the lists and the receipt: with the choice on, the history, the expenses, the sale detail and the stock, with their totals, write no amount in reais in their
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
  { name: "Detalhe da venda", open: saleDetailStates.detail },
  { name: "Estoque", open: stockStates.list },
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

for (const theme of THEMES) {
  for (const viewport of VIEWPORTS) {
    test(`Detalhe da venda: o R$ do total tem a cor do número, apartado e menor (${viewport.name}, ${theme})`, async ({
      page,
    }) => {
      await useDevice(page, viewport, theme, false);
      await saleDetailStates.detail(page);
      const total = page.locator("[data-money-currency]").first();
      await expect(total).toBeAttached();
      const measured = await total.evaluate((currency) => {
        const root = currency.closest("[data-money]") as HTMLElement;
        const number = root.querySelector("[data-money-number]") as HTMLElement;
        return {
          currencyColor: getComputedStyle(currency).color,
          currencySize: Number.parseFloat(getComputedStyle(currency).fontSize),
          numberColor: getComputedStyle(number).color,
          numberSize: Number.parseFloat(getComputedStyle(number).fontSize),
          text: root.textContent ?? "",
        };
      });
      expect(measured.text).toMatch(WRITTEN_AMOUNT);
      expect(measured.currencyColor).toBe(measured.numberColor);
      expect(measured.currencySize).toBeLessThan(measured.numberSize);
    });
  }
}
