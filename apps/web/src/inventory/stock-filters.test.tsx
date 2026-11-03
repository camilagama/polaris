import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { defaultStockFilters, type StockFilters } from "./stock-list-model";
import { activeStockFilters, StockFiltersButton } from "./stock-filters";

const noop = () => undefined;

function markup(filters: StockFilters) {
  return renderToStaticMarkup(
    <StockFiltersButton
      filters={filters}
      onArchived={noop}
      onStock={noop}
      onUnknownCost={noop}
    />
  );
}

describe("the filters of the list", () => {
  it("counts the criteria that narrow the list, and not the search", () => {
    expect(activeStockFilters(defaultStockFilters)).toBe(0);
    expect(activeStockFilters({ ...defaultStockFilters, query: "camiseta" })).toBe(
      0
    );
    expect(activeStockFilters({ ...defaultStockFilters, stock: "with_stock" })).toBe(
      1
    );
    expect(
      activeStockFilters({
        includeArchived: true,
        query: "",
        stock: "without_stock",
        unknownCost: true,
      })
    ).toBe(3);
  });

  it("is one button named Filtros, with the number in its name only when there is one", () => {
    expect(markup(defaultStockFilters)).toContain('aria-label="Filtros"');
    expect(markup({ ...defaultStockFilters, unknownCost: true })).toContain(
      'aria-label="Filtros, 1 ativo"'
    );
    expect(
      markup({ ...defaultStockFilters, stock: "with_stock", unknownCost: true })
    ).toContain('aria-label="Filtros, 2 ativos"');
  });
});
