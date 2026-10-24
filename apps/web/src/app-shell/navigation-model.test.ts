import { describe, expect, it } from "vitest";
import {
  BOTTOM_BAR_IDS,
  bottomBarMark,
  documentTitle,
  entryPageFor,
  NAV_ITEMS,
  navGroups,
  OFFLINE_NAV_ITEMS,
  resolveRoute,
} from "./navigation-model";

describe("main menu", () => {
  it("lists the eleven areas in workflow order, each once, the Início first", () => {
    expect(NAV_ITEMS.map((item) => item.label)).toEqual([
      "Início",
      "Vender",
      "Histórico",
      "Estoque",
      "Produtos",
      "Categorias",
      "Clientes",
      "Despesas",
      "Resultado",
      "Perfis de pagamento",
      "Catálogo público",
    ]);
    expect(new Set(NAV_ITEMS.map((item) => item.id)).size).toBe(11);
    expect(new Set(NAV_ITEMS.map((item) => item.href)).size).toBe(11);
  });

  it("groups the sidebar as in the v5.1 shell, Aparelhos last in Configurações", () => {
    const groups = navGroups([...NAV_ITEMS, ...OFFLINE_NAV_ITEMS]).map(
      (group) => [group.label, group.items.map((item) => item.label)]
    );
    expect(groups).toEqual([
      [null, ["Início", "Vender", "Histórico"]],
      ["Catálogo", ["Estoque", "Produtos", "Categorias", "Clientes"]],
      ["Resultado", ["Despesas", "Resultado"]],
      [
        "Configurações",
        ["Perfis de pagamento", "Catálogo público", "Aparelhos"],
      ],
    ]);
  });

  it("the bottom bar of the phone is Início, Vender, Histórico and Estoque; the rest is under Mais", () => {
    expect(
      BOTTOM_BAR_IDS.map(
        (id) => NAV_ITEMS.find((item) => item.id === id)?.label
      )
    ).toEqual(["Início", "Vender", "Histórico", "Estoque"]);
  });

  it("marks the destination of the area on the bottom bar, and Mais only for the screens of no destination", () => {
    expect(
      Object.fromEntries(
        [...NAV_ITEMS, ...OFFLINE_NAV_ITEMS].map((item) => [
          item.id,
          bottomBarMark(item.id),
        ])
      )
    ).toEqual({
      categories: "inventory",
      customers: "inventory",
      dashboard: "more",
      devices: "more",
      expenses: "more",
      history: "history",
      home: "home",
      inventory: "inventory",
      "payment-profiles": "more",
      products: "inventory",
      "public-catalog": "more",
      sale: "sale",
    });
  });

  it("marks Mais on Pendências, a screen of no item of the menu", () => {
    const route = resolveRoute("/attention");
    expect(route).toMatchObject({ id: "attention", navId: "attention" });
    expect(NAV_ITEMS.some((item) => item.id === "attention")).toBe(false);
    expect(bottomBarMark("attention")).toBe("more");
  });

  it("does not offer the customer-of-a-sale page, which opens from a sale of the history", () => {
    expect(NAV_ITEMS.some((item) => item.href === "/sales/customer")).toBe(
      false
    );
  });

  it("points every menu item at a route that exists", () => {
    for (const item of NAV_ITEMS) {
      const route = resolveRoute(item.href);
      expect(route.kind).toBe("page");
      if (route.kind === "page") {
        expect(route.navId).toBe(item.id);
      }
    }
  });
});

describe("resolveRoute", () => {
  it("opens the Início at the root, and the sale at /sales", () => {
    expect(resolveRoute("/")).toEqual({
      // nothing to type: the notice says the screen loads by itself
      connectionForm: false,
      id: "home",
      kind: "page",
      navId: "home",
      // every figure is read from the server and there is no copy on the device yet (the PR 6 brings it)
      onlineOnly: true,
      title: "Início",
    });
    expect(resolveRoute("/sales")).toMatchObject({
      id: "sale",
      kind: "page",
      navId: "sale",
      title: "Nova venda",
    });
  });

  it("keeps the history current on the sale detail and customer link", () => {
    expect(resolveRoute("/sales/detail")).toMatchObject({
      id: "sale-detail",
      navId: "history",
    });
    expect(resolveRoute("/sales/customer")).toMatchObject({
      id: "sale-customer",
      navId: "history",
    });
  });

  it("opens the period result at /dashboard, titled Resultado", () => {
    expect(resolveRoute("/dashboard")).toEqual({
      connectionForm: true,
      id: "dashboard",
      kind: "page",
      navId: "dashboard",
      onlineOnly: false,
      title: "Resultado",
    });
  });

  it("marks the screens that work only online, and not the ones that work from the device (U-54)", () => {
    for (const path of [
      "/",
      "/public-catalog",
      "/payment-profiles",
      "/expenses",
      "/categories",
      "/sales/detail",
      "/conta/seguranca",
    ]) {
      expect(resolveRoute(path)).toMatchObject({ onlineOnly: true });
    }
    for (const path of [
      "/sales",
      "/sales/history",
      "/inventory",
      "/products",
      "/customers",
      "/dashboard",
    ]) {
      expect(resolveRoute(path)).toMatchObject({ onlineOnly: false });
    }
  });

  it("tells the connection notice which online-only screens hold a form to type in", () => {
    for (const path of ["/payment-profiles", "/expenses", "/categories"]) {
      expect(resolveRoute(path)).toMatchObject({ connectionForm: true });
    }
    // the catalog declares its form once it loaded; the sale detail is read first
    for (const path of ["/public-catalog", "/sales/detail"]) {
      expect(resolveRoute(path)).toMatchObject({ connectionForm: false });
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

describe("menu items of the offline runtime", () => {
  it("offers the devices screen outside the main menu, and the route exists", () => {
    expect(OFFLINE_NAV_ITEMS.map((item) => item.label)).toEqual(["Aparelhos"]);
    for (const item of OFFLINE_NAV_ITEMS) {
      expect(NAV_ITEMS.some((main) => main.id === item.id)).toBe(false);
      const route = resolveRoute(item.href);
      expect(route.kind).toBe("page");
      if (route.kind === "page") {
        expect(route.navId).toBe(item.id);
      }
    }
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
    expect(resolveRoute("/conta/seguranca")).toMatchObject({
      id: "account-security",
      kind: "page",
    });
  });

  it("is not a page of the shell: it has no menu and no organization", () => {
    expect(resolveRoute("/entrar").kind).toBe("not-found");
  });
});
