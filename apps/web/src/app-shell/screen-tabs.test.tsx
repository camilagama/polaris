import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { LazyScreen } from "./lazy-screen";
import { ScreenTabPanel, ScreenTabs } from "./screen-tabs";
import { SectionTabs } from "@/ui/section-tabs";
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

describe("the strip of tabs", () => {
  function draw(panels: typeof PANELS) {
    address.search = "";
    return renderToStaticMarkup(
      <ScreenTabs
        label="Abas"
        panels={panels}
        screen="products"
        title="Produtos"
      />
    );
  }

  it("draws one strip, with no name of a row and no description on its tabs", () => {
    const html = draw(PANELS);
    expect(html.split("<button")).toHaveLength(3);
    expect(html).not.toContain("data-tabs-group");
    expect(html).not.toContain("aria-describedby");
  });

  it("draws no strip, and the title once, for a screen with one tab", () => {
    const html = draw(PANELS.slice(0, 1));
    expect(html).not.toContain("<button");
    expect(html.split("<h1")).toHaveLength(2);
    expect(stateOf(html, "produtos")).toBe("active");
  });
});

describe("the tabs on a phone: a menu of rows in place of the strip", () => {
  function onPhone(search: string, showMenu: boolean) {
    address.search = search;
    return renderToStaticMarkup(
      <ScreenTabs
        label="Abas"
        panels={PANELS}
        phone={{
          back: { href: "/products", label: "Voltar para Produtos" },
          menu: <p>O menu de linhas</p>,
          showMenu,
        }}
        screen="products"
        title="Produtos"
      />
    );
  }

  it("draws the menu and no strip, and no tab is active, while the menu is open", () => {
    const html = onPhone("", true);
    expect(html).toContain("O menu de linhas");
    expect(html).not.toContain("Voltar");
    expect(html).not.toContain("<button");
    expect(stateOf(html, "produtos")).toBe("hidden");
    expect(stateOf(html, "categorias")).toBe("hidden");
  });

  it("draws the way back and the open tab, and no strip, once a tab is open", () => {
    const html = onPhone("?aba=categorias", false);
    expect(html).toContain("Voltar");
    expect(html).not.toContain("O menu de linhas");
    expect(html).not.toContain("<button");
    expect(stateOf(html, "categorias")).toBe("active");
    expect(stateOf(html, "produtos")).toBe("hidden");
  });
});

describe("SectionTabs: com rota e sem rota numa API só", () => {
  const TABS = [
    { content: <p>conteúdo a</p>, label: "A", value: "a" },
    { content: <p>conteúdo b</p>, label: "B", value: "b" },
  ];

  it("com `value` a aba aberta é de quem chama, e os painéis vêm como filhos", () => {
    const html = renderToStaticMarkup(
      <SectionTabs
        label="Abas"
        onValueChange={vi.fn()}
        tabs={TABS.map(({ label, value }) => ({ label, value }))}
        value="b"
      >
        <p>painel de fora</p>
      </SectionTabs>
    );
    expect(html.split("<button")).toHaveLength(3);
    expect(html).toContain("painel de fora");
    expect(html).not.toContain("conteúdo a");
  });

  it("sem `value` as abas são locais: o conteúdo vem da própria aba, sem título e sem tocar o endereço", () => {
    address.search = "?aba=categorias";
    const html = renderToStaticMarkup(
      <SectionTabs defaultValue="b" label="Abas locais" tabs={TABS} />
    );
    expect(html).not.toContain("<h1");
    expect(html.split("<button")).toHaveLength(3);
    expect(html).toContain("conteúdo a");
    expect(html).toContain("conteúdo b");
  });

  it("`hideList` não desenha a lista", () => {
    const html = renderToStaticMarkup(
      <SectionTabs hideList label="Abas" tabs={TABS} />
    );
    expect(html).not.toContain("<button");
  });
});
