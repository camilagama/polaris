/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { addDays, localDate, monthStart } from "../calendar";
import { expect, openJourney, runT0, test } from "../fixtures";
import { seedCashSale, seedProduct, seedStock } from "../seed";

const ZONE = "America/Sao_Paulo";
const WIDE = { viewport: { height: 900, width: 1280 } };
/** The room a card may leave empty at its foot, in pixels. */
const EMPTY_FOOT_LIMIT = 24;
/** The share of the map's height the strip of a store with no goal may take under 960 px of content (92 of 199 px measured). */
const STRIP_HEIGHT_SHARE = 0.6;
const NARROW = { viewport: { height: 900, width: 800 } };
/** The pair of the goal and the map: 2/5 and 3/5, so the map's card is 1.5 times the goal's. */
const RHYTHM_OVER_GOAL = 1.5;
const PRODUCTS = [
  { name: "Camiseta básica", price: "59.90" },
  { name: "Caneca esmaltada", price: "35.00" },
  { name: "Vela aromática", price: "45.00" },
  { name: "Bolsa de tecido", price: "80.00" },
  { name: "Caderno artesanal", price: "28.00" },
] as const;

const SCENARIOS = [
  { goal: false, items: 3 },
  { goal: false, items: 5 },
  { goal: true, items: 3 },
  { goal: true, items: 5 },
] as const;

interface Card {
  bottom: number;
  emptyFoot: number;
  height: number;
  left: number;
  top: number;
  width: number;
}

interface Measure {
  cards: Record<string, Card | undefined>;
  /** The names of the cards in the order of the DOM. */
  order: string[];
  area: { left: number; width: number };
  shifts: number;
}

declare global {
  interface Window {
    __homeShifts?: number[];
  }
}

/** Before the page's own scripts: every layout shift that moved something inside the blocks under the KPI cards. */
function recordShiftsOfTheBlocks() {
  window.__homeShifts = [];
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as unknown as {
      hadRecentInput: boolean;
      sources?: { node?: Node | null }[];
      value: number;
    }[]) {
      const inside = (entry.sources ?? []).some((source) => {
        const element =
          source.node instanceof Element
            ? source.node
            : (source.node?.parentElement ?? null);
        return Boolean(element?.closest("[data-home-lower]"));
      });
      if (inside && !entry.hadRecentInput) {
        window.__homeShifts?.push(entry.value);
      }
    }
  }).observe({ buffered: true, type: "layout-shift" });
}

async function settled(page: Page) {
  await expect(
    page.getByRole("heading", { level: 1, name: "Início" })
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Vendas por dia" }).getByRole("img")
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Ritmo de vendas" })
      .locator("[data-heatmap] svg")
  ).toBeVisible();
  await expect(page.locator("[data-chart-loading]")).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      })
  );
}

/** The boxes of the four blocks, how much room each leaves empty at the foot of its panel (the frame's foot line is not room) and the shifts counted inside them. */
function measure(page: Page): Promise<Measure> {
  return page.evaluate(() => {
    const cards: Record<string, Card | undefined> = {};
    const order: string[] = [];
    const lower = document.querySelector("[data-home-lower]");
    for (const region of document.querySelectorAll("[role=region]")) {
      const id = region.getAttribute("aria-labelledby") ?? "";
      const name = document.getElementById(id)?.textContent ?? "";
      if (!(lower?.contains(region) && name)) {
        continue;
      }
      const box = region.getBoundingClientRect();
      const panel =
        region.querySelector("[data-slot=card-frame-panel]") ?? region;
      const room = panel.getBoundingClientRect();
      let lowest = room.top;
      for (const element of panel.querySelectorAll("*")) {
        const inner = element.getBoundingClientRect();
        if (
          inner.width > 0 &&
          inner.height > 0 &&
          inner.top >= room.top &&
          inner.bottom <= room.bottom + 1 &&
          !element.closest(".sr-only")
        ) {
          lowest = Math.max(lowest, inner.bottom);
        }
      }
      const padding = Number.parseFloat(getComputedStyle(panel).paddingBottom);
      cards[name] = {
        bottom: box.bottom,
        emptyFoot: room.bottom - padding - lowest,
        height: box.height,
        left: box.left,
        top: box.top,
        width: box.width,
      };
      order.push(name);
    }
    const area = (lower as HTMLElement).getBoundingClientRect();
    return {
      area: { left: area.left, width: area.width },
      cards,
      order,
      shifts: (window.__homeShifts ?? []).reduce((a, b) => a + b, 0),
    };
  });
}

/** Where a block is read first: its row, then its column (rows of a pair share the top). */
const before = (a: Card, b: Card) =>
  a.top < b.top - 1 || (Math.abs(a.top - b.top) <= 1 && a.left < b.left);

