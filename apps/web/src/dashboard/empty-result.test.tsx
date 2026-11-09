import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EMPTY_SUPPORT_MAX, EMPTY_TITLE_MAX } from "@/ui/empty-state";
import { EmptyResult } from "./empty-result";

const text = (html: string, tag: string) =>
  [...html.matchAll(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "g"))].map(
    (found) => found[1] ?? ""
  );

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

describe("the empty state of the Resultado (AC-11.1)", () => {
  const PERIODS = [
    "1 a 31 de outubro",
    "1 de janeiro a 9 de novembro",
    "1 de janeiro a 31 de dezembro de 2025",
    "30 de setembro de 2025 a 30 de setembro de 2026",
    "29 de fevereiro de 2028 a 28 de fevereiro de 2029",
  ];

  it.each(PERIODS)(
    "keeps the sentence and the support inside the limits, and says the period, for %s",
    (period) => {
      const html = renderToStaticMarkup(
        <EmptyResult canCreateExpense period={period} />
      );
      const [title = "", support = ""] = text(html, "p");
      expect(title.length).toBeLessThanOrEqual(EMPTY_TITLE_MAX);
      expect(support.length).toBeLessThanOrEqual(EMPTY_SUPPORT_MAX);
      expect(title + support).toContain(period);
      expect(html).toContain("Escolha outro");
    }
  );

  it("moves the period to the support exactly when the named sentence passes the limit", () => {
    const room = EMPTY_TITLE_MAX - "Sem vendas nem despesas em ".length;
    const fits = renderToStaticMarkup(
      <EmptyResult canCreateExpense period={"x".repeat(room)} />
    );
    const over = renderToStaticMarkup(
      <EmptyResult canCreateExpense period={"x".repeat(room + 1)} />
    );
    expect(text(fits, "p")[0]).toBe(
      `Sem vendas nem despesas em ${"x".repeat(room)}`
    );
    expect(text(over, "p")[0]).toBe("Sem vendas nem despesas no período");
    expect(text(over, "p")[1]).toContain("x".repeat(room + 1));
  });

  it("keeps the whole sentence when it fits", () => {
    const html = renderToStaticMarkup(
      <EmptyResult canCreateExpense period="1 a 31 de outubro" />
    );
    expect(html).toContain("Sem vendas nem despesas em 1 a 31 de outubro");
  });
});
