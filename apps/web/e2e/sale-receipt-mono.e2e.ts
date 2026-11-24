/// <reference lib="dom" />
import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  assertAmountsOnOneLine,
  assertNoPageScroll,
  assertNothingClipped,
  expectReflowFont,
  openReflowViewport,
  reflowTest,
  skipOutsideChromium,
} from "./reflow";
import { serveLabWorker, WORKER_MARK } from "./worker-mark";

/**
 * The receipt of the sale detail writes its amounts in Geist Mono, at the right: every amount of the lines in the face
 * of the mono, ending at the same edge; the names and the labels in Geist; the mask in the same cell; 320 px with the
 * letter at 20 px with a nine-digit amount and a name of 60 characters; and the arrival of the mono face moving nothing.
 */
skipOutsideChromium();

const SALE_ID = "0199c2d0-0000-7000-8000-0000000000d1";
const PRODUCT = "0199c2d0-0000-7000-8000-0000000000d2";
const VARIANT = "0199c2d0-0000-7000-8000-0000000000d3";
const NOW = new Date("2026-10-14T12:00:00-03:00");
const AT = NOW.toISOString();
const STORE_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo",
}).format(NOW);
const NO_FEE = {
  amount: null,
  basisPoints: null,
  fixedAmount: null,
  mode: "not_applicable",
  percentage: null,
};
const RPC_PREFIX = /^\/rpc\//;
const LONG_NAME =
  "Camiseta de algodão orgânico com estampa exclusiva da coleção de verão";
const MONO_FONT_FILE = "**/geist-mono-latin-wght-normal*.woff2";
const MONO_FAMILY = "Geist Mono Variable";
const AMOUNT_OR_MASK_SOURCE = String.raw`[-+−]?R\$ (?:[\d.]+,\d{2}|••••)`;
const AMOUNT_SOURCE = String.raw`R\$ [\d.]+,\d{2}`;
const SLACK_PIXELS = 1;
const SHIFT_BUDGET = 0.01;
const OVERLAP_SLACK_PIXELS = 0.5;
const MASKED_MONEY_CELL = /^R\$ ••••/;

const saleOf = ({
  discount,
  name,
  price,
  subtotal,
  total,
}: {
  discount: string;
  name: string;
  price: string;
  subtotal: string;
  total: string;
}) => ({
  cancellation: null,
  customer: { customerId: null, version: 0 },
  returnSummary: [
    {
      availableToReturn: 1,
      position: 0,
      restockedQuantity: 0,
      returnedQuantity: 0,
      sold: 1,
    },
  ],
  returns: [],
  sale: {
    adjustments: [
      {
        amount: discount,
        kind: "discount",
        percentage: null,
        position: 0,
        valueType: "fixed",
      },
    ],
    items: [
      {
        chargedUnitPrice: price,
        listedUnitPrice: price,
        position: 0,
        productId: PRODUCT,
        productLabel: name,
        quantity: 1,
        unitCost: "17.00",
        variantId: VARIANT,
      },
    ],
    payment: {
      amount: total,
      anticipationFee: NO_FEE,
      anticipationRequested: false,
      expectedSettlementDays: null,
      installmentPlan: null,
      installments: null,
      method: "cash",
      paymentProfileId: null,
      paymentProfileName: null,
      paymentProfileRuleId: null,
      paymentProfileVersion: null,
      processingFee: {
        amount: "5.50",
        basisPoints: null,
        fixedAmount: null,
        mode: "percentage",
        percentage: "2.5",
      },
    },
    sale: {
      commandId: "0199c2d0-0000-7000-8000-0000000000d4",
      confirmedAt: AT,
      currency: "BRL",
      id: SALE_ID,
      occurredAt: AT,
      occurredOn: STORE_DAY,
      recordedAt: null,
    },
    totals: {
      discountTotal: discount,
      freightTotal: "0.00",
      paymentSurchargeTotal: "0.00",
      subtotal,
      surchargeTotal: "0.00",
      totalDue: total,
    },
  },
});

const ORDINARY = saleOf({
  discount: "10.00",
  name: "Camiseta básica",
  price: "219.90",
  subtotal: "219.90",
  total: "209.90",
});
const HUGE = saleOf({
  discount: "34567.89",
  name: LONG_NAME,
  price: "1234567.89",
  subtotal: "1234567.89",
  total: "1200000.00",
});

