import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AnimatedFigure, ENTRANCE, nextFigureState } from "./animated-figure";

describe("AnimatedFigure", () => {
  it("escreve o número final no primeiro quadro, sem entrada (nasce pronto)", () => {
    const markup = renderToStaticMarkup(
      <AnimatedFigure text="R$ 129,90">
        <span data-money="">R$ 129,90</span>
      </AnimatedFigure>
    );
    expect(markup).toContain('<span data-money="">R$ 129,90</span>');
    expect(markup).not.toContain("animate-in");
    expect(markup).not.toContain("data-figure-changed");
  });

  it("não tem contador de dígitos: nem pacote, nem casca, nem elemento do contador", () => {
    const markup = renderToStaticMarkup(
      <AnimatedFigure text="R$ 129,90">
        <span>R$ 129,90</span>
      </AnimatedFigure>
    );
    expect(markup).not.toContain("data-animated-figure");
    expect(markup).not.toContain("aria-hidden");
    expect(markup).not.toContain("<number-flow");
  });
});

describe("nextFigureState", () => {
  const start = {
    animate: false,
    generation: 0,
    reading: false,
    text: "R$ 10,00",
  };

  it("o primeiro texto não anima e o mesmo texto devolve o mesmo estado (sem remontar)", () => {
    expect(nextFigureState(start, "R$ 10,00", false, false, true)).toBe(start);
  });

  it("um valor novo começa uma entrada nova, e outro depois começa outra", () => {
    const first = nextFigureState(start, "R$ 20,00", false, false, true);
    expect(first).toEqual({
      animate: true,
      generation: 1,
      reading: false,
      text: "R$ 20,00",
    });
    expect(nextFigureState(first, "R$ 20,00", false, false, true)).toBe(first);
    expect(
      nextFigureState(first, "R$ 30,00", false, false, true).generation
    ).toBe(2);
  });

  it("uma troca com os valores escondidos não anima, nem quando eles voltam", () => {
    const quiet = nextFigureState(start, "R$ 20,00", true, false, true);
    expect(quiet.animate).toBe(false);
    expect(nextFigureState(quiet, "R$ 20,00", false, false, true)).toBe(quiet);
  });

  it("cada dia lido no minigráfico troca sem entrada, e a volta ao repouso também", () => {
    let state = start;
    for (const text of ["R$ 20,00", "R$ 30,00", "R$ 25,00"]) {
      state = nextFigureState(state, text, false, true, true);
      expect(state.animate).toBe(false);
    }
    const back = nextFigureState(state, "R$ 10,00", false, false, true);
    expect(back.animate).toBe(false);
    expect(back.reading).toBe(false);
    expect(nextFigureState(back, "R$ 40,00", false, false, true).animate).toBe(
      true
    );
  });

  it("uma leitura que termina no mesmo texto do repouso não deixa a próxima troca sem entrada", () => {
    const reading = nextFigureState(start, "R$ 10,00", false, true, true);
    expect(reading.generation).toBe(start.generation);
    const rest = nextFigureState(reading, "R$ 10,00", false, false, true);
    expect(rest.reading).toBe(false);
    expect(nextFigureState(rest, "R$ 40,00", false, false, true).animate).toBe(
      true
    );
  });

  it("uma troca com o movimento reduzido não anima, e chegar ao nível full sem trocar o valor não toca a entrada", () => {
    const quiet = nextFigureState(start, "R$ 20,00", false, false, false);
    expect(quiet.animate).toBe(false);
    expect(quiet.generation).toBe(1);
    const full = nextFigureState(quiet, "R$ 20,00", false, false, true);
    expect(full).toBe(quiet);
    expect(full.animate).toBe(false);
    expect(nextFigureState(full, "R$ 30,00", false, false, true).animate).toBe(
      true
    );
  });

  it("sair do nível full no meio da entrada a encerra, e voltar a full não a toca de novo", () => {
    const entering = nextFigureState(start, "R$ 20,00", false, false, true);
    expect(entering.animate).toBe(true);
    const cut = nextFigureState(entering, "R$ 20,00", false, false, false);
    expect(cut.animate).toBe(false);
    expect(cut.generation).toBe(entering.generation);
    expect(nextFigureState(cut, "R$ 20,00", false, false, true)).toBe(cut);
  });

  it("a entrada é um fade de 200 ms só sob motion-full, sem rolar dígito", () => {
    for (const token of [
      "motion-full:animate-in",
      "motion-full:fade-in-0",
      "motion-full:duration-200",
    ]) {
      expect(ENTRANCE.split(" ")).toContain(token);
    }
    expect(ENTRANCE.split(" ").every((t) => t.startsWith("motion-full:"))).toBe(
      true
    );
  });
});
