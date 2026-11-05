import type { InventoryBalanceEntryReadModel } from "@polaris/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  balanceOfEntry,
  chunkIds,
  coversOfStock,
  itemChangesForEntry,
  lineBalancesRequest,
  linesToReadForCover,
  rereadLinesForCover,
  PICKER_RESULT_LIMIT,
  pickerErrorMessage,
  pickerOptions,
  pickerView,
  stockAfterRefresh,
  variantSearchRequest,
} from "./sale-variant-picker-model";

const organizationId = "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0";

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
    variantId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    version: 2,
    ...overrides,
  };
}

describe("variantSearchRequest", () => {
  it("is one read of active products, limited, searched by the trimmed text", () => {
    expect(variantSearchRequest(organizationId, "  azul ")).toEqual({
      limit: PICKER_RESULT_LIMIT,
      organizationId,
      productStatus: "active",
      query: "azul",
      stock: "all",
    });
  });

  it("lists the first variants when nothing is typed", () => {
    expect(variantSearchRequest(organizationId, "   ")).not.toHaveProperty(
      "query"
    );
  });
});

describe("lineBalancesRequest and chunkIds", () => {
  it("re-reads exactly the lines' variants in one call", () => {
    const request = lineBalancesRequest(organizationId, ["a", "b"]);
    expect(request).toMatchObject({
      productStatus: "all",
      variantIds: ["a", "b"],
    });
  });

  it("splits long sales into reads of at most 100 variants", () => {
    const ids = Array.from({ length: 205 }, (_, n) => `v${n}`);
    expect(chunkIds(ids).map((chunk) => chunk.length)).toEqual([100, 100, 5]);
    expect(chunkIds([])).toEqual([]);
  });
});

describe("pickerOptions", () => {
  it("shows product, variant, SKU and balance, never the average cost", () => {
    const [option] = pickerOptions([entry(1)]);
    expect(option).toMatchObject({
      detail: "Saldo 3 · SKU CAM-AZ-M",
      label: "Camiseta Polaris · Azul / M",
      tone: "ok",
    });
  });

  it("flags a variant without balance", () => {
    const [empty, unknown] = pickerOptions([
      entry(1, { quantity: 0 }),
      entry(2, { movingAverageCost: null, sku: null }),
    ]);
    expect(empty).toMatchObject({ tone: "warning" });
    expect(empty?.detail).toBe("Sem saldo · SKU CAM-AZ-M");
    expect(unknown?.detail).toBe("Saldo 3");
  });

  it("labels a default variant with the product name alone", () => {
    const [option] = pickerOptions([
      entry(1, { isDefaultVariant: true, values: [] }),
    ]);
    expect(option?.label).toBe("Camiseta Polaris");
  });
});

describe("pickerView", () => {
  it("covers loading, error, empty and ready", () => {
    expect(pickerView({ status: "loading" }, "")).toMatchObject({
      kind: "loading",
    });
    expect(
      pickerView(
        { message: pickerErrorMessage({ code: "FORBIDDEN" }), status: "error" },
        ""
      )
    ).toMatchObject({
      kind: "error",
      message: expect.stringContaining("acesso"),
    });
    expect(
      pickerView({ status: "ready", value: { entries: [], more: false } }, "")
    ).toEqual({
      href: "/products?novo=1",
      kind: "empty",
      message: "Cadastre um produto para vender.",
    });
    expect(
      pickerView(
        { status: "ready", value: { entries: [], more: false } },
        " azul "
      )
    ).toEqual({
      // a search with no match is not a store without products: no way to the form of a new one
      href: null,
      kind: "empty",
      message:
        "Nenhuma variante encontrada para “azul”. Confira o nome, a variante ou o SKU.",
    });
  });

  it("announces the count and warns when the list is cut short", () => {
    const one = pickerView(
      { status: "ready", value: { entries: [entry(1)], more: false } },
      ""
    );
    expect(one).toMatchObject({ hint: null, status: "1 variante encontrada." });
    const many = pickerView(
      {
        status: "ready",
        value: { entries: [entry(1), entry(2)], more: true },
      },
      ""
    );
    expect(many).toMatchObject({
      hint: expect.stringContaining("Digite para refinar"),
      status: "2 variantes encontradas.",
    });
  });
});

