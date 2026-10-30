import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmptyResult } from "./empty-result";

const render = (canCreateExpense: boolean) =>
  renderToStaticMarkup(
    <EmptyResult canCreateExpense={canCreateExpense} period="outubro de 2026" />
  );

describe("the Resultado of a period with no sale and no expense", () => {
  it("keeps its sentence and offers a new sale and a new expense, as the tab of the expenses names it", () => {
    const html = render(true);
    expect(html).toContain("Sem vendas nem despesas em outubro de 2026");
    expect(html).toContain(
      "Escolha outro período ou registre vendas e despesas."
    );
    expect(html).toContain('href="/sales"');
    expect(html).toContain('href="/dashboard?aba=despesas"');
    expect(html).toContain(">Nova venda</a>");
    expect(html).toContain(">Nova despesa</a>");
    expect(html.indexOf("Nova venda")).toBeLessThan(
      html.indexOf("Nova despesa")
    );
  });

  it("offers only the new sale to who cannot register an expense", () => {
    const html = render(false);
    expect(html).toContain("Nova venda");
    expect(html).not.toContain("Nova despesa");
    expect(html).not.toContain("aba=despesas");
  });
});
