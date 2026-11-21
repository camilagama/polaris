// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  checklistOf,
  firstProductId,
  forgetLargeCatalog,
  hasStock,
  knowsLargeCatalog,
  LARGE_CATALOG_KEY,
  rememberLargeCatalog,
  stockOf,
  unknownCostPage,
  type WideEntry,
  wholeCatalog,
  withoutStockPage,
} from "./home-inventory";

const entry = (
  over: Partial<WideEntry> & { productId?: string }
): WideEntry => ({
  movingAverageCost: "5.00",
  productId: "p",
  productStatus: "active",
  quantity: 1,
  ...over,
});

const ACTIVE_STOCKED = entry({ productId: "a" });
const ACTIVE_EMPTY = entry({ productId: "b", quantity: 0 });
const ACTIVE_NO_COST = entry({ movingAverageCost: null, productId: "c" });
const ACTIVE_NO_ROW = entry({
  movingAverageCost: null,
  productId: "d",
  quantity: 0,
});
const ARCHIVED_STOCKED = entry({ productId: "x", productStatus: "archived" });
const ARCHIVED_EMPTY = entry({
  movingAverageCost: null,
  productId: "y",
  productStatus: "archived",
  quantity: 0,
});

describe("a lista larga do Início", () => {
  describe("wholeCatalog", () => {
    it("sem próxima página é o catálogo inteiro, com 100 entradas exatas também", () => {
      const hundred = Array.from({ length: 100 }, () => ACTIVE_STOCKED);

      expect(wholeCatalog({ entries: hundred, nextCursor: null })).toBe(
        hundred
      );
    });

    it("com próxima página não é o catálogo: nada se deriva", () => {
      expect(
        wholeCatalog({ entries: [ACTIVE_STOCKED], nextCursor: "mais" })
      ).toBeNull();
    });

    it("uma lista vazia sem próxima página é um catálogo vazio, não 'não sei'", () => {
      expect(wholeCatalog({ entries: [], nextCursor: null })).toEqual([]);
    });
  });

  describe("primeiro produto", () => {
    it("lista vazia: nenhum", () => {
      expect(firstProductId([])).toBeNull();
    });

    it("é a primeira entrada, arquivada ou não (a ordem é a do servidor)", () => {
      expect(firstProductId([ARCHIVED_STOCKED, ACTIVE_STOCKED])).toBe("x");
    });
  });

  describe("tem estoque", () => {
    it("lista vazia: não", () => {
      expect(hasStock([])).toBe(false);
    });

    it("só com estoque: sim", () => {
      expect(hasStock([ACTIVE_STOCKED])).toBe(true);
    });

    it("só sem estoque: não", () => {
      expect(hasStock([ACTIVE_EMPTY, ACTIVE_NO_ROW])).toBe(false);
    });

    it("estoque de produto arquivado não conta: o filtro do servidor é de produtos ativos", () => {
      expect(hasStock([ARCHIVED_STOCKED])).toBe(false);
    });

    it("quantidade 1 conta (não é '>= 0')", () => {
      expect(hasStock([entry({ quantity: 1 })])).toBe(true);
      expect(hasStock([entry({ quantity: 0 })])).toBe(false);
    });
  });

  describe("sem estoque (S)", () => {
    it("lista vazia: 0, sem 'mais'", () => {
      expect(withoutStockPage([])).toEqual({ count: 0, more: false });
    });

    it("só arquivadas: 0", () => {
      expect(withoutStockPage([ARCHIVED_EMPTY, ARCHIVED_STOCKED])).toEqual({
        count: 0,
        more: false,
      });
    });

    it("só com estoque: 0", () => {
      expect(withoutStockPage([ACTIVE_STOCKED, ACTIVE_NO_COST])).toEqual({
        count: 0,
        more: false,
      });
    });

    it("conta só as ativas com quantidade 0, a variante sem linha de saldo incluída", () => {
      expect(
        withoutStockPage([
          ACTIVE_STOCKED,
          ACTIVE_EMPTY,
          ACTIVE_NO_ROW,
          ARCHIVED_EMPTY,
        ])
      ).toEqual({ count: 2, more: false });
    });
  });

  describe("sem custo (C)", () => {
    it("lista vazia: 0", () => {
      expect(unknownCostPage([])).toEqual({ count: 0, more: false });
    });

    it("custo conhecido não conta, nem o custo '0.00' (custo zero é custo)", () => {
      expect(
        unknownCostPage([ACTIVE_STOCKED, entry({ movingAverageCost: "0.00" })])
      ).toEqual({ count: 0, more: false });
    });

    it("conta as ativas com custo nulo, com ou sem estoque e sem linha de saldo; as arquivadas não", () => {
      expect(
        unknownCostPage([
          ACTIVE_STOCKED,
          ACTIVE_NO_COST,
          ACTIVE_NO_ROW,
          ARCHIVED_EMPTY,
        ])
      ).toEqual({ count: 2, more: false });
    });
  });

  describe("o conjunto", () => {
    it("o checklist junta o primeiro produto e o estoque", () => {
      expect(checklistOf([])).toEqual({
        firstProductId: null,
        hasStock: false,
      });
      expect(checklistOf([ARCHIVED_EMPTY, ACTIVE_STOCKED])).toEqual({
        firstProductId: "y",
        hasStock: true,
      });
    });

    it("C só sai quando a tela o mostraria", () => {
      const entries = [ACTIVE_NO_COST, ACTIVE_EMPTY];

      expect(stockOf(entries, false)).toEqual({
        unknownCost: null,
        withoutStock: { count: 1, more: false },
      });
      expect(stockOf(entries, true)).toEqual({
        unknownCost: { count: 1, more: false },
        withoutStock: { count: 1, more: false },
      });
    });
  });
});

describe("a pista 'catálogo > 100' da aba", () => {
  beforeEach(() => {
    forgetLargeCatalog();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("começa desconhecida, guarda a loja e vale só para ela", () => {
    expect(knowsLargeCatalog("org-a")).toBe(false);

    rememberLargeCatalog("org-a");

    expect(knowsLargeCatalog("org-a")).toBe(true);
  });

  it("sobrevive à recarga da página (a navegação do menu): está no sessionStorage da aba", () => {
    rememberLargeCatalog("org-a");

    expect(window.sessionStorage.getItem(LARGE_CATALOG_KEY)).toBe("org-a");
  });

  it("trocar de loja apaga a pista da anterior", () => {
    rememberLargeCatalog("org-a");

    expect(knowsLargeCatalog("org-b")).toBe(false);
    expect(window.sessionStorage.getItem(LARGE_CATALOG_KEY)).toBeNull();
    expect(knowsLargeCatalog("org-a")).toBe(false);
  });

  it("Sair e sessão encerrada apagam a pista", () => {
    rememberLargeCatalog("org-a");

    forgetLargeCatalog();

    expect(knowsLargeCatalog("org-a")).toBe(false);
  });

  it("nunca vai ao localStorage", () => {
    rememberLargeCatalog("org-a");

    expect(window.localStorage.length).toBe(0);
  });

  it("onde o navegador recusa o sessionStorage a pista fica na memória da página", () => {
    const refusing = {
      getItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };

    rememberLargeCatalog("org-a", refusing);

    expect(knowsLargeCatalog("org-a", refusing)).toBe(true);
    forgetLargeCatalog(refusing);
    expect(knowsLargeCatalog("org-a", refusing)).toBe(false);
  });
});
