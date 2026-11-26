import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PendingSale } from "../offline/sale-confirm";
import {
  SavedSaleRow,
  SavedSalesCard,
  savedSaleLines,
} from "./offline-sale-panels";
import type { QueuedSaleView } from "./sale-form-model";

const queue = vi.hoisted(() => ({ sales: [] as PendingSale[] }));

vi.mock("./pending-sales", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pending-sales")>()),
  usePendingSales: () => queue.sales,
}));

const pending = (
  commandId: string,
  overrides: Partial<PendingSale> = {}
): PendingSale => ({
  code: null,
  commandId,
  lineCount: 2,
  occurredAt: "2026-10-23T15:30:00.000Z",
  state: "pending",
  totalDue: "130.00",
  unitCount: 5,
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
      [
        pending("a"),
        pending("b", { lineCount: 1, totalDue: "45.00", unitCount: 1 }),
      ],
      { ...justSaved, stockWarnings: ["Camiseta: o aparelho mostra 1."] }
    );
    expect(lines.map((line) => line.commandId)).toEqual(["b", "a"]);
    expect(lines[0]).toMatchObject({
      count: { lines: 1, units: 1 },
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
      count: null,
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

  it("a linha da fila diz as linhas e as unidades, e o leitor ouve o mesmo", () => {
    const [line] = savedSaleLines(
      [pending("a", { lineCount: 3, unitCount: 8 })],
      null
    );
    expect(line?.count).toEqual({ lines: 3, units: 8 });
    const html = renderToStaticMarkup(
      <ul>{line ? <SavedSaleRow line={line} /> : null}</ul>
    );
    expect(html).toContain(
      '<span aria-hidden="true">3 linhas · 8 unidades</span>'
    );
    expect(html).toContain('<span class="sr-only">3 linhas, 8 unidades</span>');
    expect(html).not.toContain(" itens<");
    expect(html).not.toContain(" item<");
  });

  it("o mesmo cartão conta linhas e unidades na Venda e itens no Histórico", () => {
    queue.sales = [
      pending("a", { lineCount: 3, unitCount: 8 }),
      pending("b", { lineCount: 1, unitCount: 4 }),
    ];
    try {
      const sale = renderToStaticMarkup(<SavedSalesCard workspace={null} />);
      expect(sale).toContain("3 linhas · 8 unidades");
      expect(sale).toContain("1 linha · 4 unidades");
      expect(sale).toContain("3 linhas, 8 unidades");

      const history = renderToStaticMarkup(
        <SavedSalesCard countStyle="items" workspace={null} />
      );
      expect(history).toContain(" · 3 itens</span>");
      expect(history).toContain(" · 1 item</span>");
      expect(history).not.toContain("linha");
      expect(history).not.toContain("unidade");
      expect(history).not.toContain('sr-only">, ');
    } finally {
      queue.sales = [];
    }
  });

  it("a venda de 1 linha e 1 unidade fica no singular", () => {
    const [line] = savedSaleLines(
      [pending("a", { lineCount: 1, unitCount: 1 })],
      null
    );
    const html = renderToStaticMarkup(
      <ul>{line ? <SavedSaleRow line={line} /> : null}</ul>
    );
    expect(html).toContain("1 linha · 1 unidade");
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

describe("a venda dividida guardada no aparelho", () => {
  it("diz as partes na ordem, na Venda e no Histórico; a venda de um pagamento não ganha linha", () => {
    queue.sales = [
      pending("a", { partMethods: ["pix", "credit_card"] }),
      pending("b", { partMethods: null }),
    ];
    try {
      for (const html of [
        renderToStaticMarkup(<SavedSalesCard workspace={null} />),
        renderToStaticMarkup(
          <SavedSalesCard countStyle="items" workspace={null} />
        ),
      ]) {
        expect(html.match(/Pix \+ Crédito/g)).toHaveLength(1);
        expect(html).not.toContain("Dinheiro");
      }
      const lines = savedSaleLines(queue.sales, null);
      expect(lines.map((line) => line.partsText)).toEqual([
        "Pix + Crédito",
        null,
      ]);
    } finally {
      queue.sales = [];
    }
  });

  it("a recusada também diz as partes, ao lado do estado", () => {
    const [line] = savedSaleLines(
      [
        pending("a", {
          code: "payment_profile_changed",
          partMethods: ["cash", "debit_card"],
          state: "rejected",
        }),
      ],
      null
    );
    const html = renderToStaticMarkup(
      <ul>{line ? <SavedSaleRow line={line} /> : null}</ul>
    );
    expect(html).toContain("Dinheiro + Débito");
    expect(html).toContain("Recusada pelo servidor");
  });
});
