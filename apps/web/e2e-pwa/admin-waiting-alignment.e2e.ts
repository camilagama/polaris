/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

/**
 * "Esperando por você" on the Admin's Início, on the real sheet (`apps/admin/ui/admin.css`) and the markup of
 * `apps/admin/ui/views/home.ts`: in a card narrower than 40 rem the destination drops under the text, and it must start
 * where the text starts whatever the digits of the figure; in a wide card the figure, the text and the destination
 * share one row. An item with no figure keeps the whole line for the text and the destination.
 */
const SHEET = readFileSync(
  join(import.meta.dirname, "../../admin/ui/admin.css"),
  "utf8"
);

const NARROW_PX = 340;
const WIDE_PX = 960;
const SUBPIXEL = 1;
const FIGURES = ["7", "42", "128", "1234"] as const;

interface Item {
  figure: string | null;
  what: string;
}

const ITEMS: readonly Item[] = [
  ...FIGURES.map((figure) => ({
    figure,
    what: "atendimentos abertos há mais de dois dias sem resposta",
  })),
  { figure: null, what: "lojas com cobrança pendente" },
];

const itemMarkup = ({ figure, what }: Item) => `<li>
  <a class="waiting-item" href="#">${
    figure === null ? "" : `<span class="waiting-count">${figure}</span> `
  }<span class="waiting-what">${what}</span> <span class="waiting-go">Abrir fila →</span></a>
</li>`;

async function open(page: Page, width: number) {
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"><style>${SHEET}</style></head>
<body><div id="admin" class="content"><section class="area" style="width:${width}px">
<ul class="waiting">${ITEMS.map(itemMarkup).join("")}</ul></section></div></body></html>`
  );
  await page.evaluate(() => document.fonts.ready);
}

interface Rect {
  height: number;
  width: number;
  x: number;
  y: number;
}

interface Row {
  count: Rect | null;
  go: Rect;
  outer: Rect;
  what: Rect;
}

/** The boxes of every item, read in one pass so the rows are measured against the same layout. */
function rows(page: Page): Promise<Row[]> {
  return page.evaluate(() => {
    const rect = (element: Element | null) => {
      if (element === null) {
        return null;
      }
      const { height, width, x, y } = element.getBoundingClientRect();
      return { height, width, x, y };
    };
    return [...document.querySelectorAll(".waiting-item")].map((item) => ({
      count: rect(item.querySelector(".waiting-count")),
      go: rect(item.querySelector(".waiting-go")) as Rect,
      outer: rect(item) as Rect,
      what: rect(item.querySelector(".waiting-what")) as Rect,
    }));
  });
}

const below = (go: Rect, what: Rect) => go.y >= what.y + what.height - SUBPIXEL;

test.describe("Admin: o destino de 'Esperando por você'", () => {
  test("no cartão estreito começa na coluna do texto, com 1 a 4 dígitos", async ({
    page,
  }) => {
    await open(page, NARROW_PX);
    const measured = await rows(page);
    expect(measured).toHaveLength(ITEMS.length);
    for (const [index, figure] of FIGURES.entries()) {
      const { count, go, what } = measured[index] as Row;
      const found = count as Rect;
      expect(below(go, what), `${figure}: destino desce`).toBe(true);
      expect(
        Math.abs(go.x - what.x),
        `${figure}: borda esquerda do destino e do texto`
      ).toBeLessThanOrEqual(SUBPIXEL);
      expect(
        what.x,
        `${figure}: texto depois da contagem`
      ).toBeGreaterThanOrEqual(found.x + found.width - SUBPIXEL);
    }
  });

  test("a coluna do texto anda com os dígitos da contagem", async ({
    page,
  }) => {
    await open(page, NARROW_PX);
    const [first, , , last] = await rows(page);
    expect((last as Row).what.x).toBeGreaterThan((first as Row).what.x + 8);
  });

  test("sem contagem o texto e o destino têm a linha inteira", async ({
    page,
  }) => {
    await open(page, NARROW_PX);
    const { go, outer, what } = (await rows(page))[FIGURES.length] as Row;
    const inset = what.x - outer.x;
    expect(Math.abs(go.x - what.x)).toBeLessThanOrEqual(SUBPIXEL);
    expect(inset).toBeGreaterThan(0);
    expect(inset).toBeLessThan(24);
    expect(what.width).toBeGreaterThan(outer.width - 2 * inset - 2 * SUBPIXEL);
    expect(below(go, what)).toBe(true);
  });

  test("no cartão largo contagem, texto e destino ficam numa linha só", async ({
    page,
  }) => {
    await open(page, WIDE_PX);
    const measured = await rows(page);
    for (const { count, go, what } of measured.slice(0, FIGURES.length)) {
      const found = count as Rect;
      expect(found.x).toBeLessThan(what.x);
      expect(what.x).toBeLessThan(go.x);
      expect(Math.abs(go.y - what.y)).toBeLessThan(what.height);
    }
  });
});
