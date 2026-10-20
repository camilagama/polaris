import type { InventoryBalanceEntryReadModel } from "@polaris/contracts";
import { describe, expect, it } from "vitest";
import {
  canLoadMoreStock,
  defaultStockFilters,
  initialStockListState,
  STOCK_PAGE_SIZE,
  stockBalanceUpdated,
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
  stockRows,
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
        { includeArchived: true, query: "  azul ", stock: "with_stock" },
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
  it("shows product, variant, SKU, quantity, average cost and last update", () => {
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
    expect(row?.updatedText).not.toBe("Sem movimentos");
  });

  it("never turns an unknown cost into zero", () => {
    const [row] = stockRows([entry(1, { movingAverageCost: null })]);
    expect(row?.costText).toBe("Custo desconhecido");
    expect(row?.costUnknown).toBe(true);
  });

  it("marks a variant without movements and one without balance", () => {
    const [row] = stockRows([
      entry(1, { movingAverageCost: null, quantity: 0, updatedAt: null }),
    ]);
    expect(row).toMatchObject({
      tone: "empty",
      updatedText: "Sem movimentos",
    });
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
    expect(stockCountText(withMore)).toBe("1 variante carregada; há mais");
  });
});
