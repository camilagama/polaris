/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import {
  assertNoEllipsis,
  assertNoPageScroll,
  assertNothingClipped,
  expectReflowFont,
  openReflowViewport,
  skipOutsideChromium,
  reflowTest,
} from "./reflow";
import { serveLabWorker } from "./worker-mark";

/**
 * The page of attention (Pendências) read at 320 px with the browser font at 20 px (`./reflow`): the title, the reason
 * and the code of each refused record, and the buttons "Refazer esta venda" and "Descartar…", are whole, inside the
 * card and can be touched. With the default font (16 px) the buttons are the row they always were.
 */
skipOutsideChromium();

const TOUCH = 44;
const ITEMS = "li[data-cause]";
/** The whole page of attention: the title, the subtitle, the strip and the cards. */
const frame = (page: Page) =>
  page
    .locator("div")
    .filter({ has: page.locator("#attention-title") })
    .last();
const BUTTONS = `${ITEMS} button, ${ITEMS} a[href]`;

async function openLab(page: Page, width: number, fontPixels: number) {
  await openReflowViewport(page, { fontPixels, width });
  await page.goto("/offline-attention-lab");
  await expect(
    page.getByRole("heading", { name: "Laboratório da atenção" })
  ).toBeVisible();
  await page.getByLabel("Usuário").fill(`user-${crypto.randomUUID()}`);
  await page.getByRole("button", { exact: true, name: "Abrir" }).click();
  await expect(page.getByTestId("message")).toContainText("Abrir: ok", {
    timeout: 15_000,
  });
  await expectReflowFont(page, fontPixels);
}

async function seed(page: Page, name: string, expected: string) {
  await page.getByRole("button", { exact: true, name }).click();
  await expect(page.getByTestId("message")).toContainText(expected, {
    timeout: 15_000,
  });
}

/** A sale refused for stock, a product refused for its SKU and a sale with the longest reason (access revoked). */
async function openWithThreeRecords(
  page: Page,
  width: number,
  fontPixels: number
) {
  await openLab(page, width, fontPixels);
  await seed(page, "Criar venda recusada por estoque", "Venda recusada: ok");
  await seed(page, "Criar produto recusado por SKU", "Produto recusado: ok");
  await seed(page, "Criar venda recusada por acesso", "Acesso revogado: ok");
  await expect(page.locator(ITEMS)).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Descartar…" })).toHaveCount(3);
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
  return page.evaluate((selector) => {
    const labelOf = (button: Element) => (button.textContent ?? "").trim();
    return [...document.querySelectorAll(selector)]
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
      .map(labelOf);
  }, BUTTONS);
}

/** Per record: the box of its card and of each button, in the order of the screen. */
function geometry(page: Page) {
  return page.evaluate((selector) => {
    const box = (element: Element): Box => {
      const { bottom, height, left, right, top, width } =
        element.getBoundingClientRect();
      return { bottom, height, left, right, top, width };
    };
    return [...document.querySelectorAll(selector)].map((item) => {
      const card = item.querySelector('[data-slot="card"]');
      if (card === null) {
        throw new Error("a record has no card");
      }
      return {
        buttons: [...item.querySelectorAll("button, a[href]")].map(
          (button) => ({
            ...box(button),
            clientWidth: button.clientWidth,
            label: (button.textContent ?? "").trim(),
            scrollWidth: button.scrollWidth,
          })
        ),
        card: box(card),
        cause: item.getAttribute("data-cause"),
      };
    });
  }, ITEMS);
}

reflowTest(
  "a 320 px com letra de 20 px cada registro lê inteiro: título, motivo e código sem corte nem reticências",
  async ({ page }) => {
    await openWithThreeRecords(page, 320, 20);
    const list = frame(page);
    await assertNothingClipped(list);
    await assertNoEllipsis(list);
    await assertNoPageScroll(page);
  }
);