for (const { goal, items } of SCENARIOS) {
  const label = `${items} itens, ${goal ? "com" : "sem"} meta`;
  test(`início a 1280 (${label}): pares da mesma altura (gráfico e ranking, Meta e Ritmo), nenhum cartão com faixa vazia no pé, o Ritmo 3/5 e a Meta 2/5 e a ordem do DOM é a da tela`, async ({
    browser,
  }, testInfo) => {
    const journey = await openJourney(
      browser,
      testInfo,
      `inicio-grade-${items}-${goal ? "meta" : "sem-meta"}`,
      { device: WIDE, organization: { timezone: ZONE } }
    );
    const { page } = journey;
    const organizationId = journey.organizationId as string;
    const { rpc } = journey.user;
    const today = localDate(runT0(), ZONE);
    for (const [index, product] of PRODUCTS.slice(0, items).entries()) {
      // biome-ignore lint/performance/noAwaitInLoops: one command after the other, as the screens send them
      const seeded = await seedProduct(
        rpc,
        organizationId,
        product.name,
        product.price
      );
      await seedStock(
        rpc,
        organizationId,
        seeded.variantId,
        30,
        "12.00",
        today
      );
      await seedCashSale(
        rpc,
        organizationId,
        [
          {
            price: product.price,
            quantity: items - index,
            variantId: seeded.variantId,
          },
        ],
        new Date(runT0()).toISOString()
      );
    }
    if (goal) {
      await rpc.goal.create({
        endsOn: addDays(monthStart(today, 1), -1),
        kind: "net_sales",
        name: null,
        organizationId,
        startsOn: monthStart(today),
        target: "5000.00",
      });
    }
    await page.addInitScript(recordShiftsOfTheBlocks);
    await page.goto("/");
    await settled(page);
    const got = await measure(page);
    const { area, cards, order } = got;
    const meta = cards.Meta as Card;
    const chart = cards["Vendas por dia"] as Card;
    const rhythm = cards["Ritmo de vendas"] as Card;
    const top = cards["Mais vendidos do mês"] as Card;

    expect(order, "the DOM is the reading order").toEqual([
      "Vendas por dia",
      "Mais vendidos do mês",
      "Meta",
      "Ritmo de vendas",
    ]);
    expect(top).toBeDefined();
    expect(items === 5 ? 5 : 3).toBe(
      await page
        .getByRole("region", { name: "Mais vendidos do mês" })
        .locator("li")
        .count()
    );
    const ordered = [chart, top, meta, rhythm];
    for (const [index, card] of ordered.slice(1).entries()) {
      expect(
        before(ordered[index] as Card, card),
        "the screen reads in the order of the DOM"
      ).toBe(true);
    }

    expect(Math.abs(chart.top - top.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(chart.height - top.height)).toBeLessThanOrEqual(1);
    expect(chart.width).toBeGreaterThan(top.width * 1.4);
    expect(Math.abs(meta.top - rhythm.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(meta.height - rhythm.height)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(rhythm.width - RHYTHM_OVER_GOAL * meta.width)
    ).toBeLessThanOrEqual(2);
    expect(meta.width + rhythm.width).toBeLessThan(area.width);
    if (!goal) {
      await expect(
        page
          .getByRole("region", { name: "Meta" })
          .getByText("Defina quanto quer vender no mês e acompanhe aqui.")
      ).toBeVisible();
      await expect(
        page.getByRole("region", { name: "Meta" }).getByRole("link", {
          name: "Definir meta",
        })
      ).toBeVisible();
    }

    for (const [name, card] of Object.entries(cards)) {
      expect(
        card?.emptyFoot,
        `${name}: empty room at the foot`
      ).toBeLessThanOrEqual(EMPTY_FOOT_LIMIT);
    }
    expect(got.shifts, "layout shift inside the blocks").toBe(0);
  });
}

test("início a 800 (sem meta): abaixo de 960 px de conteúdo a Meta é a faixa fina, na linha inteira, e o Ritmo vem embaixo dela", async ({
  browser,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "inicio-grade-faixa", {
    device: NARROW,
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  const organizationId = journey.organizationId as string;
  const today = localDate(runT0(), ZONE);
  const [product] = PRODUCTS;
  const seeded = await seedProduct(
    journey.user.rpc,
    organizationId,
    product.name,
    product.price
  );
  await seedStock(
    journey.user.rpc,
    organizationId,
    seeded.variantId,
    30,
    "12.00",
    today
  );
  await seedCashSale(
    journey.user.rpc,
    organizationId,
    [{ price: product.price, quantity: 2, variantId: seeded.variantId }],
    new Date(runT0()).toISOString()
  );
  await page.goto("/");
  await settled(page);
  const { area, cards } = await measure(page);
  const meta = cards.Meta as Card;
  const rhythm = cards["Ritmo de vendas"] as Card;
  expect(area.width).toBeLessThan(960);
  expect(meta.height, "a thin strip").toBeLessThan(
    rhythm.height * STRIP_HEIGHT_SHARE
  );
  expect(Math.abs(meta.width - area.width)).toBeLessThanOrEqual(1);
  expect(rhythm.top).toBeGreaterThanOrEqual(meta.bottom);
  await expect(
    page
      .getByRole("region", { name: "Meta" })
      .getByText("Defina quanto quer vender no mês e acompanhe aqui.")
  ).toBeHidden();
});
