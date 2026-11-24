import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SegmentedFilter } from "@/ui/segmented-filter";
import { SectionTabs } from "@/ui/section-tabs";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";

/**
 * The `line` variant of the Tabs: the tab of a screen is text with a 1 px rule across the list and a 2 px stroke in ink
 * under the open tab, and the segmented strip stays for the filters of a list. The browser check
 * (e2e-pwa/ui-abas-padrao.e2e.ts) measures the stroke, the rule and the colors on the real screens.
 */
const html = (node: React.ReactNode) => renderToStaticMarkup(node);

const CLASS = /class="([^"]*)"/;
const BRAND = /\bmark\b|-mark\b|primary|chart-1/;
const MOTION = /translate|scale|transition-all/;
const NOOP = () => undefined;
const TAB_TAG = /<button[^>]*role="tab"[^>]*>/g;
const LIST_TAG = /<div[^>]*role="tablist"[^>]*>/g;

const tabClasses = (markup: string) =>
  (markup.match(TAB_TAG) ?? []).map((tag) => CLASS.exec(tag)?.[1] ?? "");
const listClasses = (markup: string) =>
  (markup.match(LIST_TAG) ?? []).map((tag) => CLASS.exec(tag)?.[1] ?? "");

const TABS = [
  { content: "Um", label: "Resultado", value: "a" },
  { content: "Dois", label: "Metas", value: "b" },
] as const;

describe("Tabs, variant line", () => {
  const markup = html(<SectionTabs label="Partes" tabs={TABS} />);

  it("draws the list as a rule with no strip, and the tabs with the 2 px stroke in ink", () => {
    const [list] = listClasses(markup);
    expect(list).toContain("border-b");
    expect(list).toContain("min-w-full");
    expect(list).not.toContain("bg-muted");
    expect(list).not.toContain("rounded-lg");
    for (const tab of tabClasses(markup)) {
      expect(tab).toContain("after:h-0.5");
      expect(tab).toContain("after:bg-foreground");
      expect(tab).toContain("after:opacity-0");
      expect(tab).toContain("data-active:after:opacity-100");
      expect(tab).toContain("data-active:text-foreground");
    }
  });

  it("never uses the brand color, nor a filled tab, nor a shadow", () => {
    const all = [...listClasses(markup), ...tabClasses(markup)].join(" ");
    expect(all).not.toMatch(BRAND);
    expect(all).not.toContain("data-active:bg-");
    expect(all).not.toContain("shadow");
  });

  it("keeps the touch area, the focus outline and the closed tab in muted-foreground", () => {
    for (const tab of tabClasses(markup)) {
      expect(tab).toContain("touch-hit");
      expect(tab).toContain("focus-ring");
      expect(tab).toContain("text-muted-foreground");
    }
  });

  it("marks the list as line, for the browser checks", () => {
    expect(markup).toContain('data-variant="line"');
  });

  it("moves with opacity and color only: nothing slides or scales", () => {
    const all = tabClasses(markup).join(" ");
    expect(all).toContain("motion-full:after:transition-opacity");
    expect(all).not.toMatch(MOTION);
  });
});

describe("Tabs, variant segmented", () => {
  const filter = html(
    <SegmentedFilter
      label="Estado"
      onSelect={NOOP}
      options={[
        ["a", "Ativos"],
        ["b", "Arquivados"],
      ]}
      value="a"
    />
  );

  it("is still the strip of a filter, with the open tab filled", () => {
    const [list] = listClasses(filter);
    expect(list).toContain("bg-muted");
    expect(list).not.toContain("border-b");
    for (const tab of tabClasses(filter)) {
      expect(tab).toContain("data-active:bg-card");
      expect(tab).not.toContain("after:h-0.5");
    }
  });

  it("stays the strip inside the panel of a line tab", () => {
    const nested = html(
      <Tabs defaultValue="x">
        <TabsList aria-label="Tela" variant="line">
          <TabsTrigger value="x">Tela</TabsTrigger>
        </TabsList>
        <TabsContent value="x">
          <Tabs defaultValue="1">
            <TabsList aria-label="Filtro">
              <TabsTrigger value="1">Um</TabsTrigger>
            </TabsList>
          </Tabs>
        </TabsContent>
      </Tabs>
    );
    const [screen, inner] = listClasses(nested);
    expect(screen).toContain("border-b");
    expect(inner).toContain("bg-muted");
    const [, innerTab] = tabClasses(nested);
    expect(innerTab).toContain("data-active:bg-card");
    expect(innerTab).not.toContain("after:h-0.5");
  });
});
