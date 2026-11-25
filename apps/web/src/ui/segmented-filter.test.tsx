import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SegmentedFilter } from "./segmented-filter";

/**
 * The state choice of a list drawn without a browser: the roles Base UI gives the Tabs, the chosen tab and the
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
const SCROLL_BOX = /overflow-x-auto[^>]*>\s*<div[^>]*role="tablist"/;
const TAB_LIST_TAG = /<div[^>]*role="tablist"[^>]*>/;
const TAB_LIST =
  /<div[^>]*role="tablist"[^>]*aria-label="Estado das categorias"/;

function draw(value: (typeof OPTIONS)[number][0], disabled = false) {
  return renderToStaticMarkup(
    <SegmentedFilter
      disabled={disabled}
      label="Estado das categorias"
      onSelect={noop}
      options={OPTIONS}
      value={value}
    />
  );
}

describe("SegmentedFilter", () => {
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

  it("sits in the scroll box of the tabs, so a long set of options never widens the page", () => {
    const markup = draw("active");
    expect(markup).toMatch(SCROLL_BOX);
  });

  it("writes the smaller type and padding of a shared line only when asked", () => {
    const compact = renderToStaticMarkup(
      <SegmentedFilter
        compact
        label="Situação"
        onSelect={noop}
        options={OPTIONS}
        value="active"
      />
    );
    expect(compact).toContain("text-xs");
    expect(draw("active")).not.toContain("text-xs");
  });

  it("gives the strip of a shared line its breathing room, 2 px on a phone and 3 px from 640 px, and no other strip", () => {
    const compact = renderToStaticMarkup(
      <SegmentedFilter
        compact
        label="Situação"
        onSelect={noop}
        options={OPTIONS}
        value="active"
      />
    );
    const list = compact.match(TAB_LIST_TAG)?.[0] ?? "";
    expect(list).toContain("p-0.5");
    expect(list).toContain("sm:p-0.75");
    const plain = draw("active").match(TAB_LIST_TAG)?.[0] ?? "";
    expect(plain).not.toContain("p-0.5");
    expect(plain).not.toContain("sm:p-0.75");
  });
});
