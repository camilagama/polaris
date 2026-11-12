import { describe, expect, it } from "vitest";
import {
  readStockEntryRequest,
  stockEntryHref,
  withoutStockEntry,
} from "./stock-entry-link";

const MAX = 2_147_483_647;
const variantId = "0199c2d0-0000-7000-8000-000000000002";

describe("o endereço da entrada de estoque", () => {
  it("o link da venda leva à tela de Estoque com a variante e a origem", () => {
    expect(stockEntryHref(variantId)).toBe(
      `/inventory?entrada=${variantId}&de=venda`
    );
  });

  it("lê a variante do endereço e só aceita um id", () => {
    expect(readStockEntryRequest(`?entrada=${variantId}&de=venda`)).toEqual({
      quantity: 1,
      variantId,
    });
    expect(readStockEntryRequest("")).toBeNull();
    expect(readStockEntryRequest("?filtro=sem-saldo")).toBeNull();
    for (const value of ["", "abc", "../x", `${variantId}x`]) {
      expect(
        readStockEntryRequest(`?entrada=${encodeURIComponent(value)}`)
      ).toEqual({ quantity: 1, variantId: null });
    }
  });

  it("o link leva a quantidade que falta e só ela, inteira e dentro do limite", () => {
    expect(stockEntryHref(variantId, 2)).toBe(
      `/inventory?entrada=${variantId}&de=venda&quantidade=2`
    );
    for (const missing of [undefined, 0, -1, 2.5, Number.NaN, MAX + 1]) {
      expect(stockEntryHref(variantId, missing)).toBe(
        `/inventory?entrada=${variantId}&de=venda`
      );
    }
    expect(stockEntryHref(variantId, MAX)).toBe(
      `/inventory?entrada=${variantId}&de=venda&quantidade=${MAX}`
    );
  });

  it("lê a quantidade do endereço e abre com 1 quando falta, é zero, negativa, decimal, texto ou passa do limite", () => {
    const read = (quantity: string) =>
      readStockEntryRequest(
        `?entrada=${variantId}&quantidade=${encodeURIComponent(quantity)}`
      );
    expect(read("2")).toEqual({ quantity: 2, variantId });
    expect(read(String(MAX))).toEqual({ quantity: MAX, variantId });
    for (const value of [
      "",
      "0",
      "-3",
      "2.5",
      "2,5",
      "1e3",
      "0x10",
      "+2",
      "02",
      " 2",
      "dois",
      "NaN",
      "Infinity",
      String(MAX + 1),
      "99999999999999999999",
    ]) {
      expect(read(value)).toEqual({ quantity: 1, variantId });
    }
    expect(readStockEntryRequest(`?entrada=${variantId}`)).toEqual({
      quantity: 1,
      variantId,
    });
  });

  it("tira só os parâmetros da entrada e deixa o filtro", () => {
    expect(withoutStockEntry(`?entrada=${variantId}&de=venda`)).toBe("");
    expect(
      withoutStockEntry(`?entrada=${variantId}&de=venda&quantidade=2`)
    ).toBe("");
    expect(withoutStockEntry(`?filtro=sem-saldo&entrada=${variantId}`)).toBe(
      "?filtro=sem-saldo"
    );
  });
});
