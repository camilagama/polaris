/// <reference lib="dom" />
import type { Page, Route } from "@playwright/test";
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

/** Per line: its text, its height, and the pairs of text fragments that share some area. */
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
  test(`a ${width} px com letra de 20 px cada linha mostra hora, cliente, pagamento e valor inteiros, sem reticências nem sobreposição`, async ({
    page,
  }) => {
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
    expect(rows.some((row) => row.text.includes("Com devoluções"))).toBe(true);
    expect(rows.some((row) => row.text.includes("Retroativa"))).toBe(true);
    expect(rows.some((row) => row.text.includes("Cancelada"))).toBe(true);

    await assertNothingClipped(list);
    await assertNoEllipsis(list);
    await assertNoPageScroll(page);
  });
}

test("a 320 px com letra de 20 px o rodapé tem o valor com as duas casas, dentro do cartão, com 5 dígitos e com há mais", async ({
  page,
}) => {
  const footer = await openHistory(
    page,
    [entry(1, { totalDue: "7000.00" }), entry(2, { totalDue: "857.60" })],
    { hasMore: true }
  );
  await expect(footer).toContainText("2 vendas · há mais");
  const value = footer.locator(".tabular-nums");
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
});

test("a 320 px com letra de 20 px o rodapé tem a mesma altura com e sem vendas", async ({
  page,
}) => {
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
});

for (const width of [360, 1280]) {
  test(`a ${width} px com letra de 16 px a linha e o rodapé ficam lado a lado, como sempre`, async ({
    page,
  }) => {
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
      first.locator("span.inline-flex.tabular-nums").boundingBox(),
    ]);
    expect(
      Math.abs(
        (moneyBox?.y ?? 0) +
          (moneyBox?.height ?? 0) / 2 -
          ((rowBox?.y ?? 0) + (rowBox?.height ?? 0) / 2)
      )
    ).toBeLessThanOrEqual(2);
    const [value, count] = await Promise.all([
      footer.locator(".tabular-nums").boundingBox(),
      footer.getByText(COUNT_TEXT).boundingBox(),
    ]);
    expect(
      Math.abs(
        (value?.y ?? 0) +
          (value?.height ?? 0) -
          ((count?.y ?? 0) + (count?.height ?? 0))
      )
    ).toBeLessThanOrEqual(8);
  });
}
