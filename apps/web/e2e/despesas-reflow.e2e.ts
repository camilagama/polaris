/// <reference lib="dom" />
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  assertNoEllipsis,
  assertNoPageScroll,
  assertNothingClipped,
  expectReflowFont,
  openReflowViewport,
  reflowTest,
  skipOutsideChromium,
} from "./reflow";
import { serveLabWorker, WORKER_MARK } from "./worker-mark";

/**
 * The title of Despesas and its "Nova despesa" button read at 320 px with the browser font at 20 px (`./reflow`): the
 * title is whole, the button is whole and outside the list card, and neither covers the other, with the form closed and
 * with the categories load error on the screen. On a phone with the default font (16 px) at 360 px the button is as wide
 * as the screen right under the title and keeps a touch target of 44 px.
 */
skipOutsideChromium();

const TOUCH = 44;
const ORGANIZATION = "0199c2d0-0000-7000-8000-00000000a001";
const NOW = "2026-10-14T12:00:00.000Z";
const TODAY = "2026-10-14";
const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const ROWS = 14;

const CATEGORIES = [
  ["commercial", "Marketing"],
  ["operational", "Aluguel"],
].map(([groupKey, name], index) => ({
  archivedAt: null,
  createdAt: NOW,
  groupKey,
  id: uuid(index + 1),
  name,
  organizationId: ORGANIZATION,
  status: "active",
  systemKey: null,
  updatedAt: NOW,
  version: 1,
}));

const EXPENSES = Array.from({ length: ROWS }, (_, index) => ({
  amount: "1500.50",
  categoryGroup: "operational",
  categoryId: uuid(2),
  categoryName: "Aluguel",
  competenceOn: TODAY,
  createdAt: NOW,
  description: `Despesa ${index + 1}`,
  id: uuid(500 + index),
  organizationId: ORGANIZATION,
  payee: null,
  recurringRuleId: null,
  saleId: null,
  status: "active",
  updatedAt: NOW,
  version: 1,
  voidedAt: null,
}));

const answer = (json: unknown) => ({
  body: JSON.stringify({ json, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
});

async function openExpenses(
  page: Page,
  { categoriesFail = false }: { categoriesFail?: boolean } = {}
) {
  await page.clock.setFixedTime(new Date(NOW));
  await serveLabWorker(page);
  await page.route("**/rpc/**", (route) => {
    const procedure = new URL(route.request().url()).pathname.replace(
      "/rpc/",
      ""
    );
    switch (procedure) {
      case "expense/listCategories":
        return categoriesFail
          ? route.abort("internetdisconnected")
          : route.fulfill(answer({ categories: CATEGORIES }));
      case "expense/list":
        return route.fulfill(
          answer({
            count: EXPENSES.length,
            expenses: EXPENSES,
            nextCursor: null,
            total: (EXPENSES.length * 1500.5).toFixed(2),
          })
        );
      case "expense/listRules":
        return route.fulfill(answer({ rules: [] }));
      default:
        return route.fulfill({
          ...answer({ code: "NOT_FOUND" }),
          status: 404,
        });
    }
  });
  await page.goto("/offline-screens-lab?screen=expenses");
  await page.getByLabel("Usuário").fill(`user-${crypto.randomUUID()}`);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await expect(
    page.getByRole("heading", { exact: true, name: "Despesas" })
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Despesa 1", { exact: true })).toBeVisible();
}

const title = (page: Page) =>
  page.getByRole("heading", { exact: true, level: 1, name: "Despesas" });
const header = (page: Page) =>
  page.locator("header").filter({ has: title(page) });
const newButton = (page: Page) =>
  page.getByRole("button", { exact: true, name: "Nova despesa" });

interface Box {
  height: number;
  width: number;
  x: number;
  y: number;
}

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  expect(box, "the element has no box").not.toBeNull();
  return box as Box;
}

const overlap = (a: Box, b: Box) =>
  Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 1 &&
  Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 1;

/** What `elementFromPoint` finds at the center of the element, and whether it is the element or inside it. */
function topAtCenter(locator: Locator) {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2
    );
    return hit !== null && element.contains(hit);
  });
}

function inWindow(locator: Locator) {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    return x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
  });
}

async function expectTitleAndButtonApart(page: Page) {
  const titleBox = await boxOf(title(page));
  const buttonBox = await boxOf(newButton(page));
  expect(overlap(titleBox, buttonBox), "the title and the button cross").toBe(
    false
  );
  expect(
    await newButton(page).evaluate(
      (element) => element.closest('[data-slot="card"]') === null
    ),
    "the button is inside a card"
  ).toBe(true);
  expect(buttonBox.x).toBeGreaterThanOrEqual(-0.5);
  expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(
    (await page.evaluate(() => innerWidth)) + 0.5
  );
  if (await inWindow(title(page))) {
    expect(await topAtCenter(title(page)), "the title is covered").toBe(true);
  }
  if (await inWindow(newButton(page))) {
    expect(await topAtCenter(newButton(page)), "the button is covered").toBe(
      true
    );
  }
  await assertNothingClipped(header(page));
  await assertNoEllipsis(title(page));
  await assertNoPageScroll(page);
}

test.describe("a 320 px com letra de 20 px", () => {
  reflowTest(
    "o título lê inteiro e o botão Nova despesa, fora do cartão, não cobre nada",
    async ({ page }) => {
      await openReflowViewport(page);
      await openExpenses(page);
      await expectReflowFont(page);
      await expect(newButton(page)).toBeVisible();

      await expectTitleAndButtonApart(page);
    }
  );

  reflowTest(
    "com a mensagem de erro de carga das categorias na tela o título e o botão seguem inteiros e separados",
    async ({ page }) => {
      await openReflowViewport(page);
      await openExpenses(page, { categoriesFail: true });
      await expectReflowFont(page);
      await expect(
        page.getByRole("button", { name: "Tentar novamente" }).first()
      ).toBeVisible({ timeout: 20_000 });

      await expectTitleAndButtonApart(page);
    }
  );
});

test.describe("a 360 px com a letra padrão", () => {
  reflowTest(
    "o botão fica logo abaixo do título, com a largura da tela, e o alvo tem 44 px ou mais",
    async ({ page }) => {
      await page.setViewportSize({ height: 740, width: 360 });
      await openExpenses(page);
      const titleBox = await boxOf(title(page));
      const buttonBox = await boxOf(newButton(page));
      const titleBottom = titleBox.y + titleBox.height;
      expect(
        buttonBox.y,
        "the button is above the title bottom"
      ).toBeGreaterThanOrEqual(titleBottom - 0.5);
      expect(
        buttonBox.y,
        "the button is not right under the title"
      ).toBeLessThanOrEqual(titleBottom + 16);
      expect(
        buttonBox.width,
        "the button is not as wide as the screen"
      ).toBeGreaterThan(320);
      expect(overlap(titleBox, buttonBox)).toBe(false);
      const height = await newButton(page).evaluate((element) => {
        const box = element.getBoundingClientRect();
        const hit = getComputedStyle(element, "::before");
        const grow =
          hit.content === '""' && hit.position === "absolute"
            ? -(Number.parseFloat(hit.top) || 0) -
              (Number.parseFloat(hit.bottom) || 0)
            : 0;
        return box.height + Math.max(0, grow);
      });
      expect(height).toBeGreaterThanOrEqual(TOUCH);
    }
  );
});
