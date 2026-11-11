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
  const start = { animate: false, generation: 0, text: "R$ 10,00" };

  it("o primeiro texto não anima e o mesmo texto devolve o mesmo estado (sem remontar)", () => {
    expect(nextFigureState(start, "R$ 10,00", false)).toBe(start);
  });

  it("um valor novo começa uma entrada nova, e outro depois começa outra", () => {
    const first = nextFigureState(start, "R$ 20,00", false);
    expect(first).toEqual({ animate: true, generation: 1, text: "R$ 20,00" });
    expect(nextFigureState(first, "R$ 20,00", false)).toBe(first);
    expect(nextFigureState(first, "R$ 30,00", false).generation).toBe(2);
  });

  it("uma troca com os valores escondidos não anima, nem quando eles voltam", () => {
    const quiet = nextFigureState(start, "R$ 20,00", true);
    expect(quiet.animate).toBe(false);
    expect(nextFigureState(quiet, "R$ 20,00", false)).toBe(quiet);
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
