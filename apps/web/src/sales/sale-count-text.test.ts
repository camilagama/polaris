import { describe, expect, it } from "vitest";
import { saleCountSpoken, saleCountText } from "./sale-count-text";

describe("as duas contagens da venda", () => {
  it("diz linhas e unidades, nunca só linhas", () => {
    expect(saleCountText({ lines: 3, units: 8 })).toBe("3 linhas · 8 unidades");
    expect(saleCountText({ lines: 1, units: 8 })).toBe("1 linha · 8 unidades");
    expect(saleCountText({ lines: 2, units: 2 })).not.toContain("iten");
  });

  it("separa os milhares como o resto da venda e usa o plural pelo número de verdade", () => {
    expect(saleCountText({ lines: 2, units: 12_345 })).toBe(
      "2 linhas · 12.345 unidades"
    );
    expect(saleCountSpoken({ lines: 1, units: 2_147_483_647 })).toBe(
      "1 linha, 2.147.483.647 unidades"
    );
  });

  it("usa o singular só quando o número é 1", () => {
    expect(saleCountText({ lines: 1, units: 1 })).toBe("1 linha · 1 unidade");
    expect(saleCountText({ lines: 2, units: 1 })).toBe("2 linhas · 1 unidade");
  });

  it("o leitor de tela ouve o mesmo com vírgula no lugar do ponto médio", () => {
    expect(saleCountSpoken({ lines: 3, units: 8 })).toBe(
      "3 linhas, 8 unidades"
    );
    expect(saleCountSpoken({ lines: 1, units: 1 })).toBe("1 linha, 1 unidade");
  });
});
