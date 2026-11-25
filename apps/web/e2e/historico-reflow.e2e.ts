/// <reference lib="dom" />
import type { Page, Route } from "@playwright/test";
import { expect } from "@playwright/test";
import {
  assertNoEllipsis,
  assertNoPageScroll,
  assertNothingClipped,
  expectReflowFont,
  openReflowViewport,
  reflowTest,
  skipOutsideChromium,
} from "./reflow";
import { applyEditor } from "./filter-bar-editor";
import { serveLabWorker, WORKER_MARK } from "./worker-mark";

/**
 * The sales history read at 320 px with the browser font at 20 px (`./reflow`): every line shows the time, the
 * customer, the payment and the value whole, and the foot "Total na tela" shows the value with its two decimals inside
 * the card, as tall with sales as without. With the default font (16 px) the line and the foot are the ones they
 * always were.
 */
skipOutsideChromium();

const NOW = "2026-10-14T12:00:00.000Z";
const TOUCH = 44;
const ROWS = 49;
const LONG_CUSTOMER =
  "Maria Aparecida dos Santos Albuquerque Pereira de Oliveira Souza";
const SHORT_CUSTOMER = "Ana Paula";
const TIME = /\d{2}:\d{2}/;
const SITUATION_ITEM = /^Situação/;
const COUNT_TEXT = /^\d+ vendas?/;
const FOOT_VALUE = /^R\$ \d{1,3}(\.\d{3})*,\d{2}$/;

const id = (n: number) =>
  `0199c2d0-0000-7000-8000-000000001${String(n).padStart(3, "0")}`;

const entry = (n: number, overrides: Record<string, unknown> = {}) => ({
  cancelledAt: null,
  confirmedAt: "2026-10-14T12:00:01.000Z",
  customerId: null,
  customerName: null,
  hasReturns: false,
  id: id(n),
  itemCount: 2,
  occurredAt: "2026-10-14T12:00:00.000Z",
  occurredOn: "2026-10-14",
  paymentMethod: "pix",
  status: "confirmed",
  totalDue: "219.90",
  ...overrides,
});

const METHODS = [null, "bank_transfer", "credit_card", "cash", "pix"] as const;

function customerName(n: number) {
  if (n % 3 === 0) {
    return null;
  }
  return n % 2 === 0 ? LONG_CUSTOMER : SHORT_CUSTOMER;
}

/** 49 sales: long and short customers, no customer, no payment, returns, backdated and cancelled ones. */
function manySales() {
  return Array.from({ length: ROWS }, (_, index) => {
    const n = index + 1;
    return entry(n, {
      cancelledAt: n % 7 === 0 ? "2026-10-14T13:00:00.000Z" : null,
      customerId: n % 3 === 0 ? null : id(500 + n),
      customerName: customerName(n),
      hasReturns: n % 5 === 0,
      itemCount: n % 4 === 0 ? 1 : 12,
      occurredOn: n % 6 === 0 ? "2026-10-12" : "2026-10-14",
      paymentMethod: METHODS[n % METHODS.length],
      status: n % 7 === 0 ? "cancelled" : "confirmed",
      totalDue: n % 2 === 0 ? "12345.67" : `${n * 111}.50`,
    });
  });
}

interface Asked {
  occurredFrom?: string;
  status?: string;
}

interface OpenOptions {
  /** The sales the list answers for the request; the default answers `sales` whatever was asked. */
  answer?: (asked: Asked) => unknown[];
  fontPixels?: number;
  hasMore?: boolean;
  /** What the server reads for a period alone (the Resultado's figures). */
  period?: { netSales: string; salesCount: number };
  /** False for a store with no sale and no filter: the screen has the empty state, no frame and no total. */
  total?: boolean;
  width?: number;
}

