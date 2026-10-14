import type { InventoryBalanceEntryReadModel } from "@polaris/contracts";
import { describe, expect, it } from "vitest";
import {
  balanceOfEntry,
  chunkIds,
  clearedItemChanges,
  itemChangesForEntry,
  lineBalancesRequest,
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
  it("shows product, variant, SKU, balance and average cost", () => {
    const [option] = pickerOptions([entry(1)]);
    expect(option).toMatchObject({
      detail: "Saldo 3 · SKU CAM-AZ-M · custo médio R$ 12,34",
      label: "Camiseta Polaris — Azul / M",
      tone: "ok",
    });
  });

  it("flags a variant without balance and never shows an unknown cost as zero", () => {
    const [empty, unknown] = pickerOptions([
      entry(1, { quantity: 0 }),
      entry(2, { movingAverageCost: null, sku: null }),
    ]);
    expect(empty).toMatchObject({ tone: "warning" });
    expect(empty?.detail).toContain("Sem saldo");
    expect(empty?.detail).not.toContain("custo");
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
    ).toMatchObject({
      kind: "empty",
      message: expect.stringContaining("Cadastre"),
    });
    expect(
      pickerView(
        { status: "ready", value: { entries: [], more: false } },
        " azul "
      )
    ).toMatchObject({
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
      label: "Camiseta Polaris — Azul / M",
      productId: chosen.productId,
      variantId: chosen.variantId,
    });
    expect(clearedItemChanges).toEqual({
      label: "",
      productId: "",
      variantId: "",
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
