/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  assertNoEllipsis,
  assertNoPageScroll,
  assertNothingClipped,
  expectReflowFont,
  openReflowViewport,
  skipOutsideChromium,
} from "./reflow";
import { serveLabWorker, WORKER_MARK } from "./worker-mark";

/**
 * The stock list read at 320 px with the browser font at 20 px (`./reflow`): the three buttons of every row and the
 * cost figure are whole and can be touched. With the default font (16 px) the row is the one it always was: the
 * three buttons side by side on the phone and on the desktop.
 */
skipOutsideChromium();

const TOUCH = 44;
const ACTIONS = '[data-slot="button-group"] [data-stock-action]';

const BASE = {
  isDefaultVariant: false,
  listPrice: "50.00",
  movingAverageCost: "62.400000",
  productStatus: "active",
  quantity: 3,
  sku: null,
  updatedAt: "2026-10-14T12:00:00.000Z",
  values: [{ optionName: "tamanho", optionValueName: "42" }],
  version: 1,
};
const id = (suffix: number) => `0199c2d0-0000-7000-8000-0000000001${suffix}`;
const ENTRIES = [
  {
    ...BASE,
    productId: id(10),
    productName: "Calça jeans",
    variantId: id(11),
  },
  {
    ...BASE,
    movingAverageCost: null,
    productId: id(20),
    productName: "Camiseta do teste",
    quantity: 5,
    sku: "CAM-AZ-M",
    values: [{ optionName: "cor", optionValueName: "Azul" }],
    variantId: id(21),
  },
  {
    ...BASE,
    productId: id(30),
    productName: "Meia esportiva de algodão com nome bem comprido",
    quantity: 0,
    variantId: id(31),
  },
  {
    ...BASE,
    movingAverageCost: null,
    productId: id(40),
    productName: "Caneca esmaltada",
    productStatus: "archived",
    quantity: 0,
    values: [],
    variantId: id(41),
  },
  {
    ...BASE,
    productId: id(50),
    productName: "Tênis",
    quantity: 1234,
    variantId: id(51),
  },
];

const rpc = (body: unknown) => ({
  body: JSON.stringify({ json: body, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
});

async function openStock(page: Page, width: number, fontPixels: number) {
  await openReflowViewport(page, { fontPixels, width });
  await page.route("**/rpc/inventory/listBalances", (route) =>
    route.fulfill(rpc({ entries: ENTRIES, nextCursor: null }))
  );
  await serveLabWorker(page);
  await page.goto("/offline-screens-lab?screen=stock");
  await page.getByLabel("Usuário").fill(`user-${crypto.randomUUID()}`);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await expect(page.getByTestId("message")).toContainText(
    "Iniciar: ok (ready)",
    { timeout: 20_000 }
  );
  await expect(
    page.getByRole("heading", { exact: true, name: "Estoque" })
  ).toBeVisible();
  await expect(page.getByRole("listitem").first()).toBeVisible();
  await expect(page.locator(ACTIONS)).toHaveCount(ENTRIES.length * 3);
  await expectReflowFont(page, fontPixels);
}

interface Box {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
}

/** The buttons whose center is not the element on top at that point, once the button is scrolled into view. */
function untouchable(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("[data-stock-action]")]
      .filter((button) => {
        button.scrollIntoView({ block: "center" });
        const { height, left, top, width } = button.getBoundingClientRect();
        const x = left + width / 2;
        const y = top + height / 2;
        const onTop = document.elementFromPoint(x, y);
        const inside =
          x >= 0 && x <= window.innerWidth && y >= 0 && y <= window.innerHeight;
        return !(inside && onTop !== null && button.contains(onTop));
      })
      .map((button) => button.getAttribute("aria-label"))
  );
}

/** Per row: the box of the card, of the group and of each button, in the order of the screen. */
function geometry(page: Page) {
  return page.evaluate(() => {
    const box = (element: Element): Box => {
      const { bottom, height, left, right, top, width } =
        element.getBoundingClientRect();
      return { bottom, height, left, right, top, width };
    };
    const card = document.querySelector('ul[aria-label="Saldos por variante"]');
    if (card === null) {
      throw new Error("the list is not on the screen");
    }
    return [...card.children].map((row) => {
      const group = row.querySelector('[data-slot="button-group"]');
      if (group === null) {
        throw new Error("a row has no group of buttons");
      }
      return {
        buttons: [...group.querySelectorAll("[data-stock-action]")].map(
          (button) => ({
            ...box(button),
            clientWidth: button.clientWidth,
            label: button.textContent ?? "",
            scrollWidth: button.scrollWidth,
          })
        ),
        card: box(card),
        group: box(group),
        groupName: group.getAttribute("aria-label"),
        row: box(row),
      };
    });
  });
}