async function openHistory(
  page: Page,
  sales: unknown[],
  {
    answer,
    fontPixels = 20,
    hasMore = false,
    period,
    total = true,
    width = 320,
  }: OpenOptions = {}
) {
  await openReflowViewport(page, { fontPixels, width });
  await page.clock.setFixedTime(new Date(NOW));
  await page.route("**/rpc/sale/list", (route: Route) => {
    const asked = (route.request().postDataJSON() as { json: Asked }).json;
    return route.fulfill({
      body: JSON.stringify({
        json: { hasMore, sales: answer ? answer(asked) : sales },
        meta: [],
      }),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    });
  });
  if (period) {
    await page.route("**/rpc/report/periodSummary", (route: Route) =>
      route.fulfill({
        body: JSON.stringify({ json: { cards: period }, meta: [] }),
        contentType: "application/json",
        headers: { ...WORKER_MARK },
      })
    );
  }
  await serveLabWorker(page);
  await page.goto("/offline-screens-lab?screen=history");
  await page.getByLabel("Usuário").fill(`user-${crypto.randomUUID()}`);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await expect(
    page.getByRole("heading", { exact: true, name: "Histórico de vendas" })
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    page.locator(total ? "[data-list-total]" : "[data-empty-state]")
  ).toBeVisible();
  await expectReflowFont(page, fontPixels);
  return page.locator("[data-list-total]");
}

/** The period of the title line, the "7 dias" shortcut: a filter on that the test's server answers with no sale. */
async function chooseSevenDays(page: Page) {
  await page.locator('header button[aria-label^="Período"]').click();
  const popup = page.getByRole("dialog", { name: "Período" });
  await popup
    .getByRole("group", { name: "Atalhos do período" })
    .getByRole("button", { exact: true, name: "7 dias" })
    .click();
  await expect(popup).toBeHidden();
}

/** The "Situação" pill with "Canceladas", added from the "Filtrar" menu of the bar. */
async function chooseCancelled(page: Page) {
  await page
    .getByRole("search", { exact: true, name: "Filtrar vendas" })
    .getByRole("button", { exact: true, name: "Filtrar" })
    .click();
  await page
    .getByRole("menu", { name: "Filtrar por" })
    .getByRole("menuitem", { name: SITUATION_ITEM })
    .click();
  const editor = page.getByRole("dialog", { name: "Situação" });
  await editor.getByRole("button", { exact: true, name: "Canceladas" }).click();
  await applyEditor(page, editor);
  await expect(editor).toBeHidden();
}

interface RowGeometry {
  height: number;
  inside: boolean;
  overlaps: string[];
  text: string;
}

/**
 * Per line: its text, its height, and the pairs of text fragments that share some area. The text only for the screen
 * reader (`sr-only`) is a clipped 1 px box that a range still measures at full width: it is not a block anyone sees.
 */
function rowGeometry(page: Page) {
  return page.evaluate(() => {
    interface Fragment {
      rect: DOMRect;
      text: string;
    }
    const fragmentsOf = (item: Element) => {
      const found: Fragment[] = [];
      const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent?.trim() ?? "";
        if (node.parentElement?.closest(".sr-only")) {
          continue;
        }
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          if (text !== "" && rect.width > 0) {
            found.push({ rect, text });
          }
        }
      }
      return found;
    };
    const shared = (a: DOMRect, b: DOMRect) =>
      Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
      Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
    const overlapsOf = (fragments: Fragment[]) =>
      fragments.flatMap((a, index) =>
        fragments
          .slice(index + 1)
          .filter((b) => shared(a.rect, b.rect))
          .map((b) => `${a.text} x ${b.text}`)
      );
    return [...document.querySelectorAll("[data-list-block] ul > li")].map(
      (item): RowGeometry => {
        const box = item.getBoundingClientRect();
        const fragments = fragmentsOf(item);
        return {
          height: box.height,
          inside: fragments.every(
            ({ rect }) =>
              rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5
          ),
          overlaps: overlapsOf(fragments),
          text: item.textContent ?? "",
        };
      }
    );
  });
}

