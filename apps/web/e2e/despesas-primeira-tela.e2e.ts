/// <reference lib="dom" />
import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { json, serve } from "./shell-server";

/**
 * Despesas in the real shell (header, title, segments): on a phone of 360 x 740 with the browser font at 16 px, the
 * first expense of the month is read in the first 400 px, with the month, the "Ativas | Anuladas" segmented and "Filtrar" (icon only on a phone) on one line above the total.
 */
const FIRST_ROW_LIMIT = 400;
const NOW = "2026-10-14T12:00:00.000Z";
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
  competenceOn: "2026-10-14",
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

test("a 360 px o mês, Ativas | Anuladas e o Filtrar só ícone cabem numa linha, e a primeira despesa continua a 400 px ou menos", async ({
  page,
}) => {
  await page.setViewportSize({ height: 740, width: 360 });
  await page.clock.setFixedTime(new Date(NOW));
  await serveExpenses(page);
  await page.goto("/expenses");

  const bar = page.getByRole("search", {
    exact: true,
    name: "Filtrar despesas",
  });
  const month = bar.locator("#expense-month");
  const segmented = bar.getByRole("group", { exact: true, name: "Situação" });
  const filter = bar.getByRole("button", {
    exact: true,
    name: "Filtrar despesas",
  });
  await expect(filter).toBeVisible();
  await expect(filter).toHaveText("");
  const boxes = await Promise.all(
    [month, segmented, filter].map((locator) => locator.boundingBox())
  );
  for (const box of boxes) {
    expect(box).not.toBeNull();
  }
  const [monthBox, segmentedBox, filterBox] = boxes;
  const centres = boxes.map((box) => (box?.y ?? 0) + (box?.height ?? 0) / 2);
  expect(Math.max(...centres) - Math.min(...centres)).toBeLessThanOrEqual(1);
  expect((monthBox?.x ?? 0) + (monthBox?.width ?? 0)).toBeLessThanOrEqual(
    segmentedBox?.x ?? 0
  );
  expect(
    (segmentedBox?.x ?? 0) + (segmentedBox?.width ?? 0)
  ).toBeLessThanOrEqual(filterBox?.x ?? 0);
  expect((filterBox?.x ?? 0) + (filterBox?.width ?? 0)).toBeLessThanOrEqual(
    360
  );

  const first = await page.locator("[data-expense-id]").first().boundingBox();
  expect(first?.y ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
    FIRST_ROW_LIMIT
  );
});
