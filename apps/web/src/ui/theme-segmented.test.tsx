import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ThemeSegmented } from "./theme-segmented";

const WORD_TAB = />(Automático|Claro|Escuro)<\/button>/g;
const TAB_TAG = /<button[^>]*role="tab"[^>]*>/g;

const APPEARANCE_LIST = /role="tablist"[^>]*aria-label="Aparência"/;

describe("ThemeSegmented", () => {
  const markup = renderToStaticMarkup(<ThemeSegmented />);

  it("is the state filter of the project: a named list of three tabs, none a toggle button", () => {
    expect(markup).toMatch(APPEARANCE_LIST);
    expect(markup.match(TAB_TAG)).toHaveLength(3);
    expect(markup).not.toContain("aria-pressed");
  });

  it("says the three choices in words, Automático first, and opens on the one that follows the system", () => {
    const words = [...markup.matchAll(WORD_TAB)].map(([, word]) => word);
    expect(words).toEqual(["Automático", "Claro", "Escuro"]);
    const open = (markup.match(TAB_TAG) ?? []).filter((tab) =>
      tab.includes('aria-selected="true"')
    );
    expect(open).toHaveLength(1);
    expect(open[0]).toContain('data-value="sistema"');
  });
});
