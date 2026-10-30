import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";

/**
 * The markup of the Tabs (ADR 0103, amendment "Gráficos"): the roles Base UI gives them and the three rules of
 * the project in the classes (list height, 48 px touch area, 3 px focus). The browser checks
 * (e2e-pwa/ui-charts.e2e.ts) measure the heights, the touch area and the focus in the gallery.
 */
const html = (node: React.ReactNode) => renderToStaticMarkup(node);

const markup = html(
  <Tabs defaultValue="7">
    <TabsList aria-label="Período">
      <TabsTrigger value="7">7 dias</TabsTrigger>
      <TabsTrigger value="30">30 dias</TabsTrigger>
    </TabsList>
    <TabsContent value="7">Sete dias</TabsContent>
    <TabsContent value="30">Trinta dias</TabsContent>
  </Tabs>
);

const TAB_TAG = /<button[^>]*role="tab"[^>]*>/g;
const TAB_LIST = /<div[^>]*role="tablist"[^>]*aria-label="Período"/;

describe("Tabs", () => {
  it("has a list, two tabs and the panel of the chosen one", () => {
    expect(markup).toMatch(TAB_LIST);
    const tabs = markup.match(TAB_TAG) ?? [];
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toContain('aria-selected="true"');
    expect(tabs[1]).toContain('aria-selected="false"');
    expect(markup).toContain('role="tabpanel"');
    expect(markup).toContain("Sete dias");
  });

  it("applies the three rules of the project", () => {
    // the height of the list comes from the --h-* tokens (32 px with a mouse, 36 px with touch)
    expect(markup).toContain("h-ctl-md");
    // a 44 px touch area around each tab and the 3 px outline of the keyboard
    expect(
      markup.match(TAB_TAG)?.every((tab) => tab.includes("touch-hit"))
    ).toBe(true);
    expect(
      markup.match(TAB_TAG)?.every((tab) => tab.includes("focus-ring"))
    ).toBe(true);
    expect(markup).not.toContain("h-8");
  });
});
