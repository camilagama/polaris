import { describe, expect, it } from "vitest";
import {
  ATTENTION_NAV_ITEM,
  addressWithTab,
  BOTTOM_BAR_IDS,
  bottomBarMark,
  documentTitle,
  entryPageFor,
  legacyAddress,
  menuItemsOf,
  NAV_ITEMS,
  navGroups,
  requestedTab,
  resolveRoute,
  SCREEN_TABS,
  tabHref,
} from "./navigation-model";

describe("main menu", () => {
  it("lists the eight destinations in workflow order, each once, the Início first (map of navigation, § 1)", () => {
    expect(NAV_ITEMS.map((item) => item.label)).toEqual([
      "Início",
      "Vender",
      "Histórico",
      "Estoque",
      "Produtos",
      "Clientes",
      "Resultado",
      "Configurações",
    ]);
    expect(new Set(NAV_ITEMS.map((item) => item.id)).size).toBe(8);
    expect(new Set(NAV_ITEMS.map((item) => item.href)).size).toBe(8);
  });

  it("groups the sidebar: Catálogo, Resultado and Configurações", () => {
    const groups = navGroups(NAV_ITEMS).map((group) => [
      group.label,
      group.items.map((item) => item.label),
    ]);
    expect(groups).toEqual([
      [null, ["Início", "Vender", "Histórico"]],
      ["Catálogo", ["Estoque", "Produtos", "Clientes"]],
      ["Resultado", ["Resultado"]],
      ["Configurações", ["Configurações"]],
    ]);
  });

  it("adds Pendências as the ninth, after Histórico, only while there is a refused record", () => {
    expect(menuItemsOf({ attention: false })).toEqual(NAV_ITEMS);
    const items = menuItemsOf({ attention: true });
    expect(items.map((item) => item.label)).toEqual([
      "Início",
      "Vender",
      "Histórico",
      "Pendências",
      "Estoque",
      "Produtos",
      "Clientes",
      "Resultado",
      "Configurações",
    ]);
    expect(ATTENTION_NAV_ITEM.href).toBe("/attention");
    expect(NAV_ITEMS.some((item) => item.id === "attention")).toBe(false);
  });

  it("uses the words of textos.md: Formas de receber, Pendências, never the old names", () => {
    const labels = [
      ...menuItemsOf({ attention: true }).map((item) => item.label),
      ...Object.values(SCREEN_TABS).flatMap((tabs) =>
        tabs.map((tab) => tab.label)
      ),
    ];
    expect(labels).toContain("Formas de receber");
    expect(labels).not.toContain("Perfis de pagamento");
    expect(labels).not.toContain("Operações que precisam de atenção");
  });

  it("the bottom bar of the phone is Início, Histórico, Vender (in the middle, with Mais the fifth) and Estoque; the rest is under Mais", () => {
    expect(
      BOTTOM_BAR_IDS.map(
        (id) => NAV_ITEMS.find((item) => item.id === id)?.label
      )
    ).toEqual(["Início", "Histórico", "Vender", "Estoque"]);
  });

  it("marks Estoque on Produtos and Clientes, and Mais on Pendências, Resultado and Configurações", () => {
    expect(
      Object.fromEntries(
        menuItemsOf({ attention: true }).map((item) => [
          item.id,
          bottomBarMark(item.id),
        ])
      )
    ).toEqual({
      attention: "more",
      customers: "inventory",
      dashboard: "more",
      history: "history",
      home: "home",
      inventory: "inventory",
      products: "inventory",
      sale: "sale",
      settings: "more",
    });
  });

  it("points every menu item at a route that exists, current on its own screen", () => {
    for (const item of menuItemsOf({ attention: true })) {
      const route = resolveRoute(item.href);
      expect(route.kind).toBe("page");
      if (route.kind === "page") {
        expect(route.navId).toBe(item.id);
      }
    }
  });
});

