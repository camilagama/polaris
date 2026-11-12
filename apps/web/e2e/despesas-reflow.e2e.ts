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
const FILTER_BUTTON_NAME = /^Filtrar( despesas)?$/;
const CATEGORY_ITEM = /^Categoria/;
const ROWS = 14;
const LONG_CATEGORY = "Material de embalagem e limpeza do ateliê";
const LONG_GROUP = "Operacional/Administrativa";
const SHORT_CATEGORY = "Aluguel";

const CATEGORIES = [
  ["commercial", "Marketing"],
  ["operational", SHORT_CATEGORY],
  ["operational", LONG_CATEGORY],
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

const scrollTop = (page: Page) =>
  page.evaluate(
    () => (document.scrollingElement ?? document.documentElement).scrollTop
  );

/** Scrolls the page to its end for real and returns where it stopped, once it stopped. */
async function scrollToBottom(page: Page) {
  await page.evaluate(() => {
    const scroller = document.scrollingElement ?? document.documentElement;
    scroller.scrollTo(0, scroller.scrollHeight);
  });
  const first = await scrollTop(page);
  await expect.poll(() => scrollTop(page)).toBe(first);
  return first;
}

test.describe("a 320 px com letra de 20 px", () => {
  // the button sits under the title, outside the card, so scrolling does not carry it: the end of the list is what is checked
  reflowTest(
    "o título lê inteiro e o botão Nova despesa, fora do cartão, não cobre nada, e o total da lista chega à vista ao rolar até o fim",
    async ({ page }) => {
      await openReflowViewport(page);
      await openExpenses(page);
      await expectReflowFont(page);
      await expect(newButton(page)).toBeVisible();

      await expectTitleAndButtonApart(page);

      expect(
        await scrollToBottom(page),
        "the page did not scroll"
      ).toBeGreaterThan(0);
      await expect(page.locator("[data-list-total]")).toBeInViewport();
      await expectTitleAndButtonApart(page);
    }
  );

  reflowTest(
    "a barra Filtrar despesas, com a categoria e Anuladas, não corta nada nem rola a página, o segmentado segue à vista e fechar o editor devolve o foco à pílula",
    async ({ page }) => {
      await openReflowViewport(page);
      await openExpenses(page);
      await expectReflowFont(page);
      const bar = page.getByRole("search", {
        exact: true,
        name: "Filtrar despesas",
      });
      const segmented = bar.getByRole("group", {
        exact: true,
        name: "Situação",
      });
      const voided = segmented.getByRole("button", {
        exact: true,
        name: "Anuladas",
      });
      await expect(
        segmented.getByRole("button", { exact: true, name: "Ativas" })
      ).toBeInViewport({ ratio: 1 });
      await expect(voided).toBeInViewport({ ratio: 1 });
      await voided.click();
      await expect(voided).toHaveAttribute("aria-pressed", "true");

      await bar.getByRole("button", { name: FILTER_BUTTON_NAME }).click();
      await page
        .getByRole("menu", { name: "Filtrar por" })
        .getByRole("menuitem", { name: CATEGORY_ITEM })
        .click();
      const chooser = page.getByRole("dialog", { name: "Categoria" });
      await chooser
        .getByRole("button", { exact: true, name: "Marketing" })
        .click();
      await chooser
        .getByRole("button", { exact: true, name: "Aplicar" })
        .click();
      await expect(chooser).toHaveCount(0);
      await expect(bar.locator('[data-slot="filter-pill"]')).toHaveCount(1);
      await expect(voided).toBeInViewport({ ratio: 1 });
      await assertNothingClipped(bar);
      await assertNoPageScroll(page);

      const pill = page.locator(
        'search[aria-label="Filtrar despesas"] button[aria-label^="Categoria: "]'
      );
      await pill.click();
      const editor = page.getByRole("dialog", { name: "Categoria" });
      await expect(editor).toBeVisible();
      await editor
        .getByRole("button", { exact: true, name: "Cancelar" })
        .click();
      await expect(editor).toHaveCount(0);
      await expect(pill).toBeFocused();
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

interface ValueReading {
  clientHeight: number;
  clientWidth: number;
  scrollHeight: number;
  scrollWidth: number;
  text: string;
  title: string | null;
  triggerHeight: number;
}

const readValue = (trigger: Locator) =>
  trigger.evaluate((element): ValueReading => {
    const value = element.querySelector<HTMLElement>(
      '[data-slot="select-value"]'
    );
    if (value === null) {
      throw new Error("the select has no value element");
    }
    return {
      clientHeight: value.clientHeight,
      clientWidth: value.clientWidth,
      scrollHeight: value.scrollHeight,
      scrollWidth: value.scrollWidth,
      text: value.textContent ?? "",
      title: value.getAttribute("title"),
      triggerHeight: element.getBoundingClientRect().height,
    };
  });

/** The value is whole in the DOM and in the title, and never cut sideways: only the end of its second line may be cut. */
async function expectValueNotCutSideways(
  trigger: Locator,
  expected: string
): Promise<ValueReading> {
  const reading = await readValue(trigger);
  expect(reading.text).toBe(expected);
  expect(reading.scrollWidth, "the value is cut sideways").toBeLessThanOrEqual(
    reading.clientWidth + 1
  );
  expect(reading.title, "the title has the whole name").toBe(expected);
  return reading;
}

async function pick(page: Page, scope: Locator, label: string, option: string) {
  await scope.getByRole("combobox", { exact: true, name: label }).click();
  await page.getByRole("option", { exact: true, name: option }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
}

const openExpenseForm = async (page: Page) => {
  await newButton(page).click();
  return page.getByRole("dialog", { exact: true, name: "Nova despesa" });
};

const openRuleForm = async (page: Page) => {
  await page.getByRole("tab", { name: "Recorrentes" }).click();
  await page
    .getByRole("button", { exact: true, name: "Nova despesa recorrente" })
    .click();
  return page.getByRole("dialog", {
    exact: true,
    name: "Nova despesa recorrente",
  });
};

const openCategoryForm = async (page: Page) => {
  await page.getByRole("tab", { name: "Categorias" }).click();
  await page
    .getByRole("button", { exact: true, name: "Nova categoria" })
    .click();
  return page.getByRole("dialog", { exact: true, name: "Nova categoria" });
};

const SELECTS = [
  {
    label: "Categoria",
    name: "o formulário de despesa",
    open: openExpenseForm,
    option: LONG_CATEGORY,
    trigger: "#expense-categoryId",
  },
  {
    label: "Categoria",
    name: "a regra recorrente",
    open: openRuleForm,
    option: LONG_CATEGORY,
    trigger: "#expense-rule-categoryId",
  },
  {
    label: "Grupo",
    name: "o formulário de categoria",
    open: openCategoryForm,
    option: LONG_GROUP,
    trigger: "#expense-new-category-group",
  },
] as const;

test.describe("o valor do seletor a 320 px com letra de 20 px", () => {
  for (const select of SELECTS) {
    reflowTest(
      `${select.name}: o valor escolhido quebra de linha em vez de ser cortado seco, e o campo cresce sem passar da caixa`,
      async ({ page }) => {
        await openReflowViewport(page);
        await openExpenses(page);
        await expectReflowFont(page);
        const dialog = await select.open(page);
        await expect(dialog).toBeVisible();
        const trigger = dialog.locator(select.trigger);
        const before = await readValue(trigger);

        await pick(page, dialog, select.label, select.option);

        const after = await expectValueNotCutSideways(trigger, select.option);
        const lineHeight = await trigger
          .locator('[data-slot="select-value"]')
          .evaluate((element) =>
            Number.parseFloat(getComputedStyle(element).lineHeight)
          );
        expect(
          after.triggerHeight - before.triggerHeight,
          "the field grew by more than one line"
        ).toBeLessThanOrEqual(lineHeight + 1);
        expect(
          after.clientHeight,
          "the value shows more than two lines"
        ).toBeLessThanOrEqual(2 * lineHeight + 1);
        if (after.scrollHeight > after.clientHeight + 1) {
          expect(
            after.clientHeight,
            "a cut value shows two lines, not one"
          ).toBeGreaterThan(lineHeight * 1.5);
        }
        await assertNothingClipped(dialog);
        await assertNoPageScroll(page);
      }
    );
  }
});

test.describe("o valor do seletor a 360 px com letra de 16 px", () => {
  for (const select of SELECTS.slice(0, 2)) {
    reflowTest(
      `${select.name}: valor curto deixa o campo na altura de hoje e valor longo cresce no máximo uma linha`,
      async ({ page }) => {
        await page.setViewportSize({ height: 740, width: 360 });
        await openExpenses(page);
        const dialog = await select.open(page);
        const trigger = dialog.locator(select.trigger);
        const empty = await readValue(trigger);

        await pick(page, dialog, select.label, SHORT_CATEGORY);
        const short = await readValue(trigger);
        expect(
          short.triggerHeight,
          "a short value changes the height of the field"
        ).toBe(empty.triggerHeight);
        expect(
          short.triggerHeight,
          "the field is not at its height of always"
        ).toBe(TOUCH);

        await pick(page, dialog, select.label, select.option);
        const long = await expectValueNotCutSideways(trigger, select.option);
        const lineHeight = await trigger
          .locator('[data-slot="select-value"]')
          .evaluate((element) =>
            Number.parseFloat(getComputedStyle(element).lineHeight)
          );
        expect(
          long.triggerHeight - short.triggerHeight,
          "the field grew by more than one line"
        ).toBeLessThanOrEqual(lineHeight + 1);
      }
    );
  }
});
