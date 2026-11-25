/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { productStates } from "./ui-product-states";
import { stockStates } from "./ui-stock-states";

/**
 * The gap between the list and what sits above its frame is 16 px at 360 px. On Produtos the count is in the header
 * of the frame, so the 16 px is between the line of controls (the filter of the state) and the frame. On Estoque the
 * count is in the title of the frame too, so the 16 px is between the controls (search and filters) and the frame;
 * the notice of the open panel lives inside the panel, so nothing sits between them, and the gap does not change with
 * the "Precisa de ação" strip above. Clientes counts in the title of its `ListBlock`, with no line of its own.
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

/** From the bottom of the filter of the products (the last of the line of controls) to the top of the frame of the list. */
function gapBelowFilter(page: Page) {
  return page.evaluate(() => {
    const filter = document.querySelector(
      '[role="tablist"][aria-label="Estado dos produtos"]'
    );
    const frame = document.querySelector("[data-list-block]");
    if (!(filter && frame)) {
      return null;
    }
    return {
      gap:
        frame.getBoundingClientRect().top -
        filter.getBoundingClientRect().bottom,
    };
  });
}

/** From the bottom of the controls of the stock (the search and the filters) to the top of the frame of the list. */
async function gapBelowControls(page: Page) {
  const controls = await page
    .getByRole("search", { name: "Filtrar estoque" })
    .boundingBox();
  const frame = await page.locator("[data-list-block]").boundingBox();
  return controls && frame
    ? { gap: frame.y - (controls.y + controls.height) }
    : null;
}

test.describe("o vão entre a contagem e a lista a 360 px", () => {
  test("Produtos: a moldura da lista fica a 16 px da linha de controles", async ({
    page,
  }) => {
    await productStates.list(page);
    const products = await gapBelowFilter(page);
    expect(products).not.toBeNull();
    expect(products?.gap).toBeCloseTo(GAP, 0);
  });

  test("Estoque: o vão entre a contagem e a lista é de 16 px", async ({
    page,
  }) => {
    await stockStates.list(page);
    await expect(page.locator('[data-slot="action-strip"]')).toBeVisible();
    const stock = await gapBelowControls(page);

    expect(stock?.gap).toBeCloseTo(GAP, 0);
  });

  test("no Estoque o vão é o mesmo com e sem a faixa Precisa de ação (sem ela, com o aviso de indisponível no lugar)", async ({
    page,
  }) => {
    await stockStates.list(page);
    await expect(page.locator('[data-slot="action-strip"]')).toBeVisible();
    const withStrip = await gapBelowControls(page);

    await stockStates.attentionUnavailable(page);
    await expect(page.locator('[data-slot="action-strip"]')).toHaveCount(0);
    const withoutStrip = await gapBelowControls(page);

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
    const rows = page.getByRole("list", { name: "Saldos em estoque" });
    const top = () =>
      rows.evaluate((list) => list.getBoundingClientRect().top + scrollY);
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
    const open = await gapBelowControls(page);
    expect(open?.gap).toBeCloseTo(GAP, 0);
  });
});