const answer = (body: unknown) => ({
  body: JSON.stringify({ json: body, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
});

interface OpenOptions {
  fontPixels?: number;
  hidden?: boolean;
  sale: ReturnType<typeof saleOf>;
  size?: { height: number; width: number };
}

async function openDetail(page: Page, options: OpenOptions) {
  if (options.fontPixels) {
    await openReflowViewport(page, { fontPixels: options.fontPixels });
  } else if (options.size) {
    await page.setViewportSize(options.size);
  }
  if (options.hidden) {
    await page.addInitScript(() => {
      window.localStorage.setItem("polaris-valores", "escondidos");
    });
  }
  await page.route("**/rpc/**", async (route: Route) => {
    const procedure = new URL(route.request().url()).pathname.replace(
      RPC_PREFIX,
      ""
    );
    if (procedure === "sale/get") {
      await route.fulfill(answer(options.sale));
      return;
    }
    if (procedure === "sale/getCustomerLink") {
      await route.fulfill(
        answer({
          current: { customerId: null, version: 0 },
          history: [],
          saleId: SALE_ID,
        })
      );
      return;
    }
    if (procedure === "customer/list") {
      await route.fulfill(answer({ customers: [] }));
      return;
    }
    await route.abort("internetdisconnected");
  });
  await serveLabWorker(page);
  await page.clock.setFixedTime(NOW);
  await page.goto(`/offline-screens-lab?screen=sale-detail&saleId=${SALE_ID}`);
  await page.getByLabel("Usuário").fill(`user-${crypto.randomUUID()}`);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await expect(
    page.getByRole("heading", { exact: true, name: "Itens" })
  ).toBeVisible({ timeout: 20_000 });
}

interface Measured {
  edge: number;
  family: string;
  group: "card" | "payment" | "strip";
  text: string;
}

/**
 * Every amount written in the receipt (one per cell: a `dd` of the lines, the line of prices of an item): its text, its
 * face and the right edge of the text that shows (what only a screen reader reads is left out).
 */
const measureAmounts = (page: Page): Promise<Measured[]> =>
  page.evaluate((source) => {
    const AMOUNT = new RegExp(source);
    const receipt = document.querySelector(
      '[data-block="plain"][role="region"]'
    );
    if (!receipt) {
      throw new Error("the receipt is not on the screen");
    }
    const shownTexts = (cell: Element) => {
      const nodes: Text[] = [];
      const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const shows =
          !node.parentElement?.closest(".sr-only") && node.textContent?.trim();
        if (shows) {
          nodes.push(node as Text);
        }
      }
      return nodes;
    };
    const rightOf = (node: Text) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return range.getBoundingClientRect().right;
    };
    const cells = [
      ...receipt.querySelectorAll("dd, li > span:nth-child(2)"),
    ].filter((cell) => AMOUNT.test(cell.textContent ?? ""));
    const groupOf = (cell: Element): Measured["group"] => {
      if (cell.closest('[data-receipt-block="payment"]')) {
        return "payment";
      }
      return cell.closest("[data-receipt-totals]") ? "strip" : "card";
    };
    const found: Measured[] = cells.map((cell) => {
      const nodes = shownTexts(cell);
      const last = nodes.at(-1)?.parentElement ?? cell;
      return {
        edge: Math.max(...nodes.map(rightOf)),
        family: getComputedStyle(last).fontFamily,
        group: groupOf(cell),
        text: (cell.textContent ?? "").trim(),
      };
    });
    return found;
  }, AMOUNT_OR_MASK_SOURCE);

const receiptOf = (page: Page) =>
  page.getByRole("region", { exact: true, name: "Venda" });

