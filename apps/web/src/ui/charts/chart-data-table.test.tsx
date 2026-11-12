import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hiddenValues = vi.hoisted(() => ({ hidden: false }));

vi.mock("@/lib/hidden-values", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hidden-values")>()),
  useHiddenValues: () => [hiddenValues.hidden, () => undefined],
}));

const { ChartDataTable } = await import("./chart-data-table");

const COLUMNS = [
  { header: "Dia" },
  { header: "Vendas", numeric: true },
] as const;
const ROWS = [
  { cells: ["23/10/2026", "R$ 320,10"], key: "2026-10-23" },
  { cells: ["22/10/2026", "R$ 0,00"], key: "2026-10-22" },
];
const SCOPE_COL = /<th[^>]*scope="col"/g;
const FOCUSABLE = /tabindex|<a |<button|<input/;
const HIDDEN_WRAPPER =
  /<div class="[^"]*overflow-hidden[^"]*" data-chart-data-table="hidden">/;
const TABLE_TAG =
  /<table class="w-full caption-top text-sm[^"]*" id="numbers">/;
const FIXED_TABLE = /<table class="[^"]*\btable-fixed\b/;
const DIGIT_OF_AMOUNT = /R\$ \d/;

function render(visible?: boolean, rows: typeof ROWS = ROWS) {
  return renderToStaticMarkup(
    <ChartDataTable
      caption="Vendas por dia."
      columns={COLUMNS}
      id="numbers"
      rows={rows}
      {...(visible === undefined ? {} : { visible })}
    />
  );
}

beforeEach(() => {
  hiddenValues.hidden = false;
});

describe("ChartDataTable", () => {
  it("is a table with its caption, a header per column and a row per entry, under the id the chart points at", () => {
    const html = render();
    expect(html).toMatch(TABLE_TAG);
    expect(html).toContain("<caption");
    expect(html).toContain("Vendas por dia.</caption>");
    expect(html.match(SCOPE_COL)).toHaveLength(2);
    expect(html.match(/<tr[ >]/g)).toHaveLength(3);
    expect(html).toContain("23/10/2026");
  });

  it("holds the invisible table to the width of its wrapper, and leaves the shown one on its own layout", () => {
    const hidden = render();
    expect(hidden).toMatch(FIXED_TABLE);
    expect(hidden).toContain("[overflow-wrap:anywhere]");
    expect(hidden).toContain("[&amp;_td]:px-0");
    expect(render(true)).not.toContain("table-fixed");
  });

  it("is invisible on the screen and out of the tab order unless it is shown", () => {
    expect(render()).toMatch(HIDDEN_WRAPPER);
    expect(render()).not.toMatch(FOCUSABLE);
    const visible = render(true);
    expect(visible).toContain('data-chart-data-table="visible"');
    expect(visible).not.toContain("overflow-hidden");
    expect(visible).not.toMatch(FOCUSABLE);
  });

  it("writes the amounts as they are while the values show", () => {
    expect(render()).toContain("R$ 320,10");
  });

  it("masks every amount while the values are hidden, for the eye and for the screen reader", () => {
    hiddenValues.hidden = true;
    const html = render();
    expect(html).not.toContain("320,10");
    expect(html).toContain("R$ ••••");
    expect(html).toContain("valor escondido");
    expect(html).not.toMatch(DIGIT_OF_AMOUNT);
  });

  describe("a negative amount", () => {
    const negative = [
      { cells: ["23/10/2026", "-R$ 5,00"], key: "a", negativeCells: [1] },
      { cells: ["22/10/2026", "R$ 7,00"], key: "b" },
    ];
    const cell = (html: string, text: string) =>
      html.match(new RegExp(`<td[^>]*>[^<]*(?:<[^>]*>)*${text}`))?.[0] ?? "";

    it("takes the destructive color in the marked cell and in no other", () => {
      const html = render(true, negative);
      expect(cell(html, "-R\\$ 5,00")).toContain("text-destructive");
      expect(cell(html, "R\\$ 7,00")).not.toContain("text-destructive");
      expect(html.match(/text-destructive/g)).toHaveLength(1);
    });

    it("keeps the color while the values are hidden", () => {
      hiddenValues.hidden = true;
      const html = render(true, negative);
      expect(html).not.toContain("5,00");
      expect(html.match(/text-destructive/g)).toHaveLength(1);
    });
  });
});
