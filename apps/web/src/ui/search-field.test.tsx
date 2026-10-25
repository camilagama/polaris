import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SearchField } from "@/ui/search-field";

/**
 * The markup of the search box of the lists: name, type and the "Limpar busca" button that exists only with text. That
 * the button empties the field and gives the focus back to it needs a browser: e2e/products-screen.e2e.ts and
 * e2e/stock-screen.e2e.ts check it.
 */
const ignore = () => undefined;
const html = (value: string) =>
  renderToStaticMarkup(
    <SearchField
      label="Buscar produto"
      onValueChange={ignore}
      placeholder="Nome do produto"
      value={value}
    />
  );

const INPUT_TAG = /<input [^>]*>/;
const BUTTON_TAG = /<button [^>]*>/;

describe("SearchField", () => {
  it("is a search field named by the label, with the search key of the keyboard", () => {
    const input = html("").match(INPUT_TAG)?.[0] ?? "";
    expect(input).toContain('type="search"');
    expect(input).toContain('aria-label="Buscar produto"');
    expect(input).toContain('enterKeyHint="search"');
    expect(input).toContain('autoComplete="off"');
  });

  it("offers no Limpar busca while the field is empty", () => {
    expect(html("")).not.toContain("Limpar busca");
  });

  it("offers Limpar busca, as a button that submits nothing, once there is text", () => {
    const button = html("camiseta").match(BUTTON_TAG)?.[0] ?? "";
    expect(button).toContain('aria-label="Limpar busca"');
    expect(button).toContain('type="button"');
  });

  it("hides the icons from the screen reader", () => {
    expect(
      html("camiseta").match(/<svg [^>]*aria-hidden="true"/g)
    ).toHaveLength(2);
  });
});
