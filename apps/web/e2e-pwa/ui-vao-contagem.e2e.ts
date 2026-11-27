/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { expenseStates } from "./ui-expense-states";
import { historyStates } from "./ui-history-states";
import { customerStates } from "./ui-lot2-states";
import { productStates } from "./ui-product-states";
import { stockStates } from "./ui-stock-states";

/**
 * The gap between the list and what sits above its frame is 16 px at 360 px (and, on Produtos, at 1280 px too). On
 * Produtos the count is in the header of the frame, so the 16 px is between the line of controls (the filter of the
 * state) and the frame. On Estoque the count is in the title of the frame too, so the 16 px is between the controls
 * (search and filters) and the frame;
 * the notice of the open panel lives inside the panel, so nothing sits between them, and the gap does not change with
 * the "Precisa de ação" strip above. Clientes counts in the title of its `ListBlock`, with no line of its own.
 */
const GAP = 16;
const TOLERANCE = 1;
const OPEN_REASON = "Feche o painel aberto para usar os botões.";
const COUNT_JEANS = /^Contar estoque de Calça jeans/;
const RECEIVE_JEANS = /^Receber estoque de Calça jeans/;

test.use({ viewport: { height: 740, width: 360 } });

test.beforeEach(({ browserName }, testInfo) => {
  test.skip(
    browserName !== "chromium" || testInfo.project.name !== "chromium-desktop",
    "the gap is a layout measure, taken once per width"
  );
});

/** From the bottom of the filter of the products (the last of the line of controls) to the top of the frame of the list. */
function gapBelowFilter(page: Page) {
  return page.evaluate(() => {
    const filter = document.querySelector(
      '[role="tablist"][aria-label="Estado dos produtos"]'
    );
    const frame = document.querySelector("[data-list-block]");
    if (!(filter && frame)) {
      return null;
    }
    return {
      gap:
        frame.getBoundingClientRect().top -
        filter.getBoundingClientRect().bottom,
    };
  });
}

/** From the bottom of the controls of the stock (the search and the filters) to the top of the frame of the list. */
async function gapBelowControls(page: Page) {
  const controls = await page
    .getByRole("search", { name: "Filtrar estoque" })
    .boundingBox();
  const frame = await page.locator("[data-list-block]").boundingBox();
  return controls && frame
    ? { gap: frame.y - (controls.y + controls.height) }
    : null;
}

/** The line of controls of Produtos at the desktop width: the search on the left, the filter of the state on the right. */
async function controlsAbove(page: Page) {
  const [search, filter, frame] = await Promise.all([
    page.getByRole("searchbox", { name: "Buscar produto" }).boundingBox(),
    page.getByRole("tablist", { name: "Estado dos produtos" }).boundingBox(),
    page.locator("[data-list-block]").boundingBox(),
  ]);
  return search && filter && frame
    ? {
        filterLeft: filter.x,
        filterRight: filter.x + filter.width,
        frameRight: frame.x + frame.width,
        gap:
          frame.y -
          Math.max(search.y + search.height, filter.y + filter.height),
        searchRight: search.x + search.width,
      }
    : null;
}

