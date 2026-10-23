import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PendingSale } from "../offline/sale-confirm";
import { SavedSalesCard, savedSaleLines } from "./offline-sale-panels";
import type { QueuedSaleView } from "./sale-form-model";

const pending = (
  commandId: string,
  overrides: Partial<PendingSale> = {}
): PendingSale => ({
  code: null,
  commandId,
  itemCount: 2,
  occurredAt: "2026-10-23T15:30:00.000Z",
  state: "pending",
  totalDue: "130.00",
  ...overrides,
});

const justSaved: QueuedSaleView = {
  commandId: "b",
  stockWarnings: [],
  totalDue: "R$ 45,00",
};

describe("savedSaleLines (P-3)", () => {
  it("sem venda recém-guardada, lista as da fila na ordem da fila, com o valor formatado", () => {
    const lines = savedSaleLines(
      [pending("a"), pending("c", { totalDue: "1234.50" })],
      null
    );
    expect(lines.map((line) => line.commandId)).toEqual(["a", "c"]);
    expect(lines.map((line) => line.totalText)).toEqual([
      "R$ 130,00",
      "R$ 1.234,50",
    ]);
    expect(lines.some((line) => line.justSaved)).toBe(false);
  });

  it("a venda recém-guardada vem primeiro, destacada, e não aparece duas vezes", () => {
    const lines = savedSaleLines(
      [pending("a"), pending("b", { itemCount: 1, totalDue: "45.00" })],
      { ...justSaved, stockWarnings: ["Camiseta: o aparelho mostra 1."] }
    );
    expect(lines.map((line) => line.commandId)).toEqual(["b", "a"]);
    expect(lines[0]).toMatchObject({
      itemCount: 1,
      justSaved: true,
      stockWarnings: ["Camiseta: o aparelho mostra 1."],
      totalText: "R$ 45,00",
    });
    expect(lines[1]?.justSaved).toBe(false);
  });

  it("antes de a fila ser lida de novo, a recém-guardada aparece só com o que o formulário sabe", () => {
    const lines = savedSaleLines([pending("a")], justSaved);
    expect(lines[0]).toMatchObject({
      commandId: "b",
      itemCount: null,
      justSaved: true,
      occurredAt: null,
      state: "pending",
      totalText: "R$ 45,00",
    });
    expect(lines).toHaveLength(2);
  });

  it("uma venda que o aparelho não sabe calcular fica sem valor, nunca com zero", () => {
    const [line] = savedSaleLines([pending("a", { totalDue: null })], null);
    expect(line?.totalText).toBeNull();
  });
});

describe("SavedSalesCard", () => {
  it("é um cartão só, com o título único, o status da venda guardada, o valor e os textos de apoio uma vez", () => {
    const html = renderToStaticMarkup(
      <SavedSalesCard justSaved={justSaved} workspace={null} />
    );
    expect(html).toContain("Vendas guardadas neste aparelho");
    expect(html).not.toContain("aguardando o servidor");
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html).toContain("Venda guardada neste aparelho.");
    expect(html).toContain("45,00");
    expect(html).toContain("Aguardando envio");
    expect(html.match(/Acompanhar em Pendências/g)).toHaveLength(1);
    expect(html.match(/O formulário abaixo foi reiniciado/g)).toHaveLength(1);
    expect(html.match(/Só viram vendas confirmadas/g)).toHaveLength(1);
  });

  it("sem nenhuma venda guardada não desenha nada", () => {
    expect(renderToStaticMarkup(<SavedSalesCard workspace={null} />)).toBe("");
  });

  it("o aviso de estoque do aparelho fica dentro da linha da venda guardada", () => {
    const html = renderToStaticMarkup(
      <SavedSalesCard
        justSaved={{
          ...justSaved,
          stockWarnings: [
            "Camiseta: o aparelho mostra 5 em estoque e a venda tem 9.",
          ],
        }}
        workspace={null}
      />
    );
    expect(html).toContain("o aparelho mostra 5 em estoque e a venda tem 9");
    expect(html).toContain("parece não cobrir este item");
  });
});
