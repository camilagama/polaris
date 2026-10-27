import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TabLabel } from "./product-dialog";

vi.mock("../lib/orpc", () => ({ orpcClient: {} }));

const HIDDEN_ICON = /<svg[^>]*aria-hidden="true"/;

/**
 * The name of a tab of the product dialog, drawn without a browser: the mark of an error is an icon hidden from a screen
 * reader and words it reads. The name as the browser computes it ("Dados (com erro)") is proved in
 * e2e/products-screen.e2e.ts.
 */
describe("name of a tab of the product", () => {
  it("with an error: the icon is hidden and the words ' (com erro)' follow the name", () => {
    const markup = renderToStaticMarkup(<TabLabel invalid label="Dados" />);
    expect(markup.startsWith("Dados<svg")).toBe(true);
    expect(markup).toMatch(HIDDEN_ICON);
    expect(markup).toContain('<span class="sr-only"> (com erro)</span>');
    // what a reader reads: the text without the tags, the icon having none
    expect(markup.replace(/<[^>]+>/g, "")).toBe("Dados (com erro)");
  });

  it("without an error: only the name", () => {
    expect(
      renderToStaticMarkup(<TabLabel invalid={false} label="Dados" />)
    ).toBe("Dados");
  });
});
