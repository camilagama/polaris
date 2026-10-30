import type { InventoryBalanceEntryReadModel } from "@polaris/contracts";
import { describe, expect, it } from "vitest";
import {
  canLoadMoreStock,
  defaultStockFilters,
  initialStockListState,
  STOCK_PAGE_SIZE,
  stockBalanceUpdated,
  stockAttentionLinks,
  stockAttentionRequest,
  stockCountText,
  stockEmptyMessage,
  stockListRequest,
  stockListView,
  stockLoaded,
  stockLoadFailed,
  stockLoading,
  stockMoreFailed,
  stockMoreLoaded,
  stockMoreStarted,
  stockMoreView,
  readStockLinkFilters,
  stockRows,
  type VariantCount,
  variantCount,
} from "./stock-list-model";

const organizationId = "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0";

function variantId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function entry(
  n: number,
  overrides: Partial<InventoryBalanceEntryReadModel> = {}
): InventoryBalanceEntryReadModel {
  return {
    isDefaultVariant: false,
    listPrice: null,
    movingAverageCost: "12.340000",
    productId: "11111111-1111-4111-8111-111111111111",
    productName: "Camiseta Polaris",
    productStatus: "active",
    quantity: 3,
    sku: "CAM-AZ-M",
    updatedAt: "2026-10-09T12:00:00.000Z",
    values: [
      { optionName: "color", optionValueName: "Azul" },
      { optionName: "size", optionValueName: "M" },
    ],
    variantId: variantId(n),
    version: 2,
    ...overrides,
  };
}

const ready = (
  entries: InventoryBalanceEntryReadModel[],
  nextCursor: string | null = null
) => stockLoaded(initialStockListState(), { entries, nextCursor });

describe("stockListRequest", () => {
  it("asks only for what is needed in one read", () => {
    expect(stockListRequest(organizationId, defaultStockFilters, null)).toEqual(
      {
        limit: STOCK_PAGE_SIZE,
        organizationId,
        productStatus: "active",
        stock: "all",
      }
    );
  });

  it("sends the trimmed search, the stock filter, archived scope and cursor", () => {
    expect(
      stockListRequest(
        organizationId,
        {
          includeArchived: true,
          query: "  azul ",
          stock: "with_stock",
          unknownCost: false,
        },
        "next-cursor"
      )
    ).toEqual({
      cursor: "next-cursor",
      limit: STOCK_PAGE_SIZE,
      organizationId,
      productStatus: "all",
      query: "azul",
      stock: "with_stock",
    });
  });

  it("asks the server for the variants without a known cost, with no stock filter", () => {
    expect(
      stockListRequest(
        organizationId,
        { ...defaultStockFilters, unknownCost: true },
        null
      )
    ).toEqual({
      cost: "unknown",
      limit: STOCK_PAGE_SIZE,
      organizationId,
      productStatus: "active",
      stock: "all",
    });
  });

  it("combines the unknown cost with the stock filter in one read", () => {
    expect(
      stockListRequest(
        organizationId,
        { ...defaultStockFilters, stock: "without_stock", unknownCost: true },
        null
      )
    ).toMatchObject({ cost: "unknown", stock: "without_stock" });
  });

  it("never sends a cost option unless the unknown cost is asked for", () => {
    for (const stock of ["all", "with_stock", "without_stock"] as const) {
      expect(
        stockListRequest(
          organizationId,
          { ...defaultStockFilters, stock },
          null
        )
      ).not.toHaveProperty("cost");
    }
  });

  it("leaves out a blank search", () => {
    expect(
      stockListRequest(
        organizationId,
        { ...defaultStockFilters, query: "   " },
        null
      )
    ).not.toHaveProperty("query");
  });
});

