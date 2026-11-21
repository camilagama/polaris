import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ChartColumnIcon from "lucide-react/dist/esm/icons/chart-column";
import UsersIcon from "lucide-react/dist/esm/icons/users";
import { EmptyState } from "./empty-state";

const LABELLED_BY = /aria-labelledby="([^"]+)"/;
const HIDDEN_SQUARE = /<div[^>]*aria-hidden="true"[^>]*data-slot="empty-icon"/;
const HIDDEN_SVG = /<svg[^>]*aria-hidden="true"/;
const SQUARE = /data-slot="empty-icon"/g;

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

  it("draws the icon in a decorative 36 px square before the sentence, out of the accessible name", () => {
    const html = renderToStaticMarkup(
      <EmptyState icon={UsersIcon} title="A frase.">
        <button type="button">Agir</button>
      </EmptyState>
    );
    expect(html).toContain('data-slot="empty-icon"');
    expect(html).toContain("size-9");
    expect(html).toMatch(HIDDEN_SQUARE);
    expect(html).toMatch(HIDDEN_SVG);
    expect(html.indexOf("empty-icon")).toBeLessThan(html.indexOf("A frase."));
    expect(html.indexOf("A frase.")).toBeLessThan(html.indexOf("Agir"));
    expect(html).toContain("data-empty-title");
  });

  it("draws one square per icon of a list, side by side", () => {
    const html = renderToStaticMarkup(
      <EmptyState icon={[UsersIcon, ChartColumnIcon]} title="A frase." />
    );
    expect(html.match(SQUARE)).toHaveLength(2);
    expect(html).toContain("gap-2");
  });

  it("draws no square without an icon", () => {
    const html = renderToStaticMarkup(<EmptyState bare title="A frase." />);
    expect(html).not.toContain("empty-icon");
    expect(html).not.toContain("<svg");
  });
});
