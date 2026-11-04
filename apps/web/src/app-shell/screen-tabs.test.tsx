import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { LazyScreen } from "./lazy-screen";
import { ScreenTabPanel, ScreenTabs } from "./screen-tabs";
import { useTabActive } from "./screen-title";

const address = vi.hoisted(() => ({ search: "" }));

vi.mock("./address", () => ({
  replaceAddress: vi.fn(),
  useAddress: () => ({ pathname: "/products", search: address.search }),
}));

// A panel that is not open is not drawn on the server; this stub draws every panel, as the one kept mounted is on the
// client, so the screen of a hidden tab is rendered and can say whether it is active.
vi.mock("@/ui/tabs", () => ({
  Tabs: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsContent: ({
    children,
    value,
  }: {
    children: ReactNode;
    value: string;
  }) => <section data-panel={value}>{children}</section>,
  TabsList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children: ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));

function probe(name: string): LazyScreen {
  const Screen = () => (
    <p data-screen={name}>{useTabActive() ? "active" : "hidden"}</p>
  );
  return Object.assign(Screen, { reset: () => undefined });
}

const PANELS = [
  { Screen: probe("produtos"), value: "produtos" },
  { Screen: probe("categorias"), value: "categorias" },
];

function stateOf(html: string, name: string): string | undefined {
  return html.match(new RegExp(`data-screen="${name}">(\\w+)<`))?.[1];
}

describe("the screen of a tab knows whether its tab is the open one", () => {
  it("is active only in the open tab of ScreenTabs", () => {
    address.search = "";
    const first = renderToStaticMarkup(
      <ScreenTabs
        label="Abas"
        panels={PANELS}
        screen="products"
        title="Produtos"
      />
    );
    expect(stateOf(first, "produtos")).toBe("active");
    expect(stateOf(first, "categorias")).toBe("hidden");

    address.search = "?aba=categorias";
    const second = renderToStaticMarkup(
      <ScreenTabs
        label="Abas"
        panels={PANELS}
        screen="products"
        title="Produtos"
      />
    );
    expect(stateOf(second, "produtos")).toBe("hidden");
    expect(stateOf(second, "categorias")).toBe("active");
  });

  it("stays active in a panel drawn with no tab list around it", () => {
    const html = renderToStaticMarkup(
      <ScreenTabPanel panel={PANELS[0] as (typeof PANELS)[number]} />
    );
    expect(stateOf(html, "produtos")).toBe("active");
  });
});