describe("readStockLinkFilters", () => {
  it("reads the two addresses the Início links to", () => {
    expect(readStockLinkFilters("?filtro=sem-saldo")).toEqual({
      stock: "without_stock",
      unknownCost: false,
    });
    for (const search of ["?filtro=sem-custo", "?x=1&filtro=sem-custo"]) {
      expect(readStockLinkFilters(search)).toEqual({
        stock: "all",
        unknownCost: true,
      });
    }
  });

  it("opens the plain list for anything else", () => {
    for (const search of [
      "",
      "?",
      "?filtro=",
      "?filtro=todas",
      "?filtro=SEM-CUSTO",
      "?filtro=unknown_cost",
      "?filtro=sem-custo%00",
      "?filtro=<script>alert(1)</script>",
    ]) {
      expect(readStockLinkFilters(search)).toEqual({
        stock: "all",
        unknownCost: false,
      });
    }
  });

  it("takes the first of two values", () => {
    expect(
      readStockLinkFilters("?filtro=sem-saldo&filtro=sem-custo").stock
    ).toBe("without_stock");
  });
});

describe("list state", () => {
  it("starts loading and shows the first page", () => {
    const state = ready([entry(1), entry(2)], null);
    expect(state.status).toBe("ready");
    expect(state.entries).toHaveLength(2);
  });

  it("keeps a showing list on a failed refresh and reports it", () => {
    const state = stockLoadFailed(
      stockLoading(ready([entry(1)])),
      new TypeError("offline")
    );
    expect(state.status).toBe("ready");
    expect(state.entries).toHaveLength(1);
    expect(state.moreError).toContain("Não foi possível carregar");
  });

  it("turns a failed first load into an error that says only what failed (the notice says the rest)", () => {
    const state = stockLoadFailed(initialStockListState(), {
      code: "UNAUTHORIZED",
    });
    expect(state.status).toBe("error");
    expect(state.error).toBe("Não foi possível carregar o estoque.");
  });

  it("pages with a cursor and never repeats a variant", () => {
    const first = ready([entry(1), entry(2)], "cursor-1");
    expect(canLoadMoreStock(first)).toBe(true);
    const started = stockMoreStarted(first);
    expect(started.loadingMore).toBe(true);
    expect(canLoadMoreStock(started)).toBe(false);
    expect(stockMoreStarted(started)).toBe(started);

    const next = stockMoreLoaded(started, {
      entries: [entry(2), entry(3)],
      nextCursor: null,
    });
    expect(next.entries.map((item) => item.variantId)).toEqual([
      variantId(1),
      variantId(2),
      variantId(3),
    ]);
    expect(next.loadingMore).toBe(false);
    expect(canLoadMoreStock(next)).toBe(false);
  });

  it("reports a failed page without losing the list", () => {
    const state = stockMoreFailed(stockMoreStarted(ready([entry(1)], "c")), {
      code: "FORBIDDEN",
    });
    expect(state.entries).toHaveLength(1);
    expect(state.loadingMore).toBe(false);
    expect(state.moreError).toContain("acesso");
  });

  it("keeps the last update time when a replayed command has no new one", () => {
    const state = stockBalanceUpdated(
      ready([entry(1)]),
      {
        movingAverageCost: null,
        quantity: 0,
        variantId: variantId(1),
        version: 6,
      },
      null
    );
    expect(state.entries[0]).toMatchObject({
      quantity: 0,
      updatedAt: "2026-10-09T12:00:00.000Z",
      version: 6,
    });
  });

  it("applies a returned balance to its row only", () => {
    const state = stockBalanceUpdated(
      ready([entry(1), entry(2)]),
      {
        movingAverageCost: "15.000000",
        quantity: 9,
        variantId: variantId(2),
        version: 5,
      },
      "2026-10-10T08:00:00.000Z"
    );
    expect(state.entries[0]?.quantity).toBe(3);
    expect(state.entries[1]).toMatchObject({
      movingAverageCost: "15.000000",
      quantity: 9,
      updatedAt: "2026-10-10T08:00:00.000Z",
      version: 5,
    });
  });
});

