import { describe, expect, it } from "vitest";
import {
  type ClosedQueue,
  discardBody,
  discardOpen,
  discardTitle,
  kindOf,
  leftText,
  outcomeOf,
  queueView,
  windowText,
} from "./closed-queue-model";
import type { ClosedStore, ClosurePhase } from "./closed-store-model";
import { QUEUE_CHECKING_TEXT, QUEUE_UNREADABLE_TEXT } from "./closure-model";

const STORE: ClosedStore = {
  canRecover: false,
  deletableFrom: "2027-01-18T03:00:00.000Z",
  deletionDate: "2027-01-18",
  exportOpenUntil: "2027-01-18T03:00:00.000Z",
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  phase: "closed",
  recoverUntil: "2026-11-19T12:00:00.000Z",
  renewal: "not_handled",
  requestedAt: "2026-10-20T12:00:00.000Z",
  timezone: "America/Sao_Paulo",
};

const counted = (
  counts: { pending?: number; rejected?: number; sending?: number },
  kinds: { others?: number; registers?: number; sales?: number } = {}
): ClosedQueue => ({
  counts: { pending: 0, rejected: 0, sending: 0, ...counts },
  kind: "counted",
  kinds: { others: 0, registers: 0, sales: 0, ...kinds },
});

const EMPTY = counted({});

describe("quando o descarte abre (AC-1)", () => {
  const AFTER: ClosurePhase[] = [
    "closed",
    "deletion_scheduled",
    "deletable",
    "purged",
  ];

  it.each(AFTER)("na fase %s, com o desfazer encerrado, abre", (phase) => {
    expect(discardOpen({ ...STORE, canRecover: false, phase })).toBe(true);
  });

  it("na fase encerrando com o desfazer aberto não abre, com o relógio antes ou depois de recoverUntil", () => {
    for (const recoverUntil of [
      "2026-10-30T14:59:59.000Z",
      "2026-10-30T15:00:01.000Z",
    ]) {
      expect(
        discardOpen({
          ...STORE,
          canRecover: true,
          phase: "closing",
          recoverUntil,
        })
      ).toBe(false);
    }
  });

  it("só a palavra do servidor abre: canRecover verdadeiro fecha em qualquer fase", () => {
    for (const phase of [...AFTER, "closing"] as ClosurePhase[]) {
      expect(discardOpen({ ...STORE, canRecover: true, phase })).toBe(false);
    }
  });

  it("uma fase que o aparelho não conhece lê como a janela", () => {
    expect(
      discardOpen({ ...STORE, phase: "algo_novo" as unknown as ClosurePhase })
    ).toBe(false);
  });
});

describe("o que o cartão diz da fila (AC-1, AC-4)", () => {
  it("fila ainda lida ou ilegível: diz isso, nunca oferece o descarte nem diz que não há o que descartar", () => {
    for (const phase of ["closing", "closed", "purged"] as ClosurePhase[]) {
      const store = { ...STORE, canRecover: phase === "closing", phase };
      expect(queueView({ kind: "unknown" }, store)).toEqual({
        kind: "reading",
        text: QUEUE_CHECKING_TEXT,
      });
      expect(queueView({ kind: "unreadable" }, store)).toEqual({
        kind: "unreadable",
        text: QUEUE_UNREADABLE_TEXT,
      });
    }
  });

  it("fila lida e vazia: o cartão não aparece", () => {
    expect(queueView(EMPTY, STORE)).toEqual({ kind: "hidden" });
  });

  it("na janela: só a frase do desfazer, sem o descarte", () => {
    const view = queueView(counted({ pending: 2 }), {
      ...STORE,
      canRecover: true,
      phase: "closing",
    });
    expect(view).toEqual({ kind: "window", text: windowText(2) });
    expect(windowText(2)).toBe(
      "2 operações deste aparelho ainda não foram confirmadas pelo servidor. Se você desfizer o encerramento, elas serão enviadas de novo."
    );
    expect(windowText(1)).toBe(
      "1 operação deste aparelho ainda não foi confirmada pelo servidor. Se você desfizer o encerramento, ela será enviada de novo."
    );
  });

  it("depois da janela: a frase e o descarte, somando enviando, pendentes e recusadas", () => {
    const view = queueView(
      counted({ pending: 1, rejected: 2, sending: 1 }),
      STORE
    );
    expect(view).toMatchObject({ kind: "after", total: 4 });
    expect(view).toMatchObject({
      text: "4 operações deste aparelho ficaram sem confirmação do servidor e não serão mais enviadas: esta loja não volta. O que o servidor não confirmou não entra na cópia dos seus dados.",
    });
  });

  it("só recusadas também contam, e uma só vai no singular", () => {
    expect(queueView(counted({ rejected: 1 }), STORE)).toMatchObject({
      kind: "after",
      text: "1 operação deste aparelho ficou sem confirmação do servidor e não será mais enviada: esta loja não volta. O que o servidor não confirmou não entra na cópia dos seus dados.",
      total: 1,
    });
  });
});

