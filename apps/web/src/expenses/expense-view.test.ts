import { describe, expect, it } from "vitest";
import { addressWithExpenseView, openedExpenseView } from "./expense-view";

describe("o segmento de Despesas no endereço (?ver=)", () => {
  it("sem ver, abre Lançamentos sem reescrever", () => {
    expect(openedExpenseView("?aba=despesas")).toEqual({
      rewrite: false,
      value: "lancamentos",
    });
  });

  it("abre Recorrentes e Categorias pelo nome", () => {
    expect(openedExpenseView("?aba=despesas&ver=recorrentes").value).toBe(
      "recorrentes"
    );
    expect(openedExpenseView("?aba=despesas&ver=categorias").value).toBe(
      "categorias"
    );
  });

  it("valor inválido cai em Lançamentos e pede reescrita", () => {
    for (const search of [
      "?aba=despesas&ver=xyz",
      "?aba=despesas&ver=",
      "?aba=despesas&ver=Recorrentes",
    ]) {
      expect(openedExpenseView(search)).toEqual({
        rewrite: true,
        value: "lancamentos",
      });
    }
  });

  it("Lançamentos explícito é válido e fica como está", () => {
    expect(openedExpenseView("?ver=lancamentos")).toEqual({
      rewrite: false,
      value: "lancamentos",
    });
  });

  it("reescreve só o ver: Lançamentos tira o parâmetro e os outros o escrevem", () => {
    expect(
      addressWithExpenseView("/dashboard?aba=despesas&ver=xyz", "lancamentos")
    ).toBe("/dashboard?aba=despesas");
    expect(
      addressWithExpenseView("/dashboard?aba=despesas#topo", "categorias")
    ).toBe("/dashboard?aba=despesas&ver=categorias#topo");
    expect(
      addressWithExpenseView(
        "https://app.exemplo/dashboard?aba=despesas&ver=categorias",
        "recorrentes"
      )
    ).toBe("/dashboard?aba=despesas&ver=recorrentes");
  });
});
