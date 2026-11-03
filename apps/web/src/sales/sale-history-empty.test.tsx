import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HistoryEmptyCard } from "./sale-history-empty";

const noop = () => undefined;

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
        }}
      />
    );
    expect(html).toContain("Nenhuma venda encontrada com estes filtros.");
    expect(html).toContain("Limpar filtros</button>");
    expect(html).not.toContain("Registrar uma venda");
  });

  it("sem filtro, leva a registrar a primeira venda e não oferece Limpar filtros", () => {
    const html = renderToStaticMarkup(
      <HistoryEmptyCard
        onClearFilters={noop}
        view={{
          clearFilters: false,
          href: "/sales",
          kind: "empty",
          message: "Nenhuma venda ainda.",
        }}
      />
    );
    expect(html).toContain("Registrar uma venda");
    expect(html).not.toContain("Limpar filtros");
  });
});