test("a 320 px com letra de 20 px os três botões de cada linha empilham, inteiros, dentro do cartão e com 44 px", async ({
  page,
}) => {
  await openStock(page, 320, 20);
  const rows = await geometry(page);
  expect(rows).toHaveLength(ENTRIES.length);
  for (const row of rows) {
    expect(row.buttons.map((button) => button.label)).toHaveLength(3);
    const lefts = new Set(row.buttons.map((button) => Math.round(button.left)));
    expect(lefts.size, `${row.groupName}: os botões alinham à esquerda`).toBe(
      1
    );
    let previousBottom = Number.NEGATIVE_INFINITY;
    for (const button of row.buttons) {
      const name = `${row.groupName}: ${button.label}`;
      expect(button.scrollWidth, `${name} inteiro`).toBeLessThanOrEqual(
        button.clientWidth + 1
      );
      expect(
        button.width,
        `${name} com 44 px de largura`
      ).toBeGreaterThanOrEqual(TOUCH);
      expect(
        button.height,
        `${name} com 44 px de altura`
      ).toBeGreaterThanOrEqual(TOUCH);
      expect(button.right, `${name} dentro do cartão`).toBeLessThanOrEqual(
        row.card.right + 0.5
      );
      expect(button.left).toBeGreaterThanOrEqual(row.card.left - 0.5);
      expect(button.top, `${name} abaixo do anterior`).toBeGreaterThanOrEqual(
        previousBottom - 0.5
      );
      expect(button.right).toBeLessThanOrEqual(320);
      previousBottom = button.bottom;
    }
    expect(row.group.right).toBeLessThanOrEqual(row.card.right + 0.5);
  }
  expect(await untouchable(page), "botões que não recebem o toque").toEqual([]);
  expect(rows.map((row) => row.buttons.map((button) => button.label))).toEqual([
    ["Receber", "Contar", "Baixar"],
    ["Receber", "Informar custo", "Baixar"],
    ["Receber", "Contar", "Baixar"],
    ["Dar entrada", "Contar", "Baixar"],
    ["Receber", "Contar", "Baixar"],
  ]);
  const list = page.getByRole("list", { name: "Saldos por variante" });
  await assertNothingClipped(list);
  await assertNoEllipsis(list.locator(`${ACTIONS}, dd`));
  await assertNoPageScroll(page);
});

test("a 320 px com letra de 20 px o Custo médio e o Saldo leem inteiros, e Custo desconhecido quebra em vez de cortar", async ({
  page,
}) => {
  await openStock(page, 320, 20);
  const unknown = page.getByText("Custo desconhecido", { exact: true });
  await expect(unknown).toHaveCount(2);
  const fits = await unknown.evaluateAll((elements) =>
    elements.map((element) => ({
      cardRight: element.closest("li")?.getBoundingClientRect().right ?? 0,
      client: element.clientWidth,
      right: element.getBoundingClientRect().right,
      scroll: element.scrollWidth,
    }))
  );
  for (const fit of fits) {
    expect(fit.scroll).toBeLessThanOrEqual(fit.client + 1);
    expect(fit.right).toBeLessThanOrEqual(fit.cardRight);
  }
  const list = page.getByRole("list", { name: "Saldos por variante" });
  await assertNoEllipsis(list.locator("dl, dt, dd"));
  await assertNothingClipped(list);
});

test("o grupo continua um controle só, com o mesmo nome acessível, e os botões mantêm o nome de cada um", async ({
  page,
}) => {
  await openStock(page, 320, 20);
  const group = page.getByRole("group", {
    name: "Movimentos de Calça jeans, 42",
  });
  await expect(group.getByRole("button")).toHaveCount(3);
  await expect(
    group.getByRole("button", { name: "Baixar estoque de Calça jeans, 42" })
  ).toBeVisible();
});

for (const width of [360, 1280]) {
  test(`a ${width} px com letra de 16 px os três botões ficam lado a lado, como sempre`, async ({
    page,
  }) => {
    await openStock(page, width, 16);
    for (const row of await geometry(page)) {
      const [first, second, third] = row.buttons;
      for (const button of row.buttons) {
        expect(
          Math.abs(button.top - (first?.top ?? 0)),
          `${row.groupName}: ${button.label} na mesma linha`
        ).toBeLessThanOrEqual(1);
        expect(button.right).toBeLessThanOrEqual(row.card.right + 0.5);
      }
      expect(second?.left).toBeGreaterThanOrEqual((first?.right ?? 0) - 1);
      expect(third?.left).toBeGreaterThanOrEqual((second?.right ?? 0) - 1);
      expect(row.group.height).toBeLessThan(TOUCH);
    }
  });
}