test.describe("o vão entre a contagem e a lista a 360 px", () => {
  test("Produtos: a moldura da lista fica a 16 px da linha de controles", async ({
    page,
  }) => {
    await productStates.list(page);
    const products = await gapBelowFilter(page);
    expect(products).not.toBeNull();
    expect(products?.gap).toBeCloseTo(GAP, 0);
  });

  test("Estoque: o vão entre a contagem e a lista é de 16 px", async ({
    page,
  }) => {
    await stockStates.list(page);
    await expect(page.locator('[data-slot="action-strip"]')).toBeVisible();
    const stock = await gapBelowControls(page);

    expect(stock?.gap).toBeCloseTo(GAP, 0);
  });

  test("no Estoque o vão é o mesmo com e sem a faixa Precisa de ação (sem ela, com o aviso de indisponível no lugar)", async ({
    page,
  }) => {
    await stockStates.list(page);
    await expect(page.locator('[data-slot="action-strip"]')).toBeVisible();
    const withStrip = await gapBelowControls(page);

    await stockStates.attentionUnavailable(page);
    await expect(page.locator('[data-slot="action-strip"]')).toHaveCount(0);
    const withoutStrip = await gapBelowControls(page);

    expect(withStrip).not.toBeNull();
    expect(withoutStrip).not.toBeNull();
    expect(
      Math.abs((withStrip?.gap ?? 0) - (withoutStrip?.gap ?? 99))
    ).toBeLessThanOrEqual(TOLERANCE);
    expect(withoutStrip?.gap).toBeCloseTo(GAP, 0);
  });

  test("com um painel aberto o vão e a posição da lista não mudam", async ({
    page,
  }) => {
    await stockStates.list(page);
    const rows = page.getByRole("list", { name: "Saldos em estoque" });
    const top = () =>
      rows.evaluate((list) => list.getBoundingClientRect().top + scrollY);
    const before = await top();
    await page.getByRole("button", { name: RECEIVE_JEANS }).click();
    await expect(
      page.getByRole("heading", { name: "Receber estoque" })
    ).toBeVisible();
    expect(Math.abs((await top()) - before)).toBeLessThanOrEqual(TOLERANCE);
    await expect(page.locator("#stock-panel-open-reason")).toHaveText(
      OPEN_REASON
    );
    await expect(
      page.getByRole("button", { name: COUNT_JEANS })
    ).toHaveAccessibleDescription(OPEN_REASON);
    const open = await gapBelowControls(page);
    expect(open?.gap).toBeCloseTo(GAP, 0);
  });
});

test.describe("o vão entre os controles e a lista a 1280 px", () => {
  test.use({ viewport: { height: 800, width: 1280 } });

  test("Produtos: busca à esquerda, filtro à direita e 16 px até a moldura", async ({
    page,
  }) => {
    await productStates.list(page);
    const controls = await controlsAbove(page);
    expect(controls).not.toBeNull();
    expect(controls?.searchRight ?? Number.POSITIVE_INFINITY).toBeLessThan(
      controls?.filterLeft ?? 0
    );
    expect(controls?.filterRight).toBeCloseTo(controls?.frameRight ?? 0, 0);
    expect(controls?.gap).toBeCloseTo(GAP, 0);
  });
});

/**
 * Where the count of the header of the list ends and where the "…" of the first row ends: the text itself (a `Range`
 * around it, not the box that reserves 112 px) and the last dot of the row menu.
 */
function countAndMenuEdges(page: Page) {
  return page.evaluate(() => {
    const count = document.querySelector("[data-list-count]");
    const title = document.querySelector("[data-list-block] h2");
    const menu = document.querySelector(
      "[data-list-block-row] button[aria-label^='Mais ações']"
    );
    const text = count?.firstChild;
    if (!(count && title && menu && text)) {
      return null;
    }
    const range = document.createRange();
    range.selectNodeContents(text);
    const drawn = range.getBoundingClientRect();
    const dotsRight = Array.from(menu.querySelectorAll("svg circle")).map(
      (dot) => dot.getBoundingClientRect().right
    );
    return {
      countLeft: drawn.left,
      countRight: drawn.right,
      countTop: drawn.top,
      menuRight:
        dotsRight.length > 0
          ? Math.max(...dotsRight)
          : menu.getBoundingClientRect().right,
      titleBottom: title.getBoundingClientRect().bottom,
      titleLeft: title.getBoundingClientRect().left,
    };
  });
}

const COUNT_LISTS = [
  { name: "Clientes", open: customerStates.list },
  { name: "Produtos", open: productStates.list },
  { name: "Despesas", open: expenseStates.list },
];

test.describe("a contagem do cabeçalho da lista no celular", () => {
  for (const list of COUNT_LISTS) {
    test(`${list.name} a 360 px: o texto da contagem termina na vertical do menu da primeira linha`, async ({
      page,
    }) => {
      await list.open(page);
      const edges = await countAndMenuEdges(page);
      expect(edges).not.toBeNull();
      expect(edges?.countTop).toBeLessThan(edges?.titleBottom ?? 0);
      expect(
        Math.abs((edges?.countRight ?? 0) - (edges?.menuRight ?? 99))
      ).toBeLessThanOrEqual(TOLERANCE);
    });
  }

  test("Despesas a 320 px: a contagem desce e começa na vertical do título", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 320 });
    await expenseStates.list(page);
    const edges = await countAndMenuEdges(page);
    expect(edges).not.toBeNull();
    expect(edges?.countTop).toBeGreaterThanOrEqual(edges?.titleBottom ?? 0);
    expect(
      Math.abs((edges?.countLeft ?? 0) - (edges?.titleLeft ?? 99))
    ).toBeLessThanOrEqual(TOLERANCE);
  });
});

