import type { Dom } from "./dom";

type Cell = Node | string;

/**
 * A table with its headers. On a narrow screen the stylesheet stacks each row and labels each cell with its header
 * (`data-label`, shown by CSS), so the page never scrolls sideways (AC-15).
 */
export function table(
  dom: Dom,
  caption: string,
  headers: readonly string[],
  rows: readonly (readonly Cell[])[]
): HTMLTableElement {
  return dom.el(
    "table",
    { class: "grid" },
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