describe("stockRows", () => {
  it("shows product, variant, SKU, quantity and average cost, and no date: the movement panel has it", () => {
    const [row] = stockRows([entry(1, { quantity: 1234 })]);
    expect(row).toMatchObject({
      archived: false,
      costText: "R$ 12,34",
      costUnknown: false,
      productName: "Camiseta Polaris",
      quantityText: "1.234",
      skuText: "CAM-AZ-M",
      tone: "ok",
      variantText: "Azul / M",
    });
    expect(row).not.toHaveProperty("updatedText");
  });

  it("never turns an unknown cost into zero", () => {
    const [row] = stockRows([entry(1, { movingAverageCost: null })]);
    expect(row?.costText).toBe("Custo desconhecido");
    expect(row?.costUnknown).toBe(true);
  });

  it("marks a variant without balance", () => {
    const [row] = stockRows([
      entry(1, { movingAverageCost: null, quantity: 0, updatedAt: null }),
    ]);
    expect(row).toMatchObject({ tone: "empty" });
  });

  it("labels the default variant and archived products", () => {
    const [row] = stockRows([
      entry(1, {
        isDefaultVariant: true,
        listPrice: null,
        productStatus: "archived",
        sku: null,
        values: [],
      }),
    ]);
    expect(row).toMatchObject({
      archived: true,
      skuText: null,
      variantText: "Variante padrão",
    });
  });

  it("carries the target a command acts on, including the version", () => {
    const [row] = stockRows([entry(7, { version: 4 })]);
    expect(row?.target).toEqual({
      archived: false,
      movingAverageCost: "12.340000",
      productName: "Camiseta Polaris",
      quantity: 3,
      updatedAt: "2026-10-09T12:00:00.000Z",
      variantId: variantId(7),
      variantText: "Azul / M",
      version: 4,
    });
  });
});

describe("views", () => {
  it("covers loading, error, empty and ready", () => {
    expect(
      stockListView(initialStockListState(), defaultStockFilters).kind
    ).toBe("loading");
    expect(
      stockListView(
        stockLoadFailed(initialStockListState(), new Error("x")),
        defaultStockFilters
      ).kind
    ).toBe("error");
    expect(stockListView(ready([]), defaultStockFilters)).toMatchObject({
      kind: "empty",
      showCatalogLink: true,
    });
    expect(stockListView(ready([entry(1)]), defaultStockFilters).kind).toBe(
      "ready"
    );
  });

  it("explains an empty result by the filter that caused it", () => {
    expect(stockEmptyMessage({ ...defaultStockFilters, query: " azul " })).toBe(
      "Nenhuma variante encontrada para “azul”."
    );
    expect(
      stockEmptyMessage({ ...defaultStockFilters, stock: "with_stock" })
    ).toContain("Receber");
    expect(
      stockEmptyMessage({ ...defaultStockFilters, stock: "without_stock" })
    ).toContain("têm saldo");
    expect(
      stockListView(ready([]), { ...defaultStockFilters, query: "x" })
    ).toMatchObject({ kind: "empty", showCatalogLink: false });
  });

  it("says why the list without a cost is empty, online and without connection", () => {
    const filters = { ...defaultStockFilters, unknownCost: true };
    expect(stockEmptyMessage(filters)).toBe("Todas as variantes têm custo.");
    const offlineMessage =
      "Sem internet. A lista de variantes sem custo só carrega com conexão.";
    expect(stockEmptyMessage(filters, true)).toBe(offlineMessage);
    expect(stockEmptyMessage({ ...filters, query: "azul" }, true)).toBe(
      offlineMessage
    );
    expect(stockListView(ready([]), filters, true)).toMatchObject({
      kind: "empty",
      message: offlineMessage,
      showCatalogLink: false,
    });
  });

  it("does not count the variants without a cost when the device cannot know them", () => {
    const filters = { ...defaultStockFilters, unknownCost: true };
    expect(stockCountText(ready([]), filters, true)).toBeNull();
    // online it is the server's count; offline without the filter it is the device's list
    expect(stockCountText(ready([]), filters)).toBe("0 variantes");
    expect(stockCountText(ready([entry(1)]), defaultStockFilters, true)).toBe(
      "1 variante"
    );
  });

  it("says so when the unknown cost and the stock filter leave nothing", () => {
    expect(
      stockEmptyMessage({
        ...defaultStockFilters,
        stock: "without_stock",
        unknownCost: true,
      })
    ).toBe("Nenhuma variante sem custo com esse saldo.");
  });

  it("describes the load-more control and the count", () => {
    const withMore = ready([entry(1)], "c");
    expect(stockMoreView(withMore)).toMatchObject({
      busy: false,
      label: "Carregar mais",
      visible: true,
    });
    expect(stockMoreView(stockMoreStarted(withMore))).toMatchObject({
      busy: true,
      label: "Carregando…",
    });
    expect(stockMoreView(ready([entry(1)])).visible).toBe(false);
    expect(stockCountText(ready([entry(1)]))).toBe("1 variante");
    expect(stockCountText(withMore)).toBe("1 variante");
    expect(
      stockCountText(ready([entry(1), entry(2), entry(3), entry(4)], "c"))
    ).toBe("4 variantes");
  });
});

