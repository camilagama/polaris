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

async function openHistory(
  page: Page,
  sales: unknown[],
  { fontPixels = 20, hasMore = false, width = 320 } = {}
) {
  await openReflowViewport(page, { fontPixels, width });
  await page.clock.setFixedTime(new Date(NOW));
  await page.route("**/rpc/sale/list", (route: Route) =>
    route.fulfill({
      body: JSON.stringify({ json: { hasMore, sales }, meta: [] }),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    })
  );
  await serveLabWorker(page);
  await page.goto("/offline-screens-lab?screen=history");
  await page.getByLabel("Usuário").fill(`user-${crypto.randomUUID()}`);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await expect(
    page.getByRole("heading", { exact: true, name: "Histórico de vendas" })
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("[data-list-total]")).toBeVisible();
  await expectReflowFont(page, fontPixels);
  return page.locator("[data-list-total]");
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
    return [...document.querySelectorAll('ul[aria-label="Vendas"] > li')].map(
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
      const list = page.getByRole("list", { name: "Vendas" });
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
    const list = page.getByRole("list", { name: "Vendas" });
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
    [...document.querySelectorAll('ul[aria-label="Vendas"] > li')].map(
      (item) => {
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
            (rect) =>
              rect.right > clip.right + 0.5 || rect.left < clip.left - 0.5
          );
          if (past || node.scrollWidth > node.clientWidth + 1) {
            clippers.push(node.tagName.toLowerCase());
          }
        }
        return {
          belowName:
            Math.min(...rects.map((rect) => rect.top)) >= nameBottom - 1,
          clippers,
          insideRow: rects.every(
            (rect) =>
              rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5
          ),
          overMoney: rects.some(
            (rect) =>
              rect.right > money.left + 0.5 &&
              rect.bottom > money.top &&
              rect.top < money.bottom
          ),
          text: support.textContent ?? "",
        };
      }
    )
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
      const list = page.getByRole("list", { name: "Vendas" });
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
      const list = page.getByRole("list", { name: "Vendas" });
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
    [...document.querySelectorAll('ul[aria-label="Vendas"] > li')].map(
      (item) => {
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
      }
    )
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
      const list = page.getByRole("list", { name: "Vendas" });
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
      footer.locator("xpath=ancestor::*[@data-slot='card'][1]").boundingBox(),
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

reflowTest(
  "a 320 px com letra de 20 px o rodapé tem a mesma altura com e sem vendas",
  async ({ page }) => {
    const filled = await (
      await openHistory(page, manySales().slice(0, 3), { hasMore: true })
    ).boundingBox();
    await expect(page.locator("[data-list-total]")).toContainText("há mais");
    const empty = await (await openHistory(page, [])).boundingBox();
    await expect(page.locator("[data-list-total]")).toContainText("0 vendas");
    await expect(page.locator("[data-list-total]")).toContainText("R$ 0,00");
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
        .getByRole("list", { name: "Vendas" })
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
