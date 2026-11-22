import { describe, expect, it } from "vitest";
import {
  DATE_RANGE_SHORTCUTS,
  DEFAULT_SHORTCUTS,
  shortcutLabel,
  shortcutsOf,
} from "@/ui/date-range-shortcuts";
import {
  daysInRange,
  matchingPreset,
  presetRange,
  RANGE_PRESETS,
} from "@/ui/date-values";

const TODAY = "2026-10-24";

describe("a lista única de atalhos", () => {
  it("tem os seis atalhos, com o mesmo conjunto de valores do cálculo", () => {
    expect(DATE_RANGE_SHORTCUTS.map(({ label }) => label)).toEqual([
      "Hoje",
      "7 dias",
      "Este mês",
      "Mês passado",
      "Últimos 30 dias",
      "Este ano",
    ]);
    expect(DATE_RANGE_SHORTCUTS.map(({ value }) => value)).toEqual([
      ...RANGE_PRESETS,
    ]);
  });

  it("o padrão são os quatro de sempre do Histórico e das Metas", () => {
    expect(shortcutsOf(DEFAULT_SHORTCUTS).map(({ label }) => label)).toEqual([
      "Hoje",
      "7 dias",
      "Este mês",
      "Mês passado",
    ]);
  });

  it("a tela escolhe quais mostra e a ordem é a da lista", () => {
    expect(
      shortcutsOf(["este-ano", "mes-passado", "este-mes"]).map(
        ({ value }) => value
      )
    ).toEqual(["este-mes", "mes-passado", "este-ano"]);
    expect(shortcutLabel("30-dias")).toBe("Últimos 30 dias");
  });

  it("os dois novos contam do dia da loja: 30 dias e o ano até hoje", () => {
    expect(presetRange("30-dias", TODAY)).toEqual({
      from: "2026-09-25",
      to: TODAY,
    });
    expect(presetRange("este-ano", TODAY)).toEqual({
      from: "2026-01-01",
      to: TODAY,
    });
  });

  it("o atalho apertado é só entre os que a tela mostra", () => {
    const year = presetRange("este-ano", TODAY);
    expect(matchingPreset(year, TODAY)).toBe("este-ano");
    expect(matchingPreset(year, TODAY, DEFAULT_SHORTCUTS)).toBeUndefined();
  });
});

describe("o limite de dias do período", () => {
  it("conta as duas pontas, em qualquer ordem", () => {
    expect(daysInRange("2026-10-01", "2026-10-01")).toBe(1);
    expect(daysInRange("2026-10-31", "2026-10-01")).toBe(31);
    expect(daysInRange("2025-10-13", "2026-10-13")).toBe(366);
    expect(daysInRange("2025-10-12", "2026-10-13")).toBe(367);
  });
});