const page = (count: number, more = false): VariantCount => ({ count, more });

describe("stockAttentionLinks", () => {
  it("says the noun once and links each number to its filter", () => {
    expect(
      stockAttentionLinks({ unknownCost: page(1), withoutStock: page(1) })
    ).toEqual([
      {
        href: "/inventory?filtro=sem-saldo",
        id: "without-stock",
        text: "1 variante sem saldo",
      },
      {
        href: "/inventory?filtro=sem-custo",
        id: "unknown-cost",
        text: "1 sem custo",
      },
    ]);
    expect(
      stockAttentionLinks({ unknownCost: page(3), withoutStock: page(2) }).map(
        (link) => link.text
      )
    ).toEqual(["2 variantes sem saldo", "3 sem custo"]);
  });

  it("leaves out what is zero, and gives the noun to the one that stays", () => {
    expect(
      stockAttentionLinks({ unknownCost: page(2), withoutStock: page(0) }).map(
        (link) => link.text
      )
    ).toEqual(["2 variantes sem custo"]);
    expect(
      stockAttentionLinks({ unknownCost: page(0), withoutStock: page(1) }).map(
        (link) => link.text
      )
    ).toEqual(["1 variante sem saldo"]);
  });

  it("is empty with nothing to do, so the strip does not show", () => {
    expect(
      stockAttentionLinks({ unknownCost: page(0), withoutStock: page(0) })
    ).toEqual([]);
  });

  it("says '100 ou mais' when the page was full", () => {
    expect(
      stockAttentionLinks({
        unknownCost: page(100, true),
        withoutStock: page(100, true),
      }).map((link) => link.text)
    ).toEqual(["100 ou mais variantes sem saldo", "100 ou mais sem custo"]);
  });

  it("opens the filters the link of the Início opens", () => {
    for (const link of stockAttentionLinks({
      unknownCost: page(1),
      withoutStock: page(1),
    })) {
      const filters = readStockLinkFilters(
        new URL(link.href, "http://x").search
      );
      expect(filters).toEqual(
        link.id === "without-stock"
          ? { stock: "without_stock", unknownCost: false }
          : { stock: "all", unknownCost: true }
      );
    }
  });
});

describe("stockAttentionRequest and variantCount", () => {
  it("reads a page of active products, by balance or by cost", () => {
    expect(stockAttentionRequest(organizationId, "without-stock")).toEqual({
      limit: 100,
      organizationId,
      productStatus: "active",
      stock: "without_stock",
    });
    expect(stockAttentionRequest(organizationId, "unknown-cost")).toEqual({
      cost: "unknown",
      limit: 100,
      organizationId,
      productStatus: "active",
    });
  });

  it("counts the entries and whether there is another page", () => {
    expect(
      variantCount({ entries: [entry(1), entry(2)], nextCursor: null })
    ).toEqual(page(2));
    expect(variantCount({ entries: [entry(1)], nextCursor: "c" })).toEqual(
      page(1, true)
    );
  });
});
