import { describe, expect, it } from "vitest";
import {
  readStockEntryRequest,
  stockEntryHref,
  withoutStockEntry,
} from "./stock-entry-link";

const variantId = "0199c2d0-0000-7000-8000-000000000002";

describe("o endereço da entrada de estoque", () => {
  it("o link da venda leva à tela de Estoque com a variante e a origem", () => {
    expect(stockEntryHref(variantId)).toBe(
      `/inventory?entrada=${variantId}&de=venda`
    );
  });

  it("lê a variante do endereço e só aceita um id", () => {
    expect(readStockEntryRequest(`?entrada=${variantId}&de=venda`)).toEqual({
      variantId,
    });
    expect(readStockEntryRequest("")).toBeNull();
    expect(readStockEntryRequest("?filtro=sem-saldo")).toBeNull();
    for (const value of ["", "abc", "../x", `${variantId}x`]) {
      expect(
        readStockEntryRequest(`?entrada=${encodeURIComponent(value)}`)
      ).toEqual({ variantId: null });
    }
  });

  it("tira só os parâmetros da entrada e deixa o filtro", () => {
    expect(withoutStockEntry(`?entrada=${variantId}&de=venda`)).toBe("");
    expect(withoutStockEntry(`?filtro=sem-saldo&entrada=${variantId}`)).toBe(
      "?filtro=sem-saldo"
    );
  });
});
