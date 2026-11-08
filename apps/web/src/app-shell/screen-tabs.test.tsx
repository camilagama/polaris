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
  TabsTrigger: ({
    children,
    "aria-describedby": describedBy,
  }: {
    children: ReactNode;
    "aria-describedby"?: string | undefined;
  }) => (
    <button aria-describedby={describedBy} type="button">
      {children}
    </button>
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

const NAME_OF_ROW = /<span[^>]*data-tabs-group="Da loja"[^>]*>/;
const ID_ATTRIBUTE = /id="([^"]+)"/;

describe("the tabs in named rows", () => {
  const GROUPS = [
    { label: "Da loja", values: ["produtos"] },
    { label: "Da conta", values: ["outra"] },
  ];

  function rows(groups: typeof GROUPS) {
    address.search = "";
    return renderToStaticMarkup(
      <ScreenTabs
        groups={groups}
        label="Abas"
        panels={PANELS}
        screen="products"
        title="Produtos"
      />
    );
  }

  it("writes the name of each row that has a tab, and none for a row with none", () => {
    const html = rows(GROUPS);
    expect(html).toContain('data-tabs-group="Da loja"');
    expect(html).not.toContain('data-tabs-group="Da conta"');
    expect(html.split("data-tabs-group=")).toHaveLength(2);
  });

  it("leaves the name of a row readable and points each tab of the row at it", () => {
    const html = rows([
      { label: "Da loja", values: ["produtos"] },
      { label: "Da conta", values: ["categorias"] },
    ]);
    const name = html.match(NAME_OF_ROW)?.[0] ?? "";
    expect(name).not.toContain("aria-hidden");
    expect(html).toContain('role="none"');
    expect(html).not.toContain('role="group"');
    expect(html).not.toContain("<h2");
    const nameId = name.match(ID_ATTRIBUTE)?.[1] ?? "";
    expect(nameId).not.toBe("");
    const describedBy = (tabName: string) =>
      html.match(
        new RegExp(`<button[^>]*aria-describedby="([^"]+)"[^>]*>${tabName}<`)
      )?.[1];
    expect(describedBy("Produtos")).toBe(nameId);
    const other = describedBy("Categorias") ?? "";
    expect(other).not.toBe("");
    expect(other).not.toBe(nameId);
    expect(html).toContain(`id="${other}"`);
    expect(html.indexOf('data-tabs-group="Da loja"')).toBeLessThan(
      html.indexOf(">Produtos</button>")
    );
    expect(html.indexOf(">Produtos</button>")).toBeLessThan(
      html.indexOf('data-tabs-group="Da conta"')
    );
  });

  it("gives the tabs of a single strip no description", () => {
    address.search = "";
    const html = renderToStaticMarkup(
      <ScreenTabs
        label="Abas"
        panels={PANELS}
        screen="products"
        title="Produtos"
      />
    );
    expect(html).not.toContain("aria-describedby");
  });
});