describe("tabs", () => {
  it("gives Produtos, Resultado and Configurações their tabs, in order", () => {
    expect(
      Object.fromEntries(
        Object.entries(SCREEN_TABS).map(([screen, tabs]) => [
          screen,
          tabs.map((tab) => tab.label),
        ])
      )
    ).toEqual({
      dashboard: ["Resultado", "Metas", "Despesas"],
      products: ["Produtos", "Categorias"],
      settings: [
        "Formas de receber",
        "Catálogo público",
        "Aparelhos",
        "Assinatura",
        "Senha",
      ],
    });
  });

  it("opens the tab of `aba`, or the first one for none or an unknown one", () => {
    expect(requestedTab("products", "").value).toBe("produtos");
    expect(requestedTab("products", "?aba=categorias").value).toBe(
      "categorias"
    );
    expect(requestedTab("products", "?aba=metas").value).toBe("produtos");
    expect(requestedTab("settings", "?aba=senha&x=1").value).toBe("senha");
    expect(requestedTab("dashboard", "?aba=despesas").value).toBe("despesas");
  });

  it("opens Metas for the two links of the Início, over any `aba` (AC-13)", () => {
    expect(requestedTab("dashboard", "?meta=nova").value).toBe("metas");
    expect(requestedTab("dashboard", "?meta=lista&aba=despesas").value).toBe(
      "metas"
    );
    expect(requestedTab("dashboard", "?meta=outra").value).toBe("resultado");
    // the parameter is the Resultado's only
    expect(requestedTab("products", "?meta=nova").value).toBe("produtos");
  });

  it("writes the tab into an address, the first one as no `aba`, keeping the rest", () => {
    expect(addressWithTab("/dashboard?x=1#topo", "dashboard", "metas")).toBe(
      "/dashboard?x=1&aba=metas#topo"
    );
    expect(
      addressWithTab("/dashboard?aba=metas&x=1", "dashboard", "resultado")
    ).toBe("/dashboard?x=1");
    expect(tabHref("settings", "senha")).toBe("/configuracoes?aba=senha");
    expect(tabHref("settings", "formas-de-receber")).toBe("/configuracoes");
    expect(tabHref("products", "categorias")).toBe("/products?aba=categorias");
  });
});

describe("the addresses of the screens that became tabs (map § 6)", () => {
  it("open their tab", () => {
    expect(
      Object.fromEntries(
        [
          "/categories",
          "/expenses",
          "/payment-profiles",
          "/public-catalog",
          "/devices",
          "/subscription",
          "/conta/seguranca",
        ].map((path) => [path, legacyAddress(path, "", "")])
      )
    ).toEqual({
      "/categories": "/products?aba=categorias",
      "/conta/seguranca": "/configuracoes?aba=senha",
      "/devices": "/configuracoes?aba=aparelhos",
      "/expenses": "/dashboard?aba=despesas",
      "/payment-profiles": "/configuracoes",
      "/public-catalog": "/configuracoes?aba=catalogo-publico",
      "/subscription": "/configuracoes?aba=assinatura",
    });
  });

  it("keep the rest of the query and the hash (the return of a checkout), with or without a trailing slash", () => {
    expect(
      legacyAddress("/subscription/", "?retorno=concluida", "#plano")
    ).toBe("/configuracoes?retorno=concluida&aba=assinatura#plano");
    expect(legacyAddress("/expenses", "?aba=outra", "")).toBe(
      "/dashboard?aba=despesas"
    );
  });

  it("leave every other address alone", () => {
    for (const path of [
      "/",
      "/products",
      "/sales/customer",
      "/toString",
      "/__proto__",
    ]) {
      expect(legacyAddress(path, "", "")).toBeNull();
    }
  });

  it("are no route of their own any more, and `/sales/customer` is gone (the 404 of the shell)", () => {
    for (const path of [
      "/categories",
      "/expenses",
      "/devices",
      "/subscription",
      "/conta/seguranca",
      "/sales/customer",
    ]) {
      expect(resolveRoute(path).kind).toBe("not-found");
    }
  });
});