for (const width of [320, 360]) {
  reflowTest(
    `a ${width} px com letra de 20 px cada linha mostra hora, cliente, pagamento e valor inteiros, sem reticências nem sobreposição`,
    async ({ page }) => {
      const sales = manySales();
      await openHistory(page, sales, { width });
      const list = page.getByRole("list", {
        exact: true,
        name: "Vendas do período",
      });
      await expect(list.locator("> li")).toHaveCount(ROWS);

      const rows = await rowGeometry(page);
      for (const [index, row] of rows.entries()) {
        const sale = sales[index];
        const name = `linha ${index + 1}`;
        expect(row.text, `${name}: a hora`).toMatch(TIME);
        if (sale?.customerName) {
          expect(row.text, `${name}: o cliente inteiro`).toContain(
            sale.customerName
          );
        }
        expect(row.text, `${name}: o valor`).toContain(
          Number(sale?.totalDue).toLocaleString("pt-BR", {
            minimumFractionDigits: 2,
          })
        );
        expect(row.overlaps, `${name}: blocos sobrepostos`).toEqual([]);
        expect(row.inside, `${name}: tudo dentro da linha`).toBe(true);
        expect(row.height, `${name}: alvo de toque`).toBeGreaterThanOrEqual(
          TOUCH
        );
      }
      expect(
        rows.some((row) => row.text.includes("Pagamento não informado"))
      ).toBe(true);
      expect(rows.some((row) => row.text.includes("Transferência"))).toBe(true);
      expect(rows.some((row) => row.text.includes("Com devoluções"))).toBe(
        true
      );
      expect(rows.some((row) => row.text.includes("Retroativa"))).toBe(true);
      expect(rows.some((row) => row.text.includes("Cancelada"))).toBe(true);

      await assertNothingClipped(list);
      await assertNoEllipsis(list);
      await assertNoPageScroll(page);
    }
  );
}

const SEVEN_DIGITS = "1234567.89";

function methodRows() {
  return [
    entry(1, {
      customerId: id(501),
      customerName: LONG_CUSTOMER,
      paymentMethod: "credit_card",
      totalDue: SEVEN_DIGITS,
    }),
    entry(2, { paymentMethod: "credit_card", totalDue: SEVEN_DIGITS }),
    entry(3, { paymentMethod: "bank_transfer", totalDue: SEVEN_DIGITS }),
    entry(4, { paymentMethod: null, totalDue: SEVEN_DIGITS }),
    entry(5, {
      customerId: id(505),
      customerName: SHORT_CUSTOMER,
      paymentMethod: "debit_card",
      totalDue: SEVEN_DIGITS,
    }),
  ];
}

const TWO_PARTS = [
  ["pix", "credit_card"],
  ["bank_transfer", "bank_transfer"],
  ["pix", "pix"],
  ["bank_transfer", "other"],
] as const;
const TWO_PARTS_TEXTS = [
  "Pix + Crédito",
  "Transferência + Transferência",
  "Pix + Pix",
  "Transferência + Outro",
  "Transferência",
];
const MEDIUM_CUSTOMER = "Ângela Souza Albuquerque";

function twoPartsSales(customer = SHORT_CUSTOMER) {
  return [
    ...TWO_PARTS.map((methods, index) =>
      entry(index + 1, {
        customerId: id(500 + index),
        customerName: customer,
        paymentMethod: methods[0],
        paymentMethods: methods,
      })
    ),
    entry(5, {
      customerId: id(504),
      customerName: customer,
      paymentMethod: "bank_transfer",
    }),
  ];
}