/**
 * The right edges the Histórico measures against each other: the drawn text of the count (a `Range`, not the box that
 * reserves 112 px), that box, the chevron that ends the first row (its `svg` and the path it draws) and the figure of
 * the footer.
 */
function historyEdges(page: Page) {
  return page.evaluate(() => {
    const count = document.querySelector("[data-list-count]");
    const title = document.querySelector("[data-list-block] h2");
    const chevron = document.querySelector(
      "[data-list-block] li a > svg[aria-hidden='true']:last-child"
    );
    const figure = document.querySelector("[data-list-total] .text-right");
    if (!(count && title && chevron && figure)) {
      return null;
    }
    const drawnRight = (node: Node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return range.getBoundingClientRect().right;
    };
    const drawn = document.createRange();
    drawn.selectNodeContents(count);
    const paths = Array.from(chevron.querySelectorAll("path"));
    return {
      boxRight: count.getBoundingClientRect().right,
      boxWidth: count.getBoundingClientRect().width,
      chevronDrawnRight: Math.max(
        ...paths.map((path) => path.getBoundingClientRect().right)
      ),
      chevronRight: chevron.getBoundingClientRect().right,
      countRight: drawn.getBoundingClientRect().right,
      countLines: drawn.getClientRects().length,
      countText: count.textContent,
      countTop: drawn.getBoundingClientRect().top,
      countWidth: drawn.getBoundingClientRect().width,
      figureRight: drawnRight(figure),
      titleBottom: title.getBoundingClientRect().bottom,
    };
  });
}

const HISTORY_COUNT_STATES = [
  {
    count: "4 vendas · há mais",
    name: "com há mais",
    open: historyStates.list,
  },
  { count: "4 vendas", name: "sem há mais", open: historyStates.listComplete },
  {
    count: "4 vendas · há mais",
    name: "com há mais e o total do período",
    open: historyStates.periodTotal,
  },
  {
    count: "4 vendas",
    name: "sem há mais e com o total do período",
    open: historyStates.periodTotalComplete,
  },
];
const CHEVRON_GUTTER = 24;

test.describe("a contagem do Histórico a 360 px: linhas com seta e sem menu", () => {
  for (const state of HISTORY_COUNT_STATES) {
    test(`${state.name}: a contagem termina na borda do cabeçalho, na linha do título e inteira; a seta fica 2 px depois`, async ({
      page,
    }) => {
      await state.open(page);
      const edges = await historyEdges(page);
      expect(edges).not.toBeNull();
      expect(edges?.countText).toBe(state.count);
      expect(edges?.countLines).toBe(1);
      expect(edges?.countTop).toBeLessThan(edges?.titleBottom ?? 0);
      expect(edges?.countWidth).toBeLessThanOrEqual(edges?.boxWidth ?? 0);
      expect(
        Math.abs((edges?.countRight ?? 0) - (edges?.boxRight ?? 99))
      ).toBeLessThanOrEqual(TOLERANCE);
      expect(
        (edges?.chevronRight ?? 0) - (edges?.countRight ?? 0)
      ).toBeGreaterThanOrEqual(0);
      expect(
        (edges?.chevronRight ?? 0) - (edges?.countRight ?? 0)
      ).toBeLessThanOrEqual(2 + TOLERANCE);
      expect(
        Math.abs((edges?.countRight ?? 0) - (edges?.chevronDrawnRight ?? 0) - 4)
      ).toBeLessThanOrEqual(TOLERANCE);
      expect(
        Math.abs(
          (edges?.chevronRight ?? 0) -
            CHEVRON_GUTTER -
            (edges?.figureRight ?? 99)
        )
      ).toBeLessThanOrEqual(TOLERANCE);
    });
  }
});
