import { describe, expect, it } from "vitest";
import {
  BILLING_OFF_TEXT,
  BILLING_ON_TEXT,
  CLOSE_ALREADY_CLOSED_TEXT,
  CLOSE_FAILED_TEXT,
  CLOSE_FORBIDDEN_TEXT,
  CLOSE_MISMATCH_TEXT,
  CLOSE_NOT_ACTIVE_TEXT,
  CLOSE_SESSION_TEXT,
  CLOSE_UNCONFIRMED_TEXT,
  closeDialogTitle,
  closeGate,
  closeRefusal,
  closureWarnings,
  confirmationLabel,
  NAME_MISSING_TEXT,
  QUEUE_CHECKING_TEXT,
  QUEUE_UNREADABLE_TEXT,
  type QueueState,
  queueNotice,
} from "./closure-model";

const NAME = "Loja da Ana";
const EMPTY: QueueState = {
  counts: { pending: 0, rejected: 0, sending: 0 },
  kind: "counted",
};
const queueOf = (pending: number, sending = 0, rejected = 0): QueueState => ({
  counts: { pending, rejected, sending },
  kind: "counted",
});
const DATE =
  /\d{2}\/\d{2}|\d{4}|de (janeiro|fevereiro|março|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)/;
const TECHNICAL = /closure_|organization_|_mismatch|FORBIDDEN|CONFLICT/;

describe("the fixed warnings (AC-2)", () => {
  it("say what stops, the 30 and 90 days, the deletion, the fiscal records and the renewal, in that order", () => {
    expect(closureWarnings(false)).toEqual([
      "Vender, mexer no estoque e cadastrar param na hora. Os aparelhos perdem o acesso sem internet.",
      "Por 30 dias você pode desfazer o encerramento.",
      "Por 90 dias você ainda entra só para baixar seus dados: vendas, estoque, clientes, despesas, produtos e imagens.",
      "Depois de 90 dias, os dados da loja podem ser apagados e não dá para recuperar.",
      "Guardar os documentos fiscais é responsabilidade sua. Baixe seus dados antes.",
      BILLING_OFF_TEXT,
    ]);
  });

  it("follow the billing flag: on, the renewal is cancelled and the panel says when; off, it is not cancelled here", () => {
    expect(closureWarnings(true).at(-1)).toBe(
      "A renovação do plano é cancelada; o painel mostra quando foi confirmada."
    );
    expect(closureWarnings(true).at(-1)).toBe(BILLING_ON_TEXT);
    expect(closureWarnings(false).at(-1)).toBe(
      "A cobrança do plano não é cancelada por aqui. Cancele a renovação no provedor de pagamento."
    );
    expect(closureWarnings(true).slice(0, -1)).toEqual(
      closureWarnings(false).slice(0, -1)
    );
  });

  it("speak in days, never in dates: only the server knows them", () => {
    for (const flag of [true, false]) {
      for (const line of closureWarnings(flag)) {
        expect(line).not.toMatch(DATE);
      }
    }
  });

  it("name the store in the title and in the field", () => {
    expect(closeDialogTitle(NAME)).toBe("Encerrar a loja Loja da Ana");
    expect(confirmationLabel(NAME)).toBe(
      "Para confirmar, digite o nome da loja: Loja da Ana"
    );
  });
});

describe("the queue of this device (AC-3)", () => {
  it("with nothing kept, does not hold the closure and says nothing of this device", () => {
    expect(queueNotice(EMPTY)).toEqual({ blocks: false, lines: [] });
  });

  it("with one operation, says it in the singular and holds the closure", () => {
    expect(queueNotice(queueOf(1))).toEqual({
      blocks: true,
      lines: [
        "Este aparelho guarda 1 operação que ainda não foi enviada. Envie antes de encerrar.",
      ],
    });
  });

  it("with several, counts the ones waiting and being sent, and the refused ones apart", () => {
    expect(queueNotice(queueOf(2, 1, 2))).toEqual({
      blocks: true,
      lines: [
        "Este aparelho guarda 3 operações que ainda não foram enviadas. Envie antes de encerrar.",
        "Este aparelho tem 2 registros recusados. Resolva em Precisa de ação antes de encerrar.",
      ],
    });
    expect(queueNotice(queueOf(0, 0, 1)).lines).toEqual([
      "Este aparelho tem 1 registro recusado. Resolva em Precisa de ação antes de encerrar.",
    ]);
  });

  it("while it is still being read, or when it could not be, holds the closure", () => {
    expect(queueNotice({ kind: "unknown" })).toEqual({
      blocks: true,
      lines: [QUEUE_CHECKING_TEXT],
    });
    expect(queueNotice({ kind: "unreadable" })).toEqual({
      blocks: true,
      lines: [QUEUE_UNREADABLE_TEXT],
    });
  });
});