reflowTest(
  "a 320 px com letra de 20 px a linha de venda em 2 partes mostra os dois métodos inteiros, sem sobreposição nem reticências",
  async ({ page }) => {
    const sales = twoPartsSales();
    await openHistory(page, sales);
    const list = page.getByRole("list", {
      exact: true,
      name: "Vendas do período",
    });
    await expect(list.locator("> li")).toHaveCount(sales.length);
    const rows = await rowGeometry(page);
    for (const [index, row] of rows.entries()) {
      const name = `linha ${index + 1}`;
      expect(row.text, name).toContain(TWO_PARTS_TEXTS[index] ?? "");
      expect(row.overlaps, `${name}: blocos sobrepostos`).toEqual([]);
      expect(row.inside, `${name}: tudo dentro da linha`).toBe(true);
      expect(row.height, `${name}: alvo de toque`).toBeGreaterThanOrEqual(
        TOUCH
      );
    }
    await assertNothingClipped(list);
    await assertNoEllipsis(list);
    await assertNoPageScroll(page);
  }
);

/**
 * Per line, for the methods and the count (the last piece of the line under the date): the boxes up to the line that
 * hide part of it (a box that scrolls, or one the text goes past: what the eye loses, not only what the DOM holds),
 * whether it stays inside the line and clear of the value, and whether it starts under the end of the name.
 */
function visibleMethods(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("[data-list-block] ul > li")].map((item) => {
      const support = item.querySelector("p.text-support") as HTMLElement;
      const name = support.firstElementChild as HTMLElement;
      const method = support.lastElementChild as HTMLElement;
      const box = item.getBoundingClientRect();
      const money = (
        item.querySelector("[data-money]") as HTMLElement
      ).getBoundingClientRect();
      const textRects = (element: HTMLElement) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return [...range.getClientRects()].filter((rect) => rect.width > 0);
      };
      const rects = textRects(method);
      const nameBottom = Math.max(...textRects(name).map((r) => r.bottom));
      const clippers: string[] = [];
      for (
        let node: HTMLElement | null = method;
        node !== null && node !== item;
        node = node.parentElement
      ) {
        if (getComputedStyle(node).overflowX === "visible") {
          continue;
        }
        const clip = node.getBoundingClientRect();
        const past = rects.some(
          (rect) => rect.right > clip.right + 0.5 || rect.left < clip.left - 0.5
        );
        if (past || node.scrollWidth > node.clientWidth + 1) {
          clippers.push(node.tagName.toLowerCase());
        }
      }
      return {
        belowName: Math.min(...rects.map((rect) => rect.top)) >= nameBottom - 1,
        clippers,
        insideRow: rects.every(
          (rect) => rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5
        ),
        overMoney: rects.some(
          (rect) =>
            rect.right > money.left + 0.5 &&
            rect.bottom > money.top &&
            rect.top < money.bottom
        ),
        text: support.textContent ?? "",
      };
    })
  );
}