async function expectStackedButtons(page: Page, labels: string[][]) {
  const records = await geometry(page);
  expect(
    records.map((record) => record.buttons.map((button) => button.label))
  ).toEqual(labels);
  for (const record of records) {
    const lefts = new Set(
      record.buttons.map((button) => Math.round(button.left))
    );
    expect(lefts.size, `${record.cause}: os botões alinham à esquerda`).toBe(1);
    let previousBottom = Number.NEGATIVE_INFINITY;
    for (const button of record.buttons) {
      const name = `${record.cause}: ${button.label}`;
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
        record.card.right + 0.5
      );
      expect(button.left).toBeGreaterThanOrEqual(record.card.left - 0.5);
      expect(button.top, `${name} abaixo do anterior`).toBeGreaterThanOrEqual(
        previousBottom - 0.5
      );
      expect(button.right).toBeLessThanOrEqual(320);
      previousBottom = button.bottom;
    }
  }
  expect(await untouchable(page), "botões que não recebem o toque").toEqual([]);
  await assertNoEllipsis(page.locator(BUTTONS));
}

reflowTest(
  "a 320 px com letra de 20 px os botões de cada registro empilham, inteiros, dentro do cartão e com 44 px",
  async ({ page }) => {
    await openWithThreeRecords(page, 320, 20);
    expect((await geometry(page)).map((record) => record.cause)).toEqual([
      "insufficient_stock",
      "sku_conflict",
      "authorization_revoked",
    ]);
    await expectStackedButtons(page, [
      ["Reenviar venda", "Descartar…"],
      ["Descartar…"],
      ["Refazer esta venda", "Sair e entrar de novo", "Descartar…"],
    ]);
  }
);

reflowTest(
  "a 320 px com letra de 20 px a tela das Pendências com os quatro registros do laboratório das telas lê inteira",
  async ({ page }) => {
    await openReflowViewport(page, { fontPixels: 20, width: 320 });
    await serveLabWorker(page);
    await page.goto("/offline-screens-lab?screen=attention");
    await page.getByLabel("Usuário").fill(`user-${crypto.randomUUID()}`);
    await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
    await expect(page.getByTestId("message")).toContainText(
      "Iniciar: ok (ready)",
      { timeout: 20_000 }
    );
    await expect(page.locator(ITEMS)).toHaveCount(4);
    await expectReflowFont(page, 20);
    await expectStackedButtons(page, [
      ["Reenviar venda", "Descartar…"],
      ["Descartar…"],
      ["Ver Assinatura", "Tentar novamente"],
      ["Refazer esta venda", "Sair e entrar de novo", "Descartar…"],
    ]);
    const list = frame(page);
    await assertNothingClipped(list);
    await assertNoEllipsis(list);
    await assertNoPageScroll(page);
  }
);

reflowTest(
  "a 320 px com letra de 20 px a confirmação do descarte também empilha e cabe",
  async ({ page }) => {
    await openWithThreeRecords(page, 320, 20);
    await page.getByRole("button", { name: "Descartar…" }).last().click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    const confirm = dialog.getByRole("button", { name: "Confirmar descarte" });
    const keep = dialog.getByRole("button", { name: "Manter" });
    const boxes = await Promise.all([
      confirm.boundingBox(),
      keep.boundingBox(),
    ]);
    const [first, second] = boxes;
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    for (const box of boxes) {
      expect(box?.height).toBeGreaterThanOrEqual(TOUCH);
      expect(box?.width).toBeGreaterThanOrEqual(TOUCH);
    }
    expect(second?.y).toBeGreaterThanOrEqual(
      (first?.y ?? 0) + (first?.height ?? 0) - 0.5
    );
    await assertNothingClipped(dialog);
    await assertNoEllipsis(dialog);
    await assertNoPageScroll(page);
  }
);

const WIDE_WINDOW = 1280;

const ROWS_AT_16_PIXELS = [
  { maxRows: [1, 1, 2], width: 360 },
  { maxRows: [1, 1, 1], width: 1280 },
];

for (const { maxRows, width } of ROWS_AT_16_PIXELS) {
  reflowTest(
    `a ${width} px com letra de 16 px os botões seguem em linha e dentro do cartão, como sempre`,
    async ({ page }) => {
      await openWithThreeRecords(page, width, 16);
      const records = await geometry(page);
      const rows = records.map(
        (record) =>
          new Set(record.buttons.map((button) => Math.round(button.top))).size
      );
      for (const [index, count] of rows.entries()) {
        expect(count, `registro ${index + 1}`).toBeLessThanOrEqual(
          maxRows[index] ?? 1
        );
      }
      for (const record of records) {
        for (const button of record.buttons) {
          expect(button.right).toBeLessThanOrEqual(record.card.right + 0.5);
        }
      }
    },
    { coarse: width < WIDE_WINDOW }
  );
}