describe("choosing a variant", () => {
  it("sets product, variant and label, and leaves prices and quantity alone", () => {
    const chosen = entry(7);
    expect(itemChangesForEntry(chosen)).toEqual({
      label: "Camiseta Polaris · Azul / M",
      productId: chosen.productId,
      variantId: chosen.variantId,
    });
  });

  it("seeds the line balance from the same read, so no extra call is needed", () => {
    expect(balanceOfEntry(entry(7, { quantity: 9, version: 4 }))).toEqual({
      movingAverageCost: "12.340000",
      quantity: 9,
      variantId: entry(7).variantId,
      version: 4,
    });
  });
});

describe("stockAfterRefresh", () => {
  it("applies new balances and warns about a variant that is gone", () => {
    const kept = entry(1);
    const gone = entry(2);
    const previous = {
      [kept.variantId]: {
        status: "ready" as const,
        value: balanceOfEntry(kept),
      },
      other: { status: "ready" as const, value: balanceOfEntry(entry(9)) },
    };
    const next = stockAfterRefresh(
      previous,
      [kept.variantId, gone.variantId],
      [entry(1, { quantity: 8 })]
    );
    expect(next[kept.variantId]).toMatchObject({
      status: "ready",
      value: { quantity: 8 },
    });
    expect(next[gone.variantId]).toMatchObject({
      message: expect.stringContaining("não aparece mais"),
      status: "error",
    });
    expect(next.other).toBe(previous.other);
  });
});

const COVER = "0199c2d0-0000-7000-8000-0000000000c1";

describe("a capa nos pedidos de saldo", () => {
  it("sem pedir a capa, os pedidos são exatamente os de antes, sem a chave", () => {
    expect(variantSearchRequest(organizationId, "  azul ")).toEqual({
      limit: PICKER_RESULT_LIMIT,
      organizationId,
      productStatus: "active",
      query: "azul",
      stock: "all",
    });
    expect(
      variantSearchRequest(organizationId, "azul", false)
    ).not.toHaveProperty("withCover");
    expect(lineBalancesRequest(organizationId, ["a"])).toEqual({
      limit: 100,
      organizationId,
      productStatus: "all",
      stock: "all",
      variantIds: ["a"],
    });
    expect(
      lineBalancesRequest(organizationId, ["a"], false)
    ).not.toHaveProperty("withCover");
  });

  it("pedindo a capa, acrescenta withCover true e mantém o resto", () => {
    expect(variantSearchRequest(organizationId, "azul", true)).toEqual({
      ...variantSearchRequest(organizationId, "azul"),
      withCover: true,
    });
    expect(lineBalancesRequest(organizationId, ["a", "b"], true)).toEqual({
      ...lineBalancesRequest(organizationId, ["a", "b"]),
      withCover: true,
    });
    expect(variantSearchRequest(organizationId, "  ", true)).not.toHaveProperty(
      "query"
    );
  });
});

