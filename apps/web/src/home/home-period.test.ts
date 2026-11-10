import { describe, expect, it } from "vitest";
import {
  isThisMonth,
  OFFLINE_ONLY,
  selectionPeriod,
  THIS_MONTH,
  topProductsTitle,
} from "./home-period";

const TODAY = "2026-10-23";

describe("o período do Início", () => {
  it("começa em Este mês, que é a leitura da própria página", () => {
    expect(isThisMonth(THIS_MONTH)).toBe(true);
    expect(selectionPeriod(THIS_MONTH, TODAY)).toEqual({
      from: "2026-10-01",
      to: "2026-10-31",
    });
  });

  it("Mês passado é o mês inteiro anterior, e Este ano vai do 1º de janeiro a hoje", () => {
    expect(
      selectionPeriod({ custom: null, preset: "last-month" }, TODAY)
    ).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(selectionPeriod({ custom: null, preset: "year" }, TODAY)).toEqual({
      from: "2026-01-01",
      to: TODAY,
    });
    expect(isThisMonth({ custom: null, preset: "last-month" })).toBe(false);
  });

  it("um Período sem intervalo válido volta para Este mês, nunca para um intervalo vazio", () => {
    expect(selectionPeriod({ custom: null, preset: "custom" }, TODAY)).toEqual({
      from: "2026-10-01",
      to: "2026-10-31",
    });
    expect(
      selectionPeriod(
        { custom: { from: "2026-08-10", to: "2026-08-20" }, preset: "custom" },
        TODAY
      )
    ).toEqual({ from: "2026-08-10", to: "2026-08-20" });
  });

  it("o título de Mais vendidos diz o mês inteiro escolhido, e 'do período' quando não é um mês", () => {
    expect(
      topProductsTitle(THIS_MONTH, selectionPeriod(THIS_MONTH, TODAY))
    ).toBe("Mais vendidos do mês");
    const last = { custom: null, preset: "last-month" } as const;
    expect(topProductsTitle(last, selectionPeriod(last, TODAY))).toBe(
      "Mais vendidos de setembro"
    );
    const year = { custom: null, preset: "year" } as const;
    expect(topProductsTitle(year, selectionPeriod(year, TODAY))).toBe(
      "Mais vendidos do período"
    );
  });

  it("sem conexão só Este mês e Mês passado abrem, e a frase diz o porquê", () => {
    expect(OFFLINE_ONLY.shortcuts).toEqual(["este-mes", "mes-passado"]);
    expect(OFFLINE_ONLY.reason).toBe("Sem conexão: só este mês e o anterior.");
  });
});
