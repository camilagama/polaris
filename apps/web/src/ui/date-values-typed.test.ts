import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  INVERTED_TYPED_RANGE,
  maskTypedDate,
  parseTypedDate,
  typedProblems,
  typedRange,
  typedTextsOf,
} from "@/ui/date-values";

describe("maskTypedDate, o texto do campo a cada tecla", () => {
  it("põe as barras só quando o próximo dígito precisa delas", () => {
    expect(maskTypedDate("0")).toBe("0");
    expect(maskTypedDate("01")).toBe("01");
    expect(maskTypedDate("011")).toBe("01/1");
    expect(maskTypedDate("0110")).toBe("01/10");
    expect(maskTypedDate("01102")).toBe("01/10/2");
    expect(maskTypedDate("01102026")).toBe("01/10/2026");
  });

  it("deixa apagar a barra: o que sobra é o texto sem ela", () => {
    expect(maskTypedDate("01/")).toBe("01");
    expect(maskTypedDate("01/10/")).toBe("01/10");
  });

  it("ignora o que não é dígito e o que passa de oito", () => {
    expect(maskTypedDate("a1b0-1")).toBe("10/1");
    expect(maskTypedDate("01/10/2026999")).toBe("01/10/2026");
    expect(maskTypedDate("")).toBe("");
  });

  it("uma data colada como AAAA-MM-DD vira dd/mm/aaaa", () => {
    expect(maskTypedDate("2026-10-01")).toBe("01/10/2026");
    expect(maskTypedDate(" 2026-10-01 ")).toBe("01/10/2026");
  });
});

describe("parseTypedDate, o dia que o campo guarda", () => {
  it("lê dd/mm/aaaa como AAAA-MM-DD", () => {
    expect(parseTypedDate("01/10/2026")).toEqual({
      iso: "2026-10-01",
      ok: true,
    });
    expect(parseTypedDate("29/02/2028")).toEqual({
      iso: "2028-02-29",
      ok: true,
    });
  });

  it("vazio, incompleto e inexistente são motivos diferentes", () => {
    expect(parseTypedDate("")).toEqual({ ok: false, reason: "empty" });
    expect(parseTypedDate("  ")).toEqual({ ok: false, reason: "empty" });
    expect(parseTypedDate("01/10/20")).toEqual({
      ok: false,
      reason: "incomplete",
    });
    expect(parseTypedDate("1/10/2026")).toEqual({
      ok: false,
      reason: "incomplete",
    });
    expect(parseTypedDate("31/02/2026")).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(parseTypedDate("29/02/2026")).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(parseTypedDate("00/10/2026")).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(parseTypedDate("15/13/2026")).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("recusa ano fora de 2000 a 2099, que seria erro de digitação", () => {
    expect(parseTypedDate("01/10/0026")).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(parseTypedDate("01/10/1999")).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(parseTypedDate("01/10/2100")).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(parseTypedDate("31/12/2099").ok).toBe(true);
    expect(parseTypedDate("01/01/2000").ok).toBe(true);
  });
});

describe("typedProblems e typedRange, o período dos dois campos", () => {
  it("dois dias bons em ordem: sem problema e o período feito", () => {
    const texts = { from: "01/10/2026", to: "14/10/2026" };
    expect(typedProblems(texts)).toEqual({});
    expect(typedRange(texts)).toEqual({ from: "2026-10-01", to: "2026-10-14" });
  });

  it("um dia só vale: início igual ao fim", () => {
    expect(typedRange({ from: "14/10/2026", to: "14/10/2026" })).toEqual({
      from: "2026-10-14",
      to: "2026-10-14",
    });
  });

  it("cada campo diz o seu problema em palavras", () => {
    const problems = typedProblems({ from: "", to: "31/02/2026" });
    expect(problems.from).toBe("Digite a data de início, como 01/10/2026.");
    expect(problems.to).toBe("Essa data não existe. Confira dia, mês e ano.");
    expect(typedProblems({ from: "01/10/2026", to: "14/1" }).to).toContain(
      "Faltam números"
    );
    expect(typedRange({ from: "01/10/2026", to: "14/1" })).toBeNull();
  });

  it("período invertido não existe: a culpa é do fim", () => {
    const texts = { from: "14/10/2026", to: "01/10/2026" };
    expect(typedProblems(texts)).toEqual({ to: INVERTED_TYPED_RANGE });
    expect(INVERTED_TYPED_RANGE).toBe("A data final vem antes da inicial.");
    expect(typedRange(texts)).toBeNull();
  });

  it("o início inexistente não esconde o problema do fim, e o fim em ordem não vira erro", () => {
    const problems = typedProblems({ from: "31/02/2026", to: "01/10/2026" });
    expect(problems.from).toBeDefined();
    expect(problems.to).toBeUndefined();
  });
});

describe("typedTextsOf, o rascunho do calendário escrito nos campos", () => {
  it("período, só o início e nada", () => {
    expect(typedTextsOf({ from: "2026-10-01", to: "2026-10-14" })).toEqual({
      from: "01/10/2026",
      to: "14/10/2026",
    });
    expect(typedTextsOf({ from: "2026-10-01", to: undefined })).toEqual({
      from: "01/10/2026",
      to: "",
    });
    expect(typedTextsOf(undefined)).toEqual({ from: "", to: "" });
  });

  it("volta ao mesmo período pelo caminho de ida e volta", () => {
    const texts = typedTextsOf({ from: "2026-01-05", to: "2027-03-31" });
    expect(typedRange(texts)).toEqual({ from: "2026-01-05", to: "2027-03-31" });
  });
});

const NATIVE_DATE_FIELD = /type=["{]\s*["']?(date|month)/;
const COMMENT_LINE = /^\s*(\*|\/\/|\/\*)/;

describe("o painel do período não usa o campo de data do navegador", () => {
  it.each(["date-range-picker.tsx", "date-range-typing.tsx"])(
    "%s digita em texto com máscara, nunca type=date",
    (file) => {
      const code = readFileSync(new URL(file, import.meta.url), "utf8")
        .split("\n")
        .filter((line) => !COMMENT_LINE.test(line))
        .join("\n");
      expect(code).not.toMatch(NATIVE_DATE_FIELD);
    }
  );
});
