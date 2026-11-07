import { describe, expect, it } from "vitest";
import {
  keepForReturn,
  keptCount,
  leaveForReturn,
  subscribeKept,
  takeKept,
} from "./kept-for-return";

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

  it("conta o que espera voltar e avisa quem ouve: a troca de build espera a tela pegar o rascunho de volta", () => {
    let heard = 0;
    const stop = subscribeKept(() => {
      heard += 1;
    });
    expect(keptCount()).toBe(0);
    leaveForReturn();
    keepForReturn("products:o3", { name: "Bolsa" });
    expect(keptCount()).toBe(1);
    takeKept("products:o3");
    expect(keptCount()).toBe(0);
    stop();
    expect(heard).toBe(2);
  });
});
