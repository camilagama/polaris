import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActionStrip } from "./action-strip";

const CLASS = /class="([^"]*)"/;
const SVG_HIDDEN = /<svg[^>]*aria-hidden="true"/;

describe("ActionStrip", () => {
  it("diz 'Precisa de ação' com o triângulo decorativo e o conteúdo ao lado", () => {
    const html = renderToStaticMarkup(
      <ActionStrip>
        <a href="/estoque">2 sem saldo</a>
      </ActionStrip>
    );
    expect(html).toContain('data-slot="action-strip"');
    expect(html).toContain("Precisa de ação");
    expect(html).toMatch(SVG_HIDDEN);
    expect(html).toContain('<a href="/estoque">2 sem saldo</a>');
    expect(html.indexOf("Precisa de ação")).toBeLessThan(
      html.indexOf("2 sem saldo")
    );
  });

  it("deixa a tela acrescentar classe sem perder a moldura", () => {
    const html = renderToStaticMarkup(
      <ActionStrip className="mt-3">x</ActionStrip>
    );
    const classes = (CLASS.exec(html)?.[1] ?? "").split(" ");
    expect(classes).toEqual(
      expect.arrayContaining(["rounded-lg", "border", "bg-card", "mt-3"])
    );
  });
});