describe("a capa no saldo da venda", () => {
  it("balanceOfEntry só leva a capa quando a leitura a trouxe, inclusive o null de produto sem imagem", () => {
    expect(balanceOfEntry(entry(1))).toEqual({
      movingAverageCost: "12.340000",
      quantity: 3,
      variantId: entry(1).variantId,
      version: 2,
    });
    expect(balanceOfEntry(entry(1))).not.toHaveProperty("coverAssetId");
    expect(balanceOfEntry(entry(1, { coverAssetId: COVER }))).toMatchObject({
      coverAssetId: COVER,
    });
    expect(balanceOfEntry(entry(1, { coverAssetId: null }))).toHaveProperty(
      "coverAssetId",
      null
    );
  });

  it("coversOfStock devolve variante para capa só das linhas prontas que a trazem", () => {
    const withCover = entry(1, { coverAssetId: COVER });
    const noImage = entry(2, { coverAssetId: null });
    const unknown = entry(3);
    const covers = coversOfStock({
      [withCover.variantId]: {
        status: "ready",
        value: balanceOfEntry(withCover),
      },
      [noImage.variantId]: { status: "ready", value: balanceOfEntry(noImage) },
      [unknown.variantId]: { status: "ready", value: balanceOfEntry(unknown) },
      loading: { status: "loading" },
    });
    expect(covers).toEqual({
      [withCover.variantId]: COVER,
      [noImage.variantId]: null,
    });
    expect(coversOfStock({})).toEqual({});
  });

  it("duas variantes do mesmo produto ficam com a mesma capa, a do produto", () => {
    const small = entry(1, { coverAssetId: COVER });
    const large = entry(2, { coverAssetId: COVER });
    const covers = coversOfStock({
      [small.variantId]: { status: "ready", value: balanceOfEntry(small) },
      [large.variantId]: { status: "ready", value: balanceOfEntry(large) },
    });
    expect(covers[small.variantId]).toBe(COVER);
    expect(covers[large.variantId]).toBe(COVER);
  });

  it("stockAfterRefresh leva a capa da nova leitura e, sem ela, não inventa uma nem apaga a que a linha já tinha em outra variante", () => {
    const kept = entry(1, { coverAssetId: COVER });
    const other = entry(2, { coverAssetId: COVER });
    const previous = {
      [kept.variantId]: {
        status: "ready" as const,
        value: balanceOfEntry(kept),
      },
      [other.variantId]: {
        status: "ready" as const,
        value: balanceOfEntry(other),
      },
    };
    const next = stockAfterRefresh(
      previous,
      [kept.variantId],
      [entry(1, { coverAssetId: null, quantity: 9 })]
    );
    expect(coversOfStock(next)).toEqual({
      [kept.variantId]: null,
      [other.variantId]: COVER,
    });
    const without = stockAfterRefresh(previous, [kept.variantId], [entry(1)]);
    expect(without[kept.variantId]).toMatchObject({ status: "ready" });
    expect(coversOfStock(without)[other.variantId]).toBe(COVER);
    expect(coversOfStock(without)).not.toHaveProperty(kept.variantId);
  });
});

describe("a capa das linhas abertas quando a chave muda", () => {
  const lines = [entry(1).variantId, entry(2).variantId];

  it("a chave que vira true com linhas abertas pede a releitura delas, e a capa aparece sem reabrir a Venda", () => {
    const before = stockAfterRefresh({}, lines, [entry(1), entry(2)]);
    expect(coversOfStock(before)).toEqual({});

    const ids = linesToReadForCover(false, true, lines);
    expect(ids).toEqual(lines);

    const after = stockAfterRefresh(before, ids, [
      entry(1, { coverAssetId: COVER }),
      entry(2, { coverAssetId: null }),
    ]);
    expect(coversOfStock(after)).toEqual({
      [lines[0] as string]: COVER,
      [lines[1] as string]: null,
    });
  });

  it("a chave igual, a primeira leitura da chave e a Venda sem linhas não pedem leitura", () => {
    expect(linesToReadForCover(true, true, lines)).toEqual([]);
    expect(linesToReadForCover(false, false, lines)).toEqual([]);
    expect(linesToReadForCover(null, true, lines)).toEqual([]);
    expect(linesToReadForCover(null, false, lines)).toEqual([]);
    expect(linesToReadForCover(false, true, [])).toEqual([]);
  });

  it("a chave que desliga também pede a leitura, para as linhas voltarem ao que a leitura sem capa dá", () => {
    expect(linesToReadForCover(true, false, lines)).toEqual(lines);
  });
});

describe("a releitura das linhas pela chave da capa", () => {
  const lines = [entry(1).variantId, entry(2).variantId];
  const base = { local: false, openVariantIds: lines };

  it("false → true lê as linhas abertas uma vez e guarda a chave nova; a mesma chave de novo não lê", () => {
    const read = vi.fn(() => Promise.resolve(null));
    const kept = rereadLinesForCover({
      ...base,
      read,
      seen: false,
      withCover: true,
    });
    expect(kept).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(lines);

    expect(
      rereadLinesForCover({ ...base, read, seen: kept, withCover: true })
    ).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("na montagem, com a chave desligada estável e no aparelho sem conexão, não lê", () => {
    const read = vi.fn(() => Promise.resolve(null));
    rereadLinesForCover({ ...base, read, seen: null, withCover: true });
    rereadLinesForCover({ ...base, read, seen: false, withCover: false });
    rereadLinesForCover({
      ...base,
      local: true,
      read,
      seen: false,
      withCover: true,
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("uma leitura que falha não vira rejeição solta", async () => {
    const read = vi.fn(() => Promise.reject(new Error("offline")));
    rereadLinesForCover({ ...base, read, seen: false, withCover: true });
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);
  });
});
