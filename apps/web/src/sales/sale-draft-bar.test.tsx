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

const NEW_DAY =
  "Esta venda começou ontem. Ela será registrada com a data de hoje.";

const render = (newDayNotice: string | null = null) =>
  renderToStaticMarkup(
    <SaleDraftBar
      canClear
      count={{ lines: 1, units: 1 }}
      newDayNotice={newDayNotice}
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

  it("puts the new-day sentence in the live region as plain text, without the warning alert", () => {
    const html = render(NEW_DAY);
    expect(html).toContain(NEW_DAY);
    expect(html).toContain(`text-support">${NEW_DAY}</p>`);
    expect(html.indexOf('aria-live="polite"')).toBeLessThan(
      html.indexOf(NEW_DAY)
    );
    expect(html.match(/role="alert"/g)?.length ?? 0).toBe(
      render().match(/role="alert"/g)?.length ?? 0
    );
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
