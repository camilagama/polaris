// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NearLimitNotice } from "./limit-help";
import type { NearLimitView } from "./limit-help-model";

vi.mock("../lib/orpc", () => ({ orpcClient: {} }));

const FREEABLE_TEXT = "Você tem 3 produtos arquivados sem estoque.";

const withFreeable: NearLimitView = {
  freeableProducts: 3,
  kind: "near",
  proMax: null,
  usage: { max: 50, subject: "images", used: 47 },
};

function mount(view: NearLimitView | null, holdSpace: boolean) {
  const notice = (next: NearLimitView | null, hold: boolean) => (
    <NearLimitNotice freeable="link" holdSpace={hold} view={next} />
  );
  const mounted = render(notice(view, holdSpace));
  return {
    draw: (next: NearLimitView | null, hold: boolean) => {
      mounted.rerender(notice(next, hold));
      return {
        markup: mounted.container.innerHTML,
        notice: mounted.container.firstElementChild,
      };
    },
    first: {
      markup: mounted.container.innerHTML,
      notice: mounted.container.firstElementChild,
    },
  };
}

afterEach(cleanup);

describe("o segundo parágrafo fora do vão do holdSpace", () => {
  it("com a view à mostra o parágrafo dos arquivados aparece; sem conexão a linha do Pro fica invisível e o parágrafo sai", () => {
    const screen = mount(withFreeable, true);
    expect(screen.first.markup).toContain(FREEABLE_TEXT);
    expect(screen.first.markup).toContain("data-near-limit-freeable");

    const held = screen.draw(null, true);
    expect(held.notice).not.toBeNull();
    expect(held.markup).not.toContain(FREEABLE_TEXT);
    expect(held.markup).not.toContain("Ver arquivados");
    expect(held.markup).toContain('aria-hidden="true"');
    expect(held.markup).toContain("invisible");
    expect(held.markup).toContain("Conhecer o Pro");
    expect(held.markup).not.toContain("data-near-limit=");
    expect(held.markup.match(/<p /g)).toHaveLength(1);
  });

  it("controle: com a view antes à mostra, sem holdSpace a view null não deixa nada, e o vão não volta depois", () => {
    const screen = mount(withFreeable, true);
    expect(screen.first.notice).not.toBeNull();
    expect(screen.draw(null, false).notice).toBeNull();
    expect(screen.draw(null, true).notice).toBeNull();
  });
});
