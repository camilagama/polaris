/// <reference lib="dom" />
import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { json, serve } from "./shell-server";

/**
 * Despesas in the real shell (header, title, segments): on a phone of 360 x 740 with the browser font at 16 px, the
 * first expense of the month is read in the first 400 px, with the month, the "Ativas | Anuladas" segmented and "Filtrar" (icon only on a phone) on one line above the total.
 */
const FIRST_ROW_LIMIT = 400;
const LINE_SPARE = 8;
const TOUCH_TARGET = 44;
const NOW = "2026-11-14T12:00:00.000Z";
const MONTHS = Array.from({ length: 12 }, (_, index) => index + 1);
const clockOf = (month: number) =>
  `2026-${String(month).padStart(2, "0")}-14T12:00:00.000Z`;
const ORGANIZATION = "0199c2d0-0000-7000-8000-00000000a001";
const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

const CATEGORY = {
  archivedAt: null,
  createdAt: NOW,
  groupKey: "operational",
  id: uuid(2),
  name: "Aluguel",
  organizationId: ORGANIZATION,
  status: "active",
  systemKey: null,
  updatedAt: NOW,
  version: 1,
};

const EXPENSES = [1, 2, 3].map((n) => ({
  amount: "1500.50",
  categoryGroup: "operational",
  categoryId: CATEGORY.id,
  categoryName: CATEGORY.name,
  competenceOn: "2026-11-14",
  createdAt: NOW,
  description: `Despesa ${n}`,
  id: uuid(500 + n),
  organizationId: ORGANIZATION,
  payee: null,
  recurringRuleId: null,
  saleId: null,
  status: "active",
  updatedAt: NOW,
  version: 1,
  voidedAt: null,
}));

async function serveExpenses(page: Page) {
  await serve(page);
  await page.route("**/rpc/expense/**", (route: Route) => {
    const procedure = new URL(route.request().url()).pathname.replace(
      "/rpc/",
      ""
    );
    switch (procedure) {
      case "expense/listCategories":
        return route.fulfill(json({ categories: [CATEGORY] }));
      case "expense/list":
        return route.fulfill(
          json({
            count: EXPENSES.length,
            expenses: EXPENSES,
            nextCursor: null,
            total: "4501.50",
          })
        );
      default:
        return route.fulfill(json({ rules: [] }));
    }
  });
}

test("a primeira despesa fica a 400 px do topo ou menos a 360 px, com 3 despesas", async ({
  page,
}) => {
  await page.setViewportSize({ height: 740, width: 360 });
  await page.clock.setFixedTime(new Date(NOW));
  await serveExpenses(page);
  await page.goto("/expenses");

  const first = page.locator("[data-expense-id]").first();
  await expect(first).toBeVisible();
  await expect(page.locator("[data-expense-id]")).toHaveCount(3);
  const box = await first.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.y ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
    FIRST_ROW_LIMIT
  );
});

for (const month of MONTHS) {
  test(`a 360 px o mês ${month}, Ativas | Anuladas e o Filtrar só ícone cabem numa linha com ${LINE_SPARE} px de folga, e a primeira despesa continua a 400 px ou menos`, async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await page.clock.setFixedTime(new Date(clockOf(month)));
    await serveExpenses(page);
    await page.goto("/expenses");

    const bar = page.getByRole("search", {
      exact: true,
      name: "Filtrar despesas",
    });
    const monthButton = bar.locator("#expense-month");
    const segmented = bar.getByRole("group", { exact: true, name: "Situação" });
    const filter = bar.getByRole("button", {
      exact: true,
      name: "Filtrar despesas",
    });
    await expect(filter).toBeVisible();
    await expect(filter).toHaveText("");
    const [barBox, monthBox, segmentedBox, filterBox] = await Promise.all(
      [bar, monthButton, segmented, filter].map((locator) =>
        locator.boundingBox()
      )
    );
    for (const box of [barBox, monthBox, segmentedBox, filterBox]) {
      expect(box).not.toBeNull();
    }
    const centres = [monthBox, segmentedBox, filterBox].map(
      (box) => (box?.y ?? 0) + (box?.height ?? 0) / 2
    );
    expect(Math.max(...centres) - Math.min(...centres)).toBeLessThanOrEqual(1);
    expect((monthBox?.x ?? 0) + (monthBox?.width ?? 0)).toBeLessThanOrEqual(
      segmentedBox?.x ?? 0
    );
    expect(
      (segmentedBox?.x ?? 0) + (segmentedBox?.width ?? 0)
    ).toBeLessThanOrEqual(filterBox?.x ?? 0);
    const lineEnd = (barBox?.x ?? 0) + (barBox?.width ?? 0);
    const spare = lineEnd - ((filterBox?.x ?? 0) + (filterBox?.width ?? 0));
    expect(spare).toBeGreaterThanOrEqual(LINE_SPARE);

    const halves = await segmented.getByRole("button").all();
    expect(halves).toHaveLength(2);
    const halfBoxes = await Promise.all(
      halves.map((half) => half.boundingBox())
    );
    for (const halfBox of halfBoxes) {
      expect(halfBox?.width ?? 0).toBeGreaterThanOrEqual(TOUCH_TARGET);
      expect(halfBox?.height ?? 0).toBeGreaterThanOrEqual(TOUCH_TARGET);
    }

    const first = await page.locator("[data-expense-id]").first().boundingBox();
    expect(first?.y ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
      FIRST_ROW_LIMIT
    );
  });
}
