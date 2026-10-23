import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HistoryFiltersBar } from "./sale-history-filters";
import { emptyHistoryFilters } from "./sale-history-model";

/** `useIsMobile` reads `window.matchMedia`; the node environment has no window, so each test brings its own. */
function width(mobile: boolean) {
  vi.stubGlobal("window", {
    matchMedia: () => ({
      addEventListener: () => undefined,
      matches: mobile,
      removeEventListener: () => undefined,
    }),
  });
}

const NOOP = () => undefined;
const CLOSED_TRIGGER = /aria-expanded="false"[^>]*>.*Filtrar<\/button>/s;
const OPEN_TRIGGER = /aria-expanded="true"/;

const render = (status: "" | "cancelled" = "") =>
  renderToStaticMarkup(
    <HistoryFiltersBar
      filters={{ ...emptyHistoryFilters, status }}
      offline={false}
      onChange={NOOP}
      onReset={NOOP}
      period={null}
    />
  );

afterEach(() => vi.unstubAllGlobals());

describe("HistoryFiltersBar", () => {
  it("below 760 px starts closed under a 'Filtrar' trigger", () => {
    width(true);
    const html = render();
    expect(html).toContain('aria-label="Filtrar vendas"');
    expect(html).toMatch(CLOSED_TRIGGER);
    expect(html).not.toContain("Limpar filtros");
    expect(html).not.toContain("De (data da venda)");
  });

  it("below 760 px opens by itself, and counts the filters, when one is on", () => {
    width(true);
    const html = render("cancelled");
    expect(html).toMatch(OPEN_TRIGGER);
    expect(html).toContain("Filtrar · 1");
    expect(html).toContain("Limpar filtros (1)");
    expect(html).toContain("De (data da venda)");
  });

  it("from 760 px has the filters in the page, with no trigger", () => {
    width(false);
    const html = render();
    expect(html).toContain("De (data da venda)");
    expect(html).toContain("Limpar filtros");
    expect(html).not.toContain("collapsible-trigger");
    expect(html).not.toContain("Filtrar<");
  });
});