for (const size of [
  { height: 740, width: 360 },
  { height: 800, width: 1280 },
]) {
  test(`recibo: todo valor em dinheiro em Geist Mono e na mesma borda direita a ${size.width} px`, async ({
    page,
  }) => {
    await openDetail(page, { sale: ORDINARY, size });
    const amounts = await measureAmounts(page);
    const card = amounts.filter((item) => item.group === "card");
    const payment = amounts.filter((item) => item.group === "payment");
    const strip = amounts.filter((item) => item.group === "strip");
    // item prices, subtotal and discount at the card; the total in the strip; the amount and the fee at the payment block
    expect(card).toHaveLength(3);
    expect(strip).toHaveLength(1);
    expect(payment).toHaveLength(2);
    for (const item of amounts) {
      expect(item.family.startsWith(`"${MONO_FAMILY}"`), item.text).toBe(true);
    }
    for (const group of [card, payment]) {
      const edges = group.map((item) => item.edge);
      expect(
        Math.max(...edges) - Math.min(...edges),
        group.map((item) => `${item.text}: ${item.edge}`).join(" | ")
      ).toBeLessThanOrEqual(SLACK_PIXELS);
    }
    const receipt = receiptOf(page);
    const names = await receipt
      .getByText("Camiseta básica", { exact: true })
      .evaluate((element) => getComputedStyle(element).fontFamily);
    expect(names.startsWith('"Geist Variable"')).toBe(true);
    const labels = await receipt
      .getByText("Subtotal", { exact: true })
      .evaluate((element) => getComputedStyle(element).fontFamily);
    expect(labels.startsWith('"Geist Variable"')).toBe(true);
    const paymentBlock = await receipt
      .locator('[data-receipt-block="payment"]')
      .evaluate((element) => {
        const box = element.getBoundingClientRect();
        const padding = Number.parseFloat(
          getComputedStyle(element).paddingRight
        );
        return box.right - padding;
      });
    expect(
      Math.abs(paymentBlock - (payment[0]?.edge ?? Number.NaN))
    ).toBeLessThanOrEqual(SLACK_PIXELS);
  });

  test(`recibo: a máscara fica na mesma célula, em mono e à direita a ${size.width} px`, async ({
    page,
  }) => {
    await openDetail(page, { hidden: true, sale: ORDINARY, size });
    const amounts = await measureAmounts(page);
    expect(amounts).toHaveLength(6);
    for (const item of amounts) {
      expect(item.text).toContain("••••");
      expect(item.family.startsWith(`"${MONO_FAMILY}"`), item.text).toBe(true);
    }
    const card = amounts.filter((item) => item.group === "card");
    const edges = card.map((item) => item.edge);
    expect(Math.max(...edges) - Math.min(...edges)).toBeLessThanOrEqual(
      SLACK_PIXELS
    );
    const strip = receiptOf(page).locator("[data-receipt-totals]");
    await expect(strip.locator("dd")).toHaveText([MASKED_MONEY_CELL, "1"]);
  });
}

interface StripBox {
  left: number;
  top: number;
  width: number;
}

const expectStripCellsApart = async (page: Page) => {
  const rects = await receiptOf(page)
    .locator("[data-receipt-totals] > div")
    .evaluateAll((cells) =>
      cells.map((cell) => {
        const box = cell.getBoundingClientRect();
        const text = [...cell.querySelectorAll("dt, dd")].map((part) => {
          const range = document.createRange();
          range.selectNodeContents(part);
          return range.getBoundingClientRect();
        });
        return {
          bottom: box.bottom,
          left: box.left,
          overflow: Math.max(...text.map((rect) => rect.right)) - box.right,
          right: box.right,
          top: box.top,
        };
      })
    );
  for (const [index, rect] of rects.entries()) {
    expect(rect.overflow, `cell ${index} holds its text`).toBeLessThanOrEqual(
      OVERLAP_SLACK_PIXELS
    );
    for (const other of rects.slice(index + 1)) {
      const apart =
        rect.right <= other.left + OVERLAP_SLACK_PIXELS ||
        other.right <= rect.left + OVERLAP_SLACK_PIXELS ||
        rect.bottom <= other.top + OVERLAP_SLACK_PIXELS ||
        other.bottom <= rect.top + OVERLAP_SLACK_PIXELS;
      expect(apart, `cells ${index} and the next do not overlap`).toBe(true);
    }
  }
};

const expectSplitTotalOnOneLine = async (page: Page) => {
  const parts = await receiptOf(page)
    .locator("[data-receipt-totals]")
    .evaluate((strip) =>
      ["[data-money-currency]", "[data-money-number]"].map((selector) => {
        const box = strip.querySelector(selector)?.getBoundingClientRect();
        return { bottom: box?.bottom ?? 0, top: box?.top ?? 0 };
      })
    );
  const [currency, number] = parts;
  expect(
    currency?.bottom,
    "the R$ and the number share a line"
  ).toBeGreaterThan(number?.top ?? Number.POSITIVE_INFINITY);
  expect(number?.bottom).toBeGreaterThan(
    currency?.top ?? Number.POSITIVE_INFINITY
  );
};

const stripBoxes = (page: Page): Promise<StripBox[]> =>
  receiptOf(page)
    .locator("[data-receipt-totals]")
    .evaluate((strip) =>
      [...strip.querySelectorAll("dt")].map((term) => {
        const box = term.getBoundingClientRect();
        return { left: box.left, top: Math.round(box.top), width: box.width };
      })
    );