describe("o tipo da operação (AC-7)", () => {
  it("separa venda, cadastro e o resto", () => {
    expect(kindOf("sale.confirm")).toBe("sales");
    expect(kindOf("customer.create")).toBe("registers");
    expect(kindOf("customer.update")).toBe("registers");
    expect(kindOf("product.create")).toBe("registers");
    expect(kindOf("stock.receive")).toBe("others");
    expect(kindOf("algo.novo")).toBe("others");
  });

  it("fila de vendas diz vendas e a frase de vendas sem confirmação", () => {
    const text = discardBody({ others: 0, registers: 0, sales: 3 });
    expect(text).toContain(
      "O servidor não confirmou o que será descartado: vendas deste aparelho"
    );
    expect(text).toContain(
      "Vendas sem confirmação não estarão na cópia dos seus dados."
    );
    expect(text).toContain("Isso não tem volta.");
  });

  it("fila mista com venda diz vendas e cadastros, e a frase da venda", () => {
    const text = discardBody({ others: 0, registers: 2, sales: 1 });
    expect(text).toContain("vendas e cadastros");
    expect(text).toContain(
      "Vendas sem confirmação não estarão na cópia dos seus dados."
    );
  });

  it("fila só de cadastros não fala de vendas", () => {
    const text = discardBody({ others: 0, registers: 2, sales: 0 });
    expect(text).toContain("descartado: cadastros deste aparelho");
    expect(text).not.toContain("venda");
    expect(text).toContain(
      "O que não foi confirmado não estará na cópia dos seus dados."
    );
  });

  it("sem tipo conhecido diz operações e a frase da cópia", () => {
    const text = discardBody({ others: 4, registers: 0, sales: 0 });
    expect(text).toContain("descartado: operações deste aparelho");
    expect(text).not.toContain("venda");
    expect(text).toContain("não estará na cópia dos seus dados");
  });

  it("três tipos juntos: vendas, cadastros e outras operações", () => {
    expect(discardBody({ others: 1, registers: 1, sales: 1 })).toContain(
      "vendas, cadastros e outras operações"
    );
  });

  it("o título diz quantas", () => {
    expect(discardTitle(1)).toBe("Descartar 1 operação deste aparelho?");
    expect(discardTitle(5)).toBe("Descartar 5 operações deste aparelho?");
  });
});

describe("o resultado é o que o disco diz (AC-5)", () => {
  it("só diz descartadas com a fila relida em 0", () => {
    expect(outcomeOf(EMPTY)).toEqual({ kind: "done" });
  });

  it("sobrou algo: diz quantas restam", () => {
    expect(outcomeOf(counted({ pending: 2, rejected: 1 }))).toEqual({
      kind: "left",
      remaining: 3,
    });
    expect(leftText(3)).toBe(
      "Não foi possível descartar tudo. Restaram 3 operações neste aparelho. Nada mais foi apagado."
    );
    expect(leftText(1)).toBe(
      "Não foi possível descartar tudo. Restou 1 operação neste aparelho. Nada mais foi apagado."
    );
  });

  it("releitura que falha ou não lê nunca afirma o sucesso", () => {
    expect(outcomeOf({ kind: "unknown" })).toEqual({ kind: "unread" });
    expect(outcomeOf({ kind: "unreadable" })).toEqual({ kind: "unread" });
  });
});
