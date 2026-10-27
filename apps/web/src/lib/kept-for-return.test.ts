import { describe, expect, it } from "vitest";
import { keepForReturn, leaveForReturn, takeKept } from "./kept-for-return";

describe("o rascunho guardado para o voltar do 'Conhecer o Pro' (corte 1.6, AC-7)", () => {
  it("só a tela que sai pelo 'Conhecer o Pro' guarda, e o que guardou volta uma vez", () => {
    keepForReturn("products:o1", { name: "sem marca" });
    expect(takeKept("products:o1")).toBeUndefined();

    leaveForReturn();
    keepForReturn("products:o1", { name: "Bolsa" });
    // the mark is used once: a second screen that leaves afterwards keeps nothing
    keepForReturn("goals:o1", { target: "2.000,00" });
    expect(takeKept("goals:o1")).toBeUndefined();
    expect(takeKept("products:o1")).toEqual({ name: "Bolsa" });
    expect(takeKept("products:o1")).toBeUndefined();
  });

  it("a próxima tela que procura o que foi guardado gasta a marca, e nada guardado não é guardado", () => {
    leaveForReturn();
    expect(takeKept("goals:o1")).toBeUndefined();
    keepForReturn("goals:o1", { target: "1" });
    expect(takeKept("goals:o1")).toBeUndefined();

    leaveForReturn();
    keepForReturn("products:o2", null);
    expect(takeKept("products:o2")).toBeUndefined();
  });
});