for (const { fontPixels, width } of [
  { fontPixels: 16, width: 320 },
  { fontPixels: 16, width: 360 },
  { fontPixels: 16, width: 800 },
  { fontPixels: 20, width: 320 },
  { fontPixels: 20, width: 360 },
]) {
  reflowTest(
    `a ${width} px com letra de ${fontPixels} px os dois métodos da venda em 2 partes ficam inteiros, sem reticências, e nada passa sobre o valor`,
    async ({ page }) => {
      const sales = twoPartsSales();
      await openHistory(page, sales, { fontPixels, width });
      const list = page.getByRole("list", {
        exact: true,
        name: "Vendas do período",
      });
      await expect(list.locator("> li")).toHaveCount(sales.length);
      const measures = await visibleMethods(page);
      for (const [index, measure] of measures.entries()) {
        const name = `linha ${index + 1}`;
        expect(measure.text, name).toContain(TWO_PARTS_TEXTS[index] ?? "");
        expect(
          measure.clippers,
          `${name}: o método e a contagem inteiros`
        ).toEqual([]);
        expect(measure.insideRow, `${name}: dentro da linha`).toBe(true);
        expect(measure.overMoney, `${name}: nada sobre o valor`).toBe(false);
        if (measure.text.includes(" + ")) {
          expect(
            measure.belowName,
            `${name}: os métodos na linha de baixo do nome`
          ).toBe(true);
        }
      }
      await assertNoEllipsis(list);
      await assertNoPageScroll(page);
    }
  );

  reflowTest(
    `a ${width} px com letra de ${fontPixels} px com o nome médio a venda em 2 partes só corta o fim do nome e os dois métodos ficam inteiros`,
    async ({ page }) => {
      const sales = twoPartsSales(MEDIUM_CUSTOMER);
      await openHistory(page, sales, { fontPixels, width });
      const list = page.getByRole("list", {
        exact: true,
        name: "Vendas do período",
      });
      await expect(list.locator("> li")).toHaveCount(sales.length);
      const measures = await visibleMethods(page);
      const cuts = await cutTexts(page);
      for (const [index, measure] of measures.entries()) {
        const name = `linha ${index + 1}`;
        expect(measure.text, name).toContain(TWO_PARTS_TEXTS[index] ?? "");
        expect(
          measure.clippers,
          `${name}: o método e a contagem inteiros`
        ).toEqual([]);
        expect(measure.insideRow, `${name}: dentro da linha`).toBe(true);
        expect(measure.overMoney, `${name}: nada sobre o valor`).toBe(false);
        if (measure.text.includes(" + ")) {
          expect(
            measure.belowName,
            `${name}: os métodos na linha de baixo do nome`
          ).toBe(true);
        }
        expect(
          cuts[index]?.cut.filter((text) => text !== MEDIUM_CUSTOMER),
          `${name}: só o fim do nome leva reticências`
        ).toEqual([]);
      }
      await assertNoPageScroll(page);
    }
  );
}

/** Per line: the text an ellipsis is hiding (what the line cuts), and whether the value box is whole and inside the line. */
function cutTexts(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("[data-list-block] ul > li")].map((item) => {
      const box = item.getBoundingClientRect();
      const money = item.querySelector("[data-money]");
      const moneyBox = money?.getBoundingClientRect();
      const cut = [...item.querySelectorAll("*")]
        .filter(
          (element) =>
            getComputedStyle(element).textOverflow === "ellipsis" &&
            element.scrollWidth > element.clientWidth + 1
        )
        .map((element) => element.textContent ?? "");
      const hidden = [...item.querySelectorAll("*")]
        .filter(
          (element) =>
            !element.closest(".sr-only") &&
            getComputedStyle(element).overflowX === "hidden" &&
            element.scrollWidth > element.clientWidth + 1
        )
        .map((element) => element.textContent ?? "");
      return {
        cut,
        hidden,
        moneyInside:
          moneyBox !== undefined &&
          moneyBox.left >= box.left - 0.5 &&
          moneyBox.right <= box.right + 0.5 &&
          (money?.scrollWidth ?? 0) <= (money?.clientWidth ?? 0) + 1,
        text: item.textContent ?? "",
      };
    })
  );
}

for (const { fontPixels, width } of [
  { fontPixels: 16, width: 320 },
  { fontPixels: 16, width: 360 },
  { fontPixels: 16, width: 800 },
  { fontPixels: 20, width: 320 },
  { fontPixels: 20, width: 360 },
]) {
  reflowTest(
    `a ${width} px com letra de ${fontPixels} px o valor de 7 dígitos fica inteiro e o método nunca é cortado: só o fim do nome do cliente`,
    async ({ page }) => {
      await openHistory(page, methodRows(), { fontPixels, width });
      const list = page.getByRole("list", {
        exact: true,
        name: "Vendas do período",
      });
      await expect(list.locator("> li")).toHaveCount(5);
      const rows = await cutTexts(page);
      const methods = [
        "Crédito",
        "Crédito",
        "Transferência",
        "Pagamento não informado",
        "Débito",
      ];
      for (const [index, row] of rows.entries()) {
        const method = methods[index] ?? "";
        const name = `linha ${index + 1}`;
        expect(row.text, `${name}: o método`).toContain(method);
        expect(row.text, `${name}: o valor`).toContain("1.234.567,89");
        expect(row.moneyInside, `${name}: o valor inteiro e dentro`).toBe(true);
        expect(
          row.hidden.filter((text) => !row.cut.includes(text)),
          `${name}: nada escondido pelo recorte da linha`
        ).toEqual([]);
        expect(row.text, `${name}: a hora`).toMatch(TIME);
        expect(
          row.cut.filter((text) => index !== 0 || text !== LONG_CUSTOMER),
          `${name}: só o fim do nome longo leva reticências`
        ).toEqual([]);
      }
      await assertNoPageScroll(page);
    }
  );
}

