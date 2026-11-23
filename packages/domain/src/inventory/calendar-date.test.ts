import { describe, expect, it } from "vitest";
import { isValidCalendarDate } from "./calendar-date";

const MONTH_LENGTHS: Record<string, readonly number[]> = {
  "2024": [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31],
  "2026": [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31],
};

const pad = (value: number): string => String(value).padStart(2, "0");

describe("isValidCalendarDate", () => {
  describe.each(Object.entries(MONTH_LENGTHS))("ano %s", (year, lengths) => {
    it.each(lengths.map((length, index) => [index + 1, length] as const))(
      "mês %i: o dia %i é o último válido e o seguinte não",
      (month, length) => {
        expect(
          isValidCalendarDate(`${year}-${pad(month)}-${pad(length)}`)
        ).toBe(true);
        expect(
          isValidCalendarDate(`${year}-${pad(month)}-${pad(length + 1)}`)
        ).toBe(false);
        expect(isValidCalendarDate(`${year}-${pad(month)}-01`)).toBe(true);
      }
    );
  });

  it("fevereiro: 28 e 29 em 2026, 29 e 30 em 2024", () => {
    expect(isValidCalendarDate("2026-02-28")).toBe(true);
    expect(isValidCalendarDate("2026-02-29")).toBe(false);
    expect(isValidCalendarDate("2024-02-29")).toBe(true);
    expect(isValidCalendarDate("2024-02-30")).toBe(false);
  });

  it("século: divisível por 100 só é bissexto se divisível por 400", () => {
    expect(isValidCalendarDate("1900-02-29")).toBe(false);
    expect(isValidCalendarDate("2100-02-29")).toBe(false);
    expect(isValidCalendarDate("2000-02-29")).toBe(true);
    expect(isValidCalendarDate("2400-02-29")).toBe(true);
    expect(isValidCalendarDate("1900-02-28")).toBe(true);
  });

  it("limites do ano, do mês e do dia", () => {
    expect(isValidCalendarDate("0001-01-01")).toBe(true);
    expect(isValidCalendarDate("9999-12-31")).toBe(true);
    expect(isValidCalendarDate("0000-01-01")).toBe(false);
    expect(isValidCalendarDate("2026-00-10")).toBe(false);
    expect(isValidCalendarDate("2026-13-10")).toBe(false);
    expect(isValidCalendarDate("2026-01-00")).toBe(false);
  });

  it.each([
    ["mês sem zero", "2026-1-5"],
    ["dia sem zero", "2026-01-5"],
    ["ano de 2 dígitos", "26-01-05"],
    ["barras", "2026/01/05"],
    ["sem separador", "20260105"],
    ["com hora", "2026-01-05T00:00:00Z"],
    ["espaço antes", " 2026-01-05"],
    ["espaço depois", "2026-01-05 "],
    ["sinal de mais", "+2026-01-05"],
    ["vazio", ""],
    ["dígitos de largura total", "２０２６-01-05"],
  ])("recusa a forma errada: %s", (_label, value) => {
    expect(isValidCalendarDate(value)).toBe(false);
  });
});