test("faixa do recibo a 360 px: Total devido e Item lado a lado, sem Recebido, e o total escrito uma vez", async ({
  page,
}) => {
  await openDetail(page, { sale: ORDINARY, size: { height: 740, width: 360 } });
  const strip = receiptOf(page).locator("[data-receipt-totals]");
  await expect(strip.locator("dt")).toHaveText(["Total devido", "Item"]);
  await expect(strip.locator("dd").nth(0)).toContainText("209,90");
  await expect(strip.locator("dd").nth(1)).toHaveText("1");
  const [total, items] = await stripBoxes(page);
  expect(items?.top).toBe(total?.top);
  expect(items?.left).toBeGreaterThan(total?.left ?? 0);
  await expect(receiptOf(page).getByText("Recebido")).toHaveCount(0);
  expect(
    await receiptOf(page).getByText("Total devido", { exact: true }).count()
  ).toBe(1);
});

test("faixa do recibo a 1280 px: as duas lado a lado, o Total o mais largo e o maior", async ({
  page,
}) => {
  await openDetail(page, {
    sale: ORDINARY,
    size: { height: 800, width: 1280 },
  });
  const [total, items] = await stripBoxes(page);
  expect(items?.top).toBe(total?.top);
  expect(total?.left).toBeLessThan(items?.left ?? 0);
  expect(total?.width).toBeGreaterThan(
    items?.width ?? Number.POSITIVE_INFINITY
  );
  const sizes = await receiptOf(page)
    .locator("[data-receipt-totals] dd")
    .evaluateAll((cells) =>
      cells.map((cell) =>
        Number.parseFloat(
          getComputedStyle(cell.querySelector("[data-money]") ?? cell).fontSize
        )
      )
    );
  expect(sizes[0]).toBeGreaterThan(sizes[1] ?? Number.POSITIVE_INFINITY);
});

test("faixa do recibo a 412 px com valor de nove dígitos: as células não se sobrepõem", async ({
  page,
}) => {
  await openDetail(page, { sale: HUGE, size: { height: 800, width: 412 } });
  await expectStripCellsApart(page);
});

test("faixa do recibo: nenhuma leitura a mais do que a tela já fazia", async ({
  page,
}) => {
  const procedures: string[] = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith("/rpc/")) {
      procedures.push(pathname.replace(RPC_PREFIX, ""));
    }
  });
  await openDetail(page, { sale: ORDINARY, size: { height: 740, width: 360 } });
  await expect(
    receiptOf(page).locator("[data-receipt-totals] dd").nth(0)
  ).toContainText("209,90");
  expect(procedures.filter((name) => name === "sale/get")).toHaveLength(1);
  expect([...new Set(procedures)].sort()).toEqual([
    "__screens-lab",
    "sale/get",
    "sale/getCustomerLink",
  ]);
});

reflowTest(
  "faixa do recibo a 320 px com a letra a 20 px: Total devido e Itens sem rolagem e sem corte",
  async ({ page }) => {
    await openDetail(page, { fontPixels: 20, sale: HUGE });
    await expectReflowFont(page, 20);
    const receipt = receiptOf(page);
    const strip = receipt.locator("[data-receipt-totals]");
    await expect(strip.locator("dd").nth(0)).toContainText("1.200.000,00");
    await expectSplitTotalOnOneLine(page);
    const [total, items] = await stripBoxes(page);
    expect(items?.top).toBeGreaterThan(total?.top ?? Number.POSITIVE_INFINITY);
    await expectStripCellsApart(page);
    await assertNothingClipped(strip);
    await assertNoPageScroll(page);
  }
);

reflowTest(
  "faixa do recibo escondida a 320 px com a letra a 20 px: Total em máscara, Itens à vista, sem rolagem",
  async ({ page }) => {
    await openDetail(page, { fontPixels: 20, hidden: true, sale: HUGE });
    const strip = receiptOf(page).locator("[data-receipt-totals]");
    await expect(strip.locator("dd")).toHaveText([MASKED_MONEY_CELL, "1"]);
    await assertNothingClipped(strip);
    await assertNoPageScroll(page);
  }
);

