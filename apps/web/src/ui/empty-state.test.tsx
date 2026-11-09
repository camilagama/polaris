import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmptyState } from "./empty-state";

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