describe("the button Encerrar a loja (AC-1, AC-3, AC-4)", () => {
  const gate = (typed: string, queue: QueueState = EMPTY, online = true) =>
    closeGate({ online, queue, storeName: NAME, typed });

  it("is on only with the whole name, case and surrounding spaces aside", () => {
    expect(gate("Loja da Ana").enabled).toBe(true);
    expect(gate("  loja DA ana ").enabled).toBe(true);
    expect(gate("Loja  da   Ana").enabled).toBe(true);
    expect(gate("Loja da").enabled).toBe(false);
    expect(gate("Loja da Ana!").enabled).toBe(false);
    expect(gate("").enabled).toBe(false);
    expect(gate("Loja").reason).toBe("name");
    expect(NAME_MISSING_TEXT).toBe(
      "Digite o nome da loja como aparece acima para habilitar o botão."
    );
  });

  it("stays off with the name right while the queue holds anything, and says why", () => {
    for (const queue of [
      queueOf(1),
      queueOf(5),
      queueOf(0, 1),
      queueOf(0, 0, 1),
    ]) {
      const result = gate(NAME, queue);
      expect(result.enabled).toBe(false);
      expect(result.reason).toBe("queue");
    }
    expect(gate(NAME, { kind: "unknown" }).enabled).toBe(false);
    expect(gate(NAME, { kind: "unreadable" }).enabled).toBe(false);
  });

  it("is off offline, with the reason left to the notice of the connection", () => {
    expect(gate(NAME, EMPTY, false)).toEqual({
      enabled: false,
      reason: "connection",
    });
    expect(gate(NAME, EMPTY)).toEqual({ enabled: true, reason: null });
  });
});

describe("what a refused or unanswered closure says", () => {
  const error = (code: string, status: number, reason?: string) => ({
    code,
    data: reason === undefined ? undefined : { reason },
    status,
  });

  it("is in doubt with no answer, the cut of the platform or a 5xx, and points to the panel", () => {
    for (const failure of [
      new TypeError("Failed to fetch"),
      error("SERVICE_UNAVAILABLE", 503, "server_busy"),
      error("SERVICE_UNAVAILABLE", 503, "platform_cut"),
      error("INTERNAL_SERVER_ERROR", 500),
    ]) {
      expect(closeRefusal(failure)).toEqual({
        panelLink: true,
        text: CLOSE_UNCONFIRMED_TEXT,
      });
    }
  });

  it("has its own text for each refusal of the server, with no technical code", () => {
    const cases: [unknown, string, boolean][] = [
      [
        error("BAD_REQUEST", 400, "closure_confirmation_mismatch"),
        CLOSE_MISMATCH_TEXT,
        false,
      ],
      [
        error("CONFLICT", 409, "organization_not_active"),
        CLOSE_NOT_ACTIVE_TEXT,
        false,
      ],
      [
        error("FORBIDDEN", 403, "organization_closed"),
        CLOSE_ALREADY_CLOSED_TEXT,
        true,
      ],
      [error("FORBIDDEN", 403), CLOSE_FORBIDDEN_TEXT, false],
      [error("UNAUTHORIZED", 401), CLOSE_SESSION_TEXT, false],
      [error("BAD_REQUEST", 400), CLOSE_FAILED_TEXT, false],
    ];
    for (const [failure, text, panelLink] of cases) {
      expect(closeRefusal(failure)).toEqual({ panelLink, text });
      expect(text).not.toMatch(TECHNICAL);
    }
  });

  it("says the missing legal acceptance with the common text, not as no permission", () => {
    const refusal = closeRefusal({
      code: "FORBIDDEN",
      data: {
        pending: [{ document: "terms", version: 1 }],
        reason: "legal_acceptance_required",
      },
      status: 403,
    });
    expect(refusal.text).toBe(
      "Não foi feito: falta aceitar os Termos de Uso e a Política de Privacidade."
    );
  });
});
