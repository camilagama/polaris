import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PendingSale } from "../offline/sale-confirm";
import {
  mergeSavedLines,
  type SavedSaleLine,
  SavedSaleRow,
  SavedSalesCard,
  savedSaleLines,
} from "./offline-sale-panels";
import type { QueuedSaleView } from "./sale-form-model";

const SHORT_DATE = /23\/10\/2026|23\/10\/26/;

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
    expect(html).toContain("Guardada");
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

const savedLine = (
  commandId: string,
  state: SavedSaleLine["state"],
  overrides: Partial<SavedSaleLine> = {}
): SavedSaleLine => ({
  commandId,
  itemCount: 2,
  justSaved: false,
  occurredAt: "2026-10-23T15:30:00.000Z",
  state,
  stockWarnings: [],
  totalText: "R$ 130,00",
  ...overrides,
});

function rowHtml(sale: SavedSaleLine): string {
  return renderToStaticMarkup(<SavedSaleRow line={sale} />);
}

describe("a fase de cada linha (AC-T6.3)", () => {
  const phases: [SavedSaleLine["state"], string][] = [
    ["pending", "Guardada"],
    ["syncing", "Enviando"],
    ["sent", "Enviada"],
    ["rejected", "Precisa de atenção"],
    ["needs_attention", "Precisa de atenção"],
  ];

  it.each(phases)("%s diz %s e mantém data, itens e valor", (state, words) => {
    const html = rowHtml(savedLine("a", state));
    expect(html).toContain(`>${words}</span>`);
    expect(html).toContain("2 itens");
    expect(html).toMatch(SHORT_DATE);
    expect(html).toContain("130,00");
    expect(html).not.toContain("Skeleton");
  });

  it("guardada e enviando não têm ação; enviada leva ao Histórico; recusada, a Pendências", () => {
    for (const state of ["pending", "syncing"] as const) {
      const html = rowHtml(savedLine("a", state));
      expect(html).not.toContain("<a ");
    }
    const sent = rowHtml(savedLine("a", "sent"));
    expect(sent).toContain('href="/sales/history"');
    expect(sent).toContain("Ver no Histórico");
    expect(sent).not.toContain("Pendências");
    for (const state of ["rejected", "needs_attention"] as const) {
      const html = rowHtml(savedLine("a", state));
      expect(html).toContain('href="/attention"');
      expect(html).toContain("Resolver em Pendências");
    }
  });

  it("valor indisponível aparece em todas as fases, nunca zero", () => {
    for (const [state] of phases) {
      const html = rowHtml(savedLine("a", state, { totalText: null }));
      expect(html).toContain("valor indisponível");
      expect(html).not.toContain("R$ 0,00");
    }
  });

  it("a linha tem a mesma caixa em toda fase: a altura mínima da linha da fase não muda", () => {
    for (const [state] of phases) {
      expect(rowHtml(savedLine("a", state))).toContain("min-h-6");
    }
  });
});

describe("mergeSavedLines: a fase muda, o lugar não", () => {
  it("a venda que sai da fila depois de guardada ou enviando vira enviada, no mesmo lugar e com os mesmos dados", () => {
    const before = [
      savedLine("a", "pending"),
      savedLine("b", "syncing"),
      savedLine("c", "pending"),
    ];
    const after = mergeSavedLines(before, [
      savedLine("a", "pending"),
      savedLine("c", "syncing"),
    ]);
    expect(after.map((l) => [l.commandId, l.state])).toEqual([
      ["a", "pending"],
      ["b", "sent"],
      ["c", "syncing"],
    ]);
    expect(after[1]).toMatchObject({
      itemCount: 2,
      occurredAt: "2026-10-23T15:30:00.000Z",
      totalText: "R$ 130,00",
    });
  });

  it("a enviada fica enquanto o cartão está aberto", () => {
    const sent = mergeSavedLines([savedLine("a", "syncing")], []);
    expect(mergeSavedLines(sent, [])).toEqual(sent);
    expect(sent[0]?.state).toBe("sent");
  });

  it("a recusada que sai da fila (resolvida em outro lugar) não vira enviada", () => {
    expect(mergeSavedLines([savedLine("a", "rejected")], [])).toEqual([]);
  });

  it("a venda nova guardada agora vai ao alto e a nova da fila ao fim; ler de novo não muda a ordem", () => {
    const before = [savedLine("a", "pending")];
    const next = mergeSavedLines(before, [
      savedLine("n", "pending", { justSaved: true }),
      savedLine("a", "pending"),
      savedLine("z", "pending"),
    ]);
    expect(next.map((l) => l.commandId)).toEqual(["n", "a", "z"]);
    expect(
      mergeSavedLines(next, [
        savedLine("a", "pending"),
        savedLine("z", "pending"),
        savedLine("n", "pending", { justSaved: true }),
      ]).map((l) => l.commandId)
    ).toEqual(["n", "a", "z"]);
  });

  it("a recém-guardada que o servidor levou perde o destaque e o aviso de estoque", () => {
    const [sent] = mergeSavedLines(
      [
        savedLine("n", "pending", {
          justSaved: true,
          stockWarnings: ["Camiseta"],
        }),
      ],
      []
    );
    expect(sent).toMatchObject({
      justSaved: false,
      state: "sent",
      stockWarnings: [],
    });
  });
});