reflowTest(
  "a 320 px com letra de 20 px o rodapé tem o valor com as duas casas, dentro do cartão, com 5 dígitos e com há mais",
  async ({ page }) => {
    const footer = await openHistory(
      page,
      [entry(1, { totalDue: "7000.00" }), entry(2, { totalDue: "857.60" })],
      { hasMore: true }
    );
    await expect(footer).toContainText("2 vendas · há mais");
    const value = footer.locator(".tabular-nums").first();
    const text = (await value.textContent())?.trim() ?? "";
    expect(text).toMatch(FOOT_VALUE);
    expect(text).toBe("R$ 7.857,60");

    const [card, valueBox, countBox] = await Promise.all([
      footer.locator("xpath=ancestor::*[@data-list-block][1]").boundingBox(),
      value.boundingBox(),
      footer.getByText("2 vendas · há mais").boundingBox(),
    ]);
    expect(card).not.toBeNull();
    expect(valueBox).not.toBeNull();
    expect(countBox).not.toBeNull();
    expect((valueBox?.x ?? 0) + (valueBox?.width ?? 0)).toBeLessThanOrEqual(
      (card?.x ?? 0) + (card?.width ?? 0)
    );
    expect(valueBox?.x ?? 0).toBeGreaterThanOrEqual(card?.x ?? 0);
    // stacked: the value is under the count, not beside it
    expect(valueBox?.y ?? 0).toBeGreaterThanOrEqual(
      (countBox?.y ?? 0) + (countBox?.height ?? 0) - 1
    );
    await assertNothingClipped(footer);
    await assertNoEllipsis(footer);
    await assertNoPageScroll(page);
  }
);

const totalBox = (page: Page) =>
  page.locator("[data-list-total]").boundingBox();

reflowTest(
  "a 320 px com letra de 20 px o filtro sem resultado deixa o rodapé na mesma altura de com vendas",
  async ({ page }) => {
    await openHistory(page, manySales().slice(0, 3), { hasMore: true });
    await expect(page.locator("[data-list-total]")).toContainText("há mais");
    const filled = await totalBox(page);
    await openHistory(page, manySales(), {
      answer: (asked) => (asked.status === "cancelled" ? [] : manySales()),
    });
    await chooseCancelled(page);
    await expect(page.locator("[data-list-block]")).toContainText(
      "Nenhuma venda encontrada com estes filtros."
    );
    await expect(page.locator("[data-list-total]")).toContainText("0 vendas");
    await expect(page.locator("[data-list-total]")).toContainText("R$ 0,00");
    const empty = await totalBox(page);
    expect(filled).not.toBeNull();
    expect(empty).not.toBeNull();
    expect(
      Math.abs((filled?.height ?? 0) - (empty?.height ?? 0))
    ).toBeLessThanOrEqual(1);
  }
);

const WIDE_WINDOW = 1280;

