import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusNav } from "./screen-parts";

/**
 * The state choice of a list (t300) drawn without a browser: the roles Base UI gives the Tabs, the chosen tab and the
 * lock while an action runs. The arrows, Tab and the list asked again are in the browser specs of each screen
 * (`e2e/tabs-keyboard.ts`).
 */
const OPTIONS = [
  ["active", "Ativas"],
  ["archived", "Arquivadas"],
  ["deleted", "Removidas"],
] as const;
const noop = () => undefined;

const TAB_TAG = /<button[^>]*role="tab"[^>]*>/g;
const TAB_LIST =
  /<div[^>]*role="tablist"[^>]*aria-label="Estado das categorias"/;

function draw(value: (typeof OPTIONS)[number][0], disabled = false) {
  return renderToStaticMarkup(
    <StatusNav
      disabled={disabled}
      label="Estado das categorias"
      onSelect={noop}
      options={OPTIONS}
      value={value}
    />
  );
}

describe("StatusNav", () => {
  it("is a named list of tabs, the chosen one selected, and no toggle button or nav left", () => {
    const markup = draw("archived");
    expect(markup).toMatch(TAB_LIST);
    const tabs = markup.match(TAB_TAG) ?? [];
    expect(tabs).toHaveLength(3);
    expect(tabs.map((tab) => tab.includes('aria-selected="true"'))).toEqual([
      false,
      true,
      false,
    ]);
    expect(markup).not.toContain("aria-pressed");
    expect(markup).not.toContain("<nav");
  });

  it("writes the options in the order given, with their words", () => {
    const text = draw("active").replaceAll(/<[^>]+>/g, "|");
    expect(text.match(/Ativas|Arquivadas|Removidas/g)).toEqual([
      "Ativas",
      "Arquivadas",
      "Removidas",
    ]);
  });

  it("keeps the tabs on and the project's two rules of touch and focus while enabled", () => {
    const tabs = draw("active").match(TAB_TAG) ?? [];
    expect(tabs.some((tab) => tab.includes('aria-disabled="true"'))).toBe(
      false
    );
    expect(tabs.every((tab) => tab.includes("touch-hit"))).toBe(true);
    expect(tabs.every((tab) => tab.includes("focus-ring"))).toBe(true);
  });

  it("turns every tab off while an action runs (Base UI says it with aria-disabled, not with disabled)", () => {
    const tabs = draw("active", true).match(TAB_TAG) ?? [];
    expect(tabs).toHaveLength(3);
    expect(tabs.every((tab) => tab.includes('aria-disabled="true"'))).toBe(
      true
    );
  });
});
