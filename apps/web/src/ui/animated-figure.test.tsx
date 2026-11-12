import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MotionLevel } from "@/lib/motion-level";
import {
  AnimatedFigure,
  ENTRANCE,
  type FigureState,
  nextFigureState,
} from "./animated-figure";

const harness = vi.hoisted(() => ({
  applied: 0,
  level: "full" as MotionLevel,
  seed: null as FigureState | null,
}));

vi.mock("@/lib/motion-level", () => ({
  useMotionLevel: () => harness.level,
}));

/**
 * A string render cannot update props, so the state the component had "before" is seeded at its first `useState`: the
 * render then sees a `text` different from the one it drew last, exactly as after a re-render with a new value, and
 * the update it makes during that render is the one that reaches the markup.
 */
vi.mock("react", async (importOriginal) => {
  const original = await importOriginal<typeof import("react")>();
  const useState = ((initial: unknown) => {
    const seeded =
      harness.seed !== null &&
      typeof initial === "object" &&
      initial !== null &&
      "generation" in initial;
    harness.applied += seeded ? 1 : 0;
    return original.useState(seeded ? harness.seed : initial);
  }) as typeof original.useState;
  return { ...original, default: { ...original, useState }, useState };
});

afterEach(() => {
  expect(harness.applied > 0).toBe(harness.seed !== null);
  harness.applied = 0;
  harness.level = "full";
  harness.seed = null;
});

const drawn = (text: string, generation = 0): FigureState => ({
  animate: false,
  generation,
  reading: false,
  text,
});

const figure = (text: string) =>
  renderToStaticMarkup(
    <AnimatedFigure text={text}>
      <span>{text}</span>
    </AnimatedFigure>
  );

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

describe("AnimatedFigure e o nível de movimento do aparelho", () => {
  it("em full, trocar o text liga data-figure-changed e a entrada", () => {
    harness.level = "full";
    harness.seed = drawn("R$ 10,00");
    const markup = figure("R$ 20,00");
    expect(markup).toContain("data-figure-changed");
    expect(markup).toContain("animate-in");
    expect(markup).toContain("R$ 20,00");
  });

  it.each(["essential", "none"] as const)(
    "no nível %s, trocar o text não liga data-figure-changed nem a entrada, e o texto novo aparece",
    (level) => {
      harness.level = level;
      harness.seed = drawn("R$ 10,00");
      const markup = figure("R$ 20,00");
      expect(markup).not.toContain("data-figure-changed");
      expect(markup).not.toContain("animate-in");
      expect(markup).toContain("R$ 20,00");
    }
  );

  it("sair de full com a entrada ligada desliga data-figure-changed sem trocar o texto", () => {
    harness.seed = { ...drawn("R$ 20,00", 1), animate: true };
    harness.level = "full";
    expect(figure("R$ 20,00")).toContain("data-figure-changed");
    for (const level of ["essential", "none"] as const) {
      harness.level = level;
      const markup = figure("R$ 20,00");
      expect(markup).not.toContain("data-figure-changed");
      expect(markup).toContain("R$ 20,00");
    }
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