for (const width of [360, WIDE_WINDOW]) {
  reflowTest(
    `a ${width} px com letra de 16 px a linha e o rodapé ficam lado a lado, como sempre`,
    async ({ page }) => {
      const footer = await openHistory(page, manySales().slice(0, 6), {
        fontPixels: 16,
        width,
      });
      const first = page
        .getByRole("list", { exact: true, name: "Vendas do período" })
        .locator("> li")
        .first();
      const [rowBox, moneyBox] = await Promise.all([
        first.boundingBox(),
        first.locator("[data-money]").boundingBox(),
      ]);
      expect(
        Math.abs(
          (moneyBox?.y ?? 0) +
            (moneyBox?.height ?? 0) / 2 -
            ((rowBox?.y ?? 0) + (rowBox?.height ?? 0) / 2)
        )
      ).toBeLessThanOrEqual(2);
      const [value, count] = await Promise.all([
        footer.locator(".tabular-nums").first().boundingBox(),
        footer.getByText(COUNT_TEXT).boundingBox(),
      ]);
      expect(
        Math.abs(
          (value?.y ?? 0) +
            (value?.height ?? 0) -
            ((count?.y ?? 0) + (count?.height ?? 0))
        )
      ).toBeLessThanOrEqual(8);
    },
    { coarse: width !== WIDE_WINDOW }
  );
}

/** The frame of the history: the title and the count in it, the controls above it, the lines edge to edge and the total last. */
for (const width of [360, WIDE_WINDOW]) {
  reflowTest(
    `a ${width} px a lista é uma moldura com título e contagem, os controles ficam acima dela e o total é a última linha do painel`,
    async ({ page }) => {
      const footer = await openHistory(page, manySales().slice(0, 6), {
        fontPixels: 16,
        width,
      });
      const block = page.locator("[data-list-block]");
      await expect(
        block.getByRole("heading", { level: 2, name: "Vendas do período" })
      ).toBeVisible();
      await expect(block.locator("[data-list-count]")).toHaveText("6 vendas");
      await expect(
        block.getByRole("list", { name: "Vendas do período" })
      ).toBeVisible();
      await expect(
        block.getByRole("search", { name: "Filtrar vendas" })
      ).toHaveCount(0);

      const controls = page.getByRole("search", { name: "Filtrar vendas" });
      const [blockBox, controlsBox, panelBox, footerBox, firstRow, lastRow] =
        await Promise.all([
          block.boundingBox(),
          controls.boundingBox(),
          block.locator("[data-list-block-scroll]").boundingBox(),
          footer.boundingBox(),
          block.locator("ul > li").first().boundingBox(),
          block.locator("ul > li").last().boundingBox(),
        ]);
      for (const box of [
        blockBox,
        controlsBox,
        panelBox,
        footerBox,
        firstRow,
        lastRow,
      ]) {
        expect(box).not.toBeNull();
      }
      expect(
        (blockBox?.y ?? 0) -
          ((controlsBox?.y ?? 0) + (controlsBox?.height ?? 0))
      ).toBeGreaterThanOrEqual(15);
      expect(Math.abs((firstRow?.x ?? 0) - (panelBox?.x ?? 0))).toBeLessThan(1);
      expect(
        Math.abs(
          (firstRow?.x ?? 0) +
            (firstRow?.width ?? 0) -
            ((panelBox?.x ?? 0) + (panelBox?.width ?? 0))
        )
      ).toBeLessThan(1);
      expect(
        (footerBox?.y ?? 0) + 1 >= (lastRow?.y ?? 0) + (lastRow?.height ?? 0)
      ).toBe(true);
      expect(
        Math.abs(
          (footerBox?.y ?? 0) +
            (footerBox?.height ?? 0) -
            ((panelBox?.y ?? 0) + (panelBox?.height ?? 0))
        )
      ).toBeLessThan(1);
    },
    { coarse: width !== WIDE_WINDOW }
  );
}

reflowTest(
  "sem nenhuma venda e sem filtro é só o estado vazio: sem moldura, sem título da lista e sem total",
  async ({ page }) => {
    await openHistory(page, [], {
      fontPixels: 16,
      total: false,
      width: WIDE_WINDOW,
    });
    const empty = page.locator("[data-empty-state]");
    await expect(empty).toContainText("Nenhuma venda ainda.");
    await expect(empty).toContainText(
      "Registre a primeira venda para vê-la aqui."
    );
    await expect(
      empty.getByRole("link", { name: "Registrar uma venda" })
    ).toBeVisible();
    await expect(page.locator("[data-list-block]")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { level: 2, name: "Vendas do período" })
    ).toHaveCount(0);
    await expect(page.locator("[data-list-total]")).toHaveCount(0);
    await expect(
      page.getByRole("search", { name: "Filtrar vendas" })
    ).toBeVisible();
  },
  { coarse: false }
);

