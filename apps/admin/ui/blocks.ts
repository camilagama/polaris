import type { Dom } from "./dom";

type Cell = Node | string;

/**
 * A table with its headers. On a narrow screen the stylesheet stacks each row and labels each cell with its header
 * (`data-label`, shown by CSS), so the page never scrolls sideways (AC-15); the funnel's tables are the exception and
 * scroll inside their own region (`funnelTable`). `className` adds the class of a table that lays its narrow rows out
 * its own way.
 */
export function table(
  dom: Dom,
  caption: string,
  headers: readonly string[],
  rows: readonly (readonly Cell[])[],
  className?: string
): HTMLTableElement {
  return dom.el(
    "table",
    { class: className === undefined ? "grid" : `grid ${className}` },
    dom.el("caption", { class: "sr-only" }, caption),
    dom.el(
      "thead",
      {},
      dom.el(
        "tr",
        {},
        ...headers.map((header) => dom.el("th", { scope: "col" }, header))
      )
    ),
    dom.el("tbody", {}, ...rows.map((row) => tableRow(dom, headers, row)))
  );
}

export function tableRow(
  dom: Dom,
  headers: readonly string[],
  row: readonly Cell[]
): HTMLTableRowElement {
  return dom.el(
    "tr",
    {},
    ...row.map((cell, index) =>
      dom.el("td", { "data-label": headers[index] ?? "" }, cell)
    )
  );
}

/** Label and value pairs. */
export function facts(
  dom: Dom,
  pairs: readonly (readonly [string, Cell])[]
): HTMLDListElement {
  return dom.el(
    "dl",
    { class: "facts" },
    ...pairs.map(([label, value]) =>
      dom.el("div", {}, dom.el("dt", {}, label), dom.el("dd", {}, value))
    )
  );
}

/**
 * The title of a section inside a block set back into a card. It sits one level below the block's title for the
 * outline, and keeps the size of the `h3` it replaces (`section-title`), so only the level changes.
 */
export function sectionTitle(
  dom: Dom,
  level: "h3" | "h4",
  text: string
): HTMLHeadingElement {
  return dom.el(level, level === "h4" ? { class: "section-title" } : {}, text);
}
