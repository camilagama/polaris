// @vitest-environment happy-dom
import { cleanup, render as renderInDom } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const render = (
  newDayNotice: string | null = null,
  notice: string | null = NOTICE
) =>
  renderToStaticMarkup(
    <SaleDraftBar
      canClear
      count={{ lines: 1, units: 1 }}
      newDayNotice={newDayNotice}
      notice={notice}
      onClear={clear}
      open={false}
    />
  );

const renderClient = (
  newDayNotice: string | null = null,
  notice: string | null = NOTICE
) =>
  renderInDom(
    <SaleDraftBar
      canClear
      count={{ lines: 1, units: 1 }}
      newDayNotice={newDayNotice}
      notice={notice}
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

  afterEach(cleanup);

  it("writes the notice as it is while the values show", () => {
    expect(textOf(render())).toBe(NOTICE);
  });

  it("leaves the live region empty on the first render, so the new-day sentence arrives as a change", () => {
    const html = render(NEW_DAY, null);
    expect(html).not.toContain(NEW_DAY);
    expect(html).toContain(
      '<div aria-live="polite" class="empty:absolute"></div>'
    );
  });

  it("puts the new-day sentence in the live region as plain text after the mount, without the warning alert", () => {
    const { container } = renderClient(NEW_DAY, null);
    const region = container.querySelector('[aria-live="polite"]');
    const sentence = region?.querySelector("p");
    expect(sentence?.textContent).toBe(NEW_DAY);
    expect(sentence?.className).toContain("text-support");
    expect(region?.querySelectorAll('[role="alert"]').length).toBe(0);
  });

  it("keeps the recovered-cart notice in the first render", () => {
    expect(render(NEW_DAY)).toContain("Camiseta do teste");
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