reflowTest(
  "a 320 px com letra de 20 px o período sem vendas fica na moldura com a frase, Limpar filtros e o total R$ 0,00 inteiro",
  async ({ page }) => {
    await openHistory(page, manySales(), {
      answer: (asked) => (asked.occurredFrom ? [] : manySales()),
      period: { netSales: "0.00", salesCount: 0 },
    });
    await chooseSevenDays(page);
    const block = page.locator("[data-list-block]");
    await expect(
      block.getByRole("heading", { level: 2, name: "Vendas do período" })
    ).toBeVisible();
    await expect(block.locator("[data-list-block-notice]")).toContainText(
      "Nenhuma venda encontrada com estes filtros."
    );
    await expect(
      block.getByRole("button", { name: "Limpar filtros" })
    ).toBeVisible();
    await expect(block.locator("[data-list-count]")).toHaveText("0 vendas");
    await expect(block.locator("[data-list-total]")).toContainText("R$ 0,00");
    await expect(block.locator("[data-list-total]")).toContainText("0 vendas");
    await expect(page.locator("[data-empty-state]")).toHaveCount(0);
    await assertNothingClipped(block.locator("[data-list-total]"));
    await assertNoPageScroll(page);
  }
);

/** The count beside the title is the rows on the screen: a cancelled sale is a row, the total does not sum it. */
const COUNT_WIDTH = 360;

reflowTest(
  `a ${COUNT_WIDTH} px a contagem do cabeçalho conta as linhas na tela, a cancelada incluída, e o rodapé só o que soma`,
  async ({ page }) => {
    const footer = await openHistory(page, manySales().slice(0, 8), {
      fontPixels: 16,
      width: COUNT_WIDTH,
    });
    const block = page.locator("[data-list-block]");
    await expect(block.locator("ul > li")).toHaveCount(8);
    await expect(block.locator("[data-list-count]")).toHaveText("8 vendas");
    await expect(footer).toContainText("7 vendas");
    await expect(footer).toContainText("1 cancelada fica fora da soma.");
    await expect(footer).not.toContainText("8 vendas");
  }
);

reflowTest(
  `a ${COUNT_WIDTH} px com mais a carregar o cabeçalho diz "há mais" depois das linhas na tela`,
  async ({ page }) => {
    await openHistory(page, manySales().slice(0, 8), {
      fontPixels: 16,
      hasMore: true,
      width: COUNT_WIDTH,
    });
    await expect(page.locator("[data-list-count]")).toHaveText(
      "8 vendas · há mais"
    );
  }
);

reflowTest(
  `a ${COUNT_WIDTH} px com o filtro só de canceladas o cabeçalho conta as linhas e o total fica zerado`,
  async ({ page }) => {
    const cancelled = manySales()
      .filter((sale) => sale.status === "cancelled")
      .slice(0, 3);
    const footer = await openHistory(page, manySales(), {
      answer: (asked) =>
        asked.status === "cancelled" ? cancelled : manySales(),
      fontPixels: 16,
      width: COUNT_WIDTH,
    });
    await chooseCancelled(page);
    const block = page.locator("[data-list-block]");
    await expect(block.locator("ul > li")).toHaveCount(3);
    await expect(block.locator("[data-list-count]")).toHaveText("3 vendas");
    await expect(footer).toContainText("0 vendas");
    await expect(footer).toContainText("R$ 0,00");
    await expect(footer).toContainText("3 canceladas ficam fora da soma.");
  }
);
