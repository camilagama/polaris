import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmptyResult } from "../dashboard/empty-result";
import { EMPTY_SUPPORT_MAX, EMPTY_TITLE_MAX, EmptyState } from "./empty-state";

const LABELLED_BY = /aria-labelledby="([^"]+)"/;

const text = (html: string, tag: string) =>
  [...html.matchAll(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "g"))].map(
    (found) => found[1] ?? ""
  );

describe("the empty state", () => {
  it("is a region named by its sentence when it is there from the start", () => {
    const html = renderToStaticMarkup(<EmptyState title="Nada aqui." />);
    expect(html).toContain('role="region"');
    const labelled = LABELLED_BY.exec(html)?.[1];
    expect(labelled).toBeDefined();
    expect(html).toContain(`id="${labelled}"`);
    expect(html).not.toContain('role="status"');
  });

  it("is a status when it appears after a read, so the screen reader says it", () => {
    const html = renderToStaticMarkup(<EmptyState afterRead title="Nada." />);
    expect(html).toContain('role="status"');
    expect(html).not.toContain('role="region"');
  });

  it("carries the sentence, the optional line of support and the action in this order", () => {
    const html = renderToStaticMarkup(
      <EmptyState support="Uma linha." title="A frase.">
        <button type="button">Agir</button>
      </EmptyState>
    );
    expect(html.indexOf("A frase.")).toBeLessThan(html.indexOf("Uma linha."));
    expect(html.indexOf("Uma linha.")).toBeLessThan(html.indexOf("Agir"));
  });

  it("draws neither the support nor the action when there are none", () => {
    const html = renderToStaticMarkup(<EmptyState title="A frase." />);
    expect(text(html, "p")).toEqual(["A frase."]);
    expect(html).not.toContain("<button");
    expect(html).not.toContain("flex-wrap");
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
