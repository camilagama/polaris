import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AnimatedFigure, parseFigure } from "./animated-figure";

describe("parseFigure", () => {
  it.each([
    ["R$ 129,90", { signed: false, value: 129.9 }],
    ["-R$ 99.640,35", { signed: false, value: -99_640.35 }],
    ["+R$ 436,86", { signed: true, value: 436.86 }],
    ["−R$ 12,50", { signed: false, value: -12.5 }],
  ])("%s", (text, figure) => {
    expect(parseFigure(text)).toEqual(figure);
  });

  it.each([
    "",
    "—",
    "R$ ••••",
    "sem valor",
    "R$ 12",
    "12 vendas",
    "R$ 1,5",
    "41,2%",
    "+30,0%",
  ])("%j não é um valor do cartão", (text) => {
    expect(parseFigure(text)).toBeNull();
  });
});

describe("AnimatedFigure sem janela", () => {
  it("escreve só o número estático, final, no primeiro quadro (o nível sem janela não anima)", () => {
    const markup = renderToStaticMarkup(
      <AnimatedFigure text="R$ 129,90">
        <span data-money="">R$ 129,90</span>
      </AnimatedFigure>
    );
    expect(markup).toBe('<span data-money="">R$ 129,90</span>');
    expect(markup).not.toContain("data-animated-figure");
  });
});
