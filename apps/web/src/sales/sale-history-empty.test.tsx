import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HistoryEmptyCard, HistoryNothingYet } from "./sale-history-empty";

const noop = () => undefined;
const FILTER_SENTENCE_STATUS =
  /<p[^>]*role="status"[^>]*>Nenhuma venda encontrada com estes filtros\.<\/p>/;

describe("o Histórico vazio", () => {
  it("com filtro, oferece Limpar filtros e não manda registrar venda", () => {
    const html = renderToStaticMarkup(
      <HistoryEmptyCard
        onClearFilters={noop}
        view={{
          clearFilters: true,
          href: null,
          kind: "empty",
          message: "Nenhuma venda encontrada com estes filtros.",
          support: null,
        }}
      />
    );
    expect(html).toContain("Nenhuma venda encontrada com estes filtros.");
    expect(html).toMatch(FILTER_SENTENCE_STATUS);
    expect(html).toContain("Limpar filtros</button>");
    expect(html).not.toContain("Registrar uma venda");
  });

  it("sem venda e sem filtro é só o EmptyState: título, apoio e a ação, sem moldura nem total", () => {
    const html = renderToStaticMarkup(
      <HistoryNothingYet
        view={{
          clearFilters: false,
          href: "/sales",
          kind: "empty",
          message: "Nenhuma venda ainda.",
          support: "Registre a primeira venda para vê-la aqui.",
        }}
      />
    );
    expect(html).toContain("data-empty-state");
    expect(html).toContain("Nenhuma venda ainda.");
    expect(html).toContain("Registre a primeira venda para vê-la aqui.");
    expect(html).toContain('href="/sales"');
    expect(html).toContain("Registrar uma venda");
    expect(html).not.toContain("Limpar filtros");
    expect(html).not.toContain("data-list-block");
    expect(html).not.toContain("data-list-total");
  });
});
