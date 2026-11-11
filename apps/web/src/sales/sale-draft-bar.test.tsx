import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ hidden: false }));

vi.mock("@/lib/hidden-values", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hidden-values")>()),
  useHiddenValues: () => [state.hidden, () => undefined],
}));

const { SaleDraftBar } = await import("./sale-draft-bar");

const NOTICE =
  "Camiseta do teste · Azul: preço de tabela atualizado para R$ 38,00; o preço cobrado continua R$ 45,50.";

const clear = () => undefined;

const render = () =>
  renderToStaticMarkup(
    <SaleDraftBar
      canClear
      itemCount={1}
      notice={NOTICE}
      onClear={clear}
      open={false}
    />
  );

const textOf = (markup: string) =>
  markup
    .split("<")
    .map((piece) => piece.slice(piece.indexOf(">") + 1))
    .join("");

describe("the notice of the cart that came back, with Esconder valores", () => {
  beforeEach(() => {
    state.hidden = false;
  });

  it("writes the notice as it is while the values show", () => {
    expect(textOf(render())).toBe(NOTICE);
  });

  it("masks each amount of the notice and keeps the words", () => {
    state.hidden = true;
    const html = render();
    expect(html).not.toContain("38,00");
    expect(html).not.toContain("45,50");
    expect(textOf(html)).toContain(
      "Camiseta do teste · Azul: preço de tabela atualizado para R$ ••••"
    );
    expect(textOf(html)).toContain("o preço cobrado continua R$ ••••");
  });
});