describe("resolveRoute", () => {
  it("opens the Início at the root, and the sale at /sales", () => {
    expect(resolveRoute("/")).toEqual({
      connectionForm: true,
      id: "home",
      kind: "page",
      navId: "home",
      // offline it shows the device's copy, or says per block what waits for the connection (§ 7.4)
      onlineOnly: false,
      screen: "home",
      title: "Início",
    });
    expect(resolveRoute("/sales")).toMatchObject({
      id: "sale",
      kind: "page",
      navId: "sale",
      title: "Nova venda",
    });
  });

  it("keeps the history current on the sale detail", () => {
    expect(resolveRoute("/sales/detail")).toMatchObject({
      id: "sale-detail",
      navId: "history",
    });
  });

  it("opens the period result at /dashboard, titled Resultado, and names a tab by its own name", () => {
    expect(resolveRoute("/dashboard")).toEqual({
      connectionForm: true,
      id: "dashboard",
      kind: "page",
      navId: "dashboard",
      onlineOnly: false,
      screen: "dashboard",
      title: "Resultado",
    });
    expect(resolveRoute("/dashboard", "?aba=despesas")).toMatchObject({
      id: "expenses",
      navId: "dashboard",
      onlineOnly: true,
      screen: "dashboard",
      title: "Despesas",
    });
    expect(resolveRoute("/configuracoes")).toMatchObject({
      id: "payment-profiles",
      navId: "settings",
      screen: "settings",
      title: "Configurações",
    });
  });

  it("gives the Assinatura its behavior offline: no form, loads by itself on the return (AS-8)", () => {
    expect(resolveRoute("/configuracoes", "?aba=assinatura")).toEqual({
      connectionForm: false,
      id: "subscription",
      kind: "page",
      navId: "settings",
      onlineOnly: true,
      screen: "settings",
      title: "Assinatura",
    });
  });

  it("marks the screens and tabs that work only online, and not the ones that work from the device (U-54)", () => {
    for (const [path, search] of [
      ["/configuracoes", ""],
      ["/configuracoes", "?aba=catalogo-publico"],
      ["/configuracoes", "?aba=senha"],
      ["/configuracoes", "?aba=assinatura"],
      ["/dashboard", "?aba=despesas"],
      ["/products", "?aba=categorias"],
      ["/sales/detail", ""],
    ] as const) {
      expect(resolveRoute(path, search)).toMatchObject({ onlineOnly: true });
    }
    for (const [path, search] of [
      ["/", ""],
      ["/sales", ""],
      ["/sales/history", ""],
      ["/inventory", ""],
      ["/products", ""],
      ["/customers", ""],
      ["/dashboard", ""],
      ["/dashboard", "?aba=metas"],
      ["/configuracoes", "?aba=aparelhos"],
    ] as const) {
      expect(resolveRoute(path, search)).toMatchObject({ onlineOnly: false });
    }
  });

  it("tells the connection notice which online-only screens hold a form to type in", () => {
    for (const [path, search] of [
      ["/configuracoes", ""],
      ["/dashboard", "?aba=despesas"],
      ["/products", "?aba=categorias"],
    ] as const) {
      expect(resolveRoute(path, search)).toMatchObject({
        connectionForm: true,
      });
    }
    // the catalog declares its form once it loaded; the sale detail is read first
    for (const [path, search] of [
      ["/configuracoes", "?aba=catalogo-publico"],
      ["/sales/detail", ""],
    ] as const) {
      expect(resolveRoute(path, search)).toMatchObject({
        connectionForm: false,
      });
    }
  });

  it("ignores trailing slashes", () => {
    expect(resolveRoute("/inventory/")).toMatchObject({ id: "inventory" });
    expect(resolveRoute("/sales/history//")).toMatchObject({
      id: "sale-history",
    });
  });

  it("answers not-found for unknown paths and inherited object keys", () => {
    for (const path of [
      "/nope",
      "/sales/unknown",
      "/Inventory",
      "/constructor",
      "/__proto__",
      "/toString",
    ]) {
      expect(resolveRoute(path).kind).toBe("not-found");
    }
  });
});

describe("documentTitle", () => {
  it("appends the product name", () => {
    expect(documentTitle("Estoque")).toBe("Estoque · Polaris");
  });
});

describe("the sign-in route", () => {
  it("is recognised with or without a trailing slash, and only exactly", () => {
    expect(entryPageFor("/entrar")).toBe("sign-in");
    expect(entryPageFor("/entrar/")).toBe("sign-in");
    for (const path of ["/", "/entrar/x", "/entrarr", "/sales", "/ENTRAR"]) {
      expect(entryPageFor(path)).toBeNull();
    }
  });

  it("has the password pages beside it, each by its exact path (ADR 0100)", () => {
    expect(entryPageFor("/criar-conta")).toBe("sign-up");
    expect(entryPageFor("/esqueci-a-senha")).toBe("forgot-password");
    expect(entryPageFor("/redefinir-senha")).toBe("reset-password");
    expect(entryPageFor("/confirmar-email")).toBe("confirm-email");
    expect(entryPageFor("/desbloquear")).toBe("unlock");
    for (const path of ["/redefinir-senha/abc", "/toString", "/__proto__"]) {
      expect(entryPageFor(path)).toBeNull();
    }
    expect(resolveRoute("/configuracoes", "?aba=senha")).toMatchObject({
      id: "account-security",
      kind: "page",
    });
  });

  it("is not a page of the shell: it has no menu and no organization", () => {
    expect(resolveRoute("/entrar").kind).toBe("not-found");
  });
});
