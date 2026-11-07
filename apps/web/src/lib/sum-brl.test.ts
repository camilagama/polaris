import { describe, expect, it } from "vitest";
import { sumBrlAmounts } from "./sum-brl";

describe("sumBrlAmounts", () => {
  it("soma em centavos exatos, sem erro de ponto flutuante", () => {
    expect(sumBrlAmounts(["0.10", "0.20"])).toBe("0.30");
    expect(sumBrlAmounts(["219.90", "1234.50", "0.01"])).toBe("1454.41");
  });

  it("sem valores a soma é zero", () => {
    expect(sumBrlAmounts([])).toBe("0.00");
  });

  it("aceita valor sem casas e acima de um milhão", () => {
    expect(sumBrlAmounts(["1000000", "0.5"])).toBe("1000000.50");
  });

  it("um valor que não é BRL vira null, nunca um total errado", () => {
    expect(sumBrlAmounts(["10.00", "abc"])).toBeNull();
    expect(sumBrlAmounts(["10.001"])).toBeNull();
  });
});
