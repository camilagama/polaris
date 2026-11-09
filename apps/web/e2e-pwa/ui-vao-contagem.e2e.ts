/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { customerStates } from "./ui-lot2-states";
import { productStates } from "./ui-product-states";
import { stockStates } from "./ui-stock-states";

/**
 * The gap between the line that counts the list ("25 variantes") and the card of the list is the same on Estoque,
 * Produtos and Clientes: 16 px at 360 px. The notice of the open panel lives inside the panel, so nothing sits
 * between the count and the list, and the gap does not change with the "Precisa de ação" strip above.
 */
const GAP = 16;
const TOLERANCE = 1;
const OPEN_REASON = "Feche o painel aberto para usar os botões.";
const COUNT_JEANS = /^Contar estoque de Calça jeans/;
const RECEIVE_JEANS = /^Receber estoque de Calça jeans/;

test.use({ viewport: { height: 740, width: 360 } });

test.beforeEach(({ browserName }, testInfo) => {
  test.skip(
    browserName !== "chromium" || testInfo.project.name !== "chromium-desktop",
    "the gap is a layout measure, taken once at 360 px"
  );
});

/**
 * From the bottom of the line of the count (the element that holds the live count, or the row that holds it with
 * "Atualizar") to the top of the card of the list. The line is the ancestor of the count that is a sibling of the card.
 */
function gapBelowCount(page: Page) {
  return page.evaluate(() => {
    const live = document.querySelector(
      '[aria-live="polite"][role="status"], p[aria-live="polite"]'
    );
    const card = document
      .querySelector("ul[aria-label]")
      ?.closest('[data-slot="card"]');
    if (!(live && card)) {
      return null;
    }
    let line: Element = live;
    while (line.parentElement && !line.parentElement.contains(card)) {
      line = line.parentElement;
    }
    return {
      gap:
        card.getBoundingClientRect().top - line.getBoundingClientRect().bottom,
    };
  });
}

test.describe("o vão entre a contagem e a lista a 360 px", () => {
  test("Estoque, Produtos e Clientes têm o mesmo vão de 16 px", async ({
    page,
  }) => {
    await stockStates.list(page);
    await expect(page.locator('[data-slot="action-strip"]')).toBeVisible();
    const stock = await gapBelowCount(page);

    await productStates.list(page);
    const products = await gapBelowCount(page);

    await customerStates.list(page);
    const customers = await gapBelowCount(page);

    expect(stock?.gap).toBeCloseTo(GAP, 0);
    expect(
      Math.abs((stock?.gap ?? 0) - (products?.gap ?? 99))
    ).toBeLessThanOrEqual(TOLERANCE);
    expect(
      Math.abs((stock?.gap ?? 0) - (customers?.gap ?? 99))
    ).toBeLessThanOrEqual(TOLERANCE);
    expect(products?.gap).toBeCloseTo(GAP, 0);
    expect(customers?.gap).toBeCloseTo(GAP, 0);
  });

  test("no Estoque o vão é o mesmo com e sem a faixa Precisa de ação (sem ela, com o aviso de indisponível no lugar)", async ({
    page,
  }) => {
    await stockStates.list(page);
    await expect(page.locator('[data-slot="action-strip"]')).toBeVisible();
    const withStrip = await gapBelowCount(page);

    await stockStates.attentionUnavailable(page);
    await expect(page.locator('[data-slot="action-strip"]')).toHaveCount(0);
    const withoutStrip = await gapBelowCount(page);

    expect(withStrip).not.toBeNull();
    expect(withoutStrip).not.toBeNull();
    expect(
      Math.abs((withStrip?.gap ?? 0) - (withoutStrip?.gap ?? 99))
    ).toBeLessThanOrEqual(TOLERANCE);
    expect(withoutStrip?.gap).toBeCloseTo(GAP, 0);
  });

  test("com um painel aberto o vão e a posição da lista não mudam", async ({
    page,
  }) => {
    await stockStates.list(page);
    const rows = page.getByRole("list", { name: "Saldos por variante" });
    const top = async () => (await rows.boundingBox())?.y ?? 0;
    const before = await top();
    await page.getByRole("button", { name: RECEIVE_JEANS }).click();
    await expect(
      page.getByRole("heading", { name: "Receber estoque" })
    ).toBeVisible();
    expect(Math.abs((await top()) - before)).toBeLessThanOrEqual(TOLERANCE);
    await expect(page.locator("#stock-panel-open-reason")).toHaveText(
      OPEN_REASON
    );
    await expect(
      page.getByRole("button", { name: COUNT_JEANS })
    ).toHaveAccessibleDescription(OPEN_REASON);
    const open = await gapBelowCount(page);
    expect(open?.gap).toBeCloseTo(GAP, 0);
  });
});