reflowTest(
  "recibo a 320 px com a letra a 20 px: o valor de nove dígitos não quebra nem sai do cartão; o nome é que quebra",
  async ({ page }) => {
    await openDetail(page, { fontPixels: 20, sale: HUGE });
    await expectReflowFont(page, 20);
    const receipt = receiptOf(page);
    await expect(receipt.getByText("R$ 1.234.567,89").first()).toBeVisible();
    expect(await assertAmountsOnOneLine(receipt)).toBeGreaterThanOrEqual(6);
    const name = receipt.getByText(LONG_NAME, { exact: true });
    const lines = await name.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return new Set(
        [...range.getClientRects()].map((rect) => Math.round(rect.top))
      ).size;
    });
    expect(lines).toBeGreaterThan(1);
    const outside = await receipt.evaluate((root, source) => {
      const card = root
        .closest('[data-slot="card"]')
        ?.getBoundingClientRect();
      if (!card) {
        throw new Error("no card");
      }
      const AMOUNT = new RegExp(source);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const bad: string[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!AMOUNT.test(node.textContent ?? "")) {
          continue;
        }
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          if (rect.left < card.left - 0.5 || rect.right > card.right + 0.5) {
            bad.push(
              `${node.textContent} ${rect.left}-${rect.right} no cartão ${card.left}-${card.right}`
            );
          }
        }
      }
      return bad;
    }, AMOUNT_SOURCE);
    expect(outside).toEqual([]);
    await assertNothingClipped(page.locator("main"), {
      allowScroll: ['[data-slot="card"]'],
    });
    await assertNoPageScroll(page);
  }
);

interface Snapshot {
  boxes: Array<{ bottom: number; height: number; right: number; top: number }>;
  shift: number;
}

const takeSnapshot = (page: Page): Promise<Snapshot> =>
  page.evaluate(() => {
    const receipt = document.querySelector(
      '[data-block="plain"][role="region"]'
    );
    const boxes = [
      ...(receipt?.querySelectorAll("dt, dd, li, h2, h3, p") ?? []),
      receipt,
    ].map((element) => {
      const box = element?.getBoundingClientRect();
      return {
        bottom: box?.bottom ?? Number.NaN,
        height: box?.height ?? Number.NaN,
        right: box?.right ?? Number.NaN,
        top: box?.top ?? Number.NaN,
      };
    });
    const shifts = (window as unknown as { __shift: number }).__shift;
    return { boxes, shift: shifts };
  });

for (const size of [
  { height: 740, width: 360 },
  { height: 800, width: 1280 },
]) {
  test(`recibo: a chegada da Geist Mono não move nada (≤ 1 px) e o CLS fica em ${SHIFT_BUDGET} a ${size.width} px`, async ({
    page,
  }) => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requested = 0;
    await page.route(MONO_FONT_FILE, async (route: Route) => {
      requested += 1;
      await gate;
      await route.continue();
    });
    await page.addInitScript(() => {
      const holder = window as unknown as { __shift: number };
      holder.__shift = 0;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & {
            hadRecentInput: boolean;
            value: number;
          };
          if (!shift.hadRecentInput) {
            holder.__shift += shift.value;
          }
        }
      }).observe({ buffered: true, type: "layout-shift" });
    });
    await openDetail(page, { sale: HUGE, size });
    expect(requested, "the mono face was asked for and is being held").toBe(1);
    expect(
      await page.evaluate(
        (family) =>
          [...document.fonts].filter(
            (face) =>
              face.family.replaceAll('"', "") === family &&
              face.status === "loaded"
          ).length,
        MONO_FAMILY
      )
    ).toBe(0);
    const before = await takeSnapshot(page);
    release();
    await page.evaluate(
      (family) => document.fonts.load(`16px "${family}"`),
      MONO_FAMILY
    );
    await page.evaluate(() => document.fonts.ready);
    expect(
      await page.evaluate(
        (family) =>
          [...document.fonts].filter(
            (face) =>
              face.family.replaceAll('"', "") === family &&
              face.status === "loaded"
          ).length,
        MONO_FAMILY
      )
    ).toBe(1);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    );
    const after = await takeSnapshot(page);
    expect(after.boxes).toHaveLength(before.boxes.length);
    for (const [index, box] of before.boxes.entries()) {
      const next = after.boxes[index];
      expect(
        Math.abs((next?.top ?? Number.NaN) - box.top),
        `top ${index}`
      ).toBeLessThanOrEqual(SLACK_PIXELS);
      expect(
        Math.abs((next?.height ?? Number.NaN) - box.height),
        `height ${index}`
      ).toBeLessThanOrEqual(SLACK_PIXELS);
      expect(
        Math.abs((next?.right ?? Number.NaN) - box.right),
        `right ${index}`
      ).toBeLessThanOrEqual(SLACK_PIXELS);
    }
    expect(after.shift - before.shift).toBeLessThanOrEqual(SHIFT_BUDGET);
  });
}
