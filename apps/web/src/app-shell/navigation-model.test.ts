import { describe, expect, it } from "vitest";
import {
  documentTitle,
  NAV_ITEMS,
  OFFLINE_NAV_ITEMS,
  resolveRoute,
} from "./navigation-model";

describe("main menu", () => {
  it("lists the seven areas in workflow order, each once", () => {
    expect(NAV_ITEMS.map((item) => item.label)).toEqual([
      "Vender",
      "Histórico",
      "Estoque",
      "Produtos",
      "Categorias",
      "Clientes",
      "Perfis de pagamento",
    ]);
    expect(new Set(NAV_ITEMS.map((item) => item.id)).size).toBe(7);
    expect(new Set(NAV_ITEMS.map((item) => item.href)).size).toBe(7);
  });

  it("does not offer the customer-of-a-sale page, which asks for an ID", () => {
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
  it("opens the sale screen at the root instead of categories", () => {
    expect(resolveRoute("/")).toMatchObject({
      id: "sale",
      kind: "page",
      navId: "sale",
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
