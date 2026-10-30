import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AttentionBlock, AttentionNotes } from "./home-attention";
import type { Block } from "./use-home";

/** "Precisa de ação": só com item, e o que o conferir do estoque diz quando não há linha vai para uma linha discreta. */

type Stock = Block<{
  unknownCost: { count: number; more: boolean } | null;
  withoutStock: { count: number; more: boolean };
}>;

const ready = (cost: number, empty: number): Stock => ({
  data: {
    unknownCost: { count: cost, more: false },
    withoutStock: { count: empty, more: false },
  },
  status: "ready",
});

const block = (props: {
  refused?: number;
  soldWithoutCost?: number | null;
  stock: Stock;
}) =>
  renderToStaticMarkup(
    <AttentionBlock
      refused={props.refused ?? 0}
      soldWithoutCost={props.soldWithoutCost ?? null}
      stock={props.stock}
    />
  );

describe("Precisa de ação", () => {
  it("não aparece sem item, nem para dizer que não há nada a fazer", () => {
    expect(block({ stock: ready(0, 0) })).toBe("");
    expect(block({ stock: { status: "hidden" } })).toBe("");
    expect(block({ stock: { status: "loading" } })).toBe("");
  });

  it("tem o triângulo de aviso no título e o nome 'Precisa de ação'", () => {
    const markup = block({ refused: 1, stock: { status: "hidden" } });
    expect(markup).toContain("Precisa de ação");
    expect(markup).not.toContain("Precisa de atenção");
    expect(markup).toContain("text-warning");
    expect(markup).toContain('aria-labelledby="home-attention"');
  });

  it("o item de custo mantém a 2ª linha, e os outros não têm", () => {
    const markup = block({
      refused: 1,
      soldWithoutCost: 3,
      stock: ready(1, 3),
    });
    expect(markup).toContain("1 variante sem custo");
    expect(markup).toContain("Informe para as próximas vendas.");
    expect(markup).toContain("3 variantes sem saldo");
    expect(markup).toContain("1 registro recusado neste aparelho");
    // the other lines have no second line
    expect(markup).not.toContain("Dê entrada no estoque.");
    expect(markup).not.toContain("Corrija e envie de novo.");
    expect(markup.match(/text-muted-foreground text-xs/g)).toHaveLength(1);
  });

  it("no plural diz 'registros recusados'", () => {
    expect(block({ refused: 2, stock: { status: "hidden" } })).toContain(
      "2 registros recusados neste aparelho"
    );
  });
});

describe("a linha discreta do conferir do estoque", () => {
  const notes = (props: { offline?: boolean; stock: Stock }) =>
    renderToStaticMarkup(
      <AttentionNotes offline={props.offline ?? false} stock={props.stock} />
    );

  it("diz que está conferindo, sem conexão e que não deu", () => {
    expect(notes({ stock: { status: "loading" } })).toContain(
      "Conferindo o estoque…"
    );
    expect(notes({ offline: true, stock: { status: "hidden" } })).toContain(
      "Avisos do estoque só com conexão."
    );
    expect(
      notes({
        stock: { retryable: true, status: "error" } as Stock,
      })
    ).toContain("Avisos do estoque indisponíveis agora.");
  });

  it("não diz nada quando o estoque respondeu", () => {
    expect(notes({ stock: ready(0, 0) })).toBe("");
    expect(notes({ stock: ready(1, 1) })).toBe("");
  });
});
