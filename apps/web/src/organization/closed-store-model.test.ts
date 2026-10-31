import { describe, expect, it } from "vitest";
import { FRESH_SESSION_TEXT } from "../data-export/data-export-model";
import { NoWorkerAnswerError } from "../lib/connection";
import {
  type ClosedStore,
  type ClosurePhase,
  closedExportFileHref,
  closedRequestRefusal,
  closedStoreExports,
  copyClosedText,
  copyRequestOpen,
  DEVICE_CLOSED_LINK,
  deviceClosedText,
  focusTitleAfterRetry,
  justClosedText,
  loadAfterFailure,
  loadWhenReading,
  notRecoverableOutcome,
  PANEL_REFRESH_FAILED_TEXT,
  type PanelLoad,
  panelDates,
  panelLoadFailure,
  panelTitle,
  phaseLines,
  RENEWAL_UNKNOWN_TEXT,
  REOPENED_TEXT,
  renewalText,
  UNDO_ALREADY_REOPENED_TEXT,
  UNDO_CONFIRM,
  UNDO_EFFECTS_TEXT,
  UNDO_FRESH_SESSION_TEXT,
  UNDO_NOT_RECOVERABLE_UNKNOWN_TEXT,
  UNDO_OTHER_ACTIVE_TEXT,
  UNDO_REFUSED_TEXT,
  UNDO_TITLE,
  UNDO_UNKNOWN_TEXT,
  UNDO_WINDOW_OVER_TEXT,
  undoFailure,
  undoOpen,
  undoOutcomeUnknown,
} from "./closed-store-model";

const STORE: ClosedStore = {
  canRecover: true,
  deletableFrom: "2027-01-18T03:00:00.000Z",
  deletionDate: "2027-01-18",
  exportOpenUntil: "2027-01-18T03:00:00.000Z",
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja de Teste",
  phase: "closing",
  recoverUntil: "2026-11-19T12:00:00.000Z",
  renewal: "not_handled",
  requestedAt: "2026-10-20T12:00:00.000Z",
  timezone: "America/Sao_Paulo",
};

/** `2026-10-30T09:00` in São Paulo: 20 days to undo, 80 to D. */
const DURING_WINDOW = Date.parse("2026-10-30T12:00:00.000Z");
/** `2026-12-01T09:00` in São Paulo: the window is over, 48 days to D. */
const AFTER_WINDOW = Date.parse("2026-12-01T12:00:00.000Z");
/** `2027-01-12T09:00` in São Paulo: from D minus 7. */
const NEAR_D = Date.parse("2027-01-12T12:00:00.000Z");
const ONE_MS_BEFORE_D = Date.parse("2027-01-18T02:59:59.999Z");
const AT_D = Date.parse("2027-01-18T03:00:00.000Z");

const at = (phase: ClosurePhase, overrides: Partial<ClosedStore> = {}) => ({
  ...STORE,
  canRecover: phase === "closing",
  phase,
  ...overrides,
});

const SAYS_CANCELLED = /foi cancelada/;
const TECHNICAL =
  /closing|closed\b|deletion_scheduled|deletable|purged|not_handled|pending|cancelled|closure_|export_|_required|_unavailable/;

describe("the sentences of each phase (AC-6)", () => {
  it("closing: the request, the end of the undo with the days left, and D", () => {
    expect(phaseLines(at("closing"), DURING_WINDOW)).toEqual([
      "Você encerrou esta loja em 20 de outubro de 2026. Até 19 de novembro de 2026, às 09:00 (faltam 20 dias) você pode desfazer o encerramento. Depois disso não dá mais.",
      "Seus dados ficam guardados. A partir de 18 de janeiro de 2027 eles podem ser apagados. Baixe o que precisar antes dessa data.",
    ]);
  });

  it("closed: no more undo, and D with the days left", () => {
    expect(phaseLines(at("closed"), AFTER_WINDOW)).toEqual([
      "O prazo para desfazer acabou. Não dá mais para reabrir esta loja.",
      "A partir de 18 de janeiro de 2027 (faltam 48 dias) os dados podem ser apagados. Baixe o que precisar antes dessa data.",
    ]);
  });

  it("deletion scheduled: deleted soon, download now, and D with the days left", () => {
    expect(phaseLines(at("deletion_scheduled"), NEAR_D)).toEqual([
      "Os dados desta loja estão marcados para serem apagados em breve. Baixe agora o que precisar.",
      "A partir de 18 de janeiro de 2027 (faltam 6 dias) os dados podem ser apagados. Baixe o que precisar antes dessa data.",
    ]);
  });

  it("deletable: may be deleted at any moment, and the time for a copy is over", () => {
    expect(phaseLines(at("deletable"), AT_D)).toEqual([
      "Os dados desta loja podem ser apagados a qualquer momento a partir de 18 de janeiro de 2027.",
      "O prazo para pedir uma cópia dos dados terminou em 18 de janeiro de 2027, 00:00 (horário da sua loja). Depois de apagados, os dados não podem ser recuperados.",
    ]);
  });

  it("purged: deleted, nothing to recover or download", () => {
    expect(phaseLines(at("purged"), AT_D)).toEqual([
      "Os dados desta loja foram apagados. Não é possível recuperar nem baixar.",
    ]);
  });

  it("a store still `closing` past its window reads as closed, with no undo", () => {
    expect(phaseLines(at("closing"), AFTER_WINDOW)[0]).toBe(
      "O prazo para desfazer acabou. Não dá mais para reabrir esta loja."
    );
    expect(undoOpen(at("closing"), AFTER_WINDOW)).toBe(false);
  });

  it("`closing` that the server says cannot be undone, before the date, does not say the time is over nor count days", () => {
    const store = at("closing", { canRecover: false });
    expect(undoOpen(store, DURING_WINDOW)).toBe(false);
    expect(phaseLines(store, DURING_WINDOW)).toEqual([
      "A partir de 18 de janeiro de 2027 (faltam 80 dias) os dados podem ser apagados. Baixe o que precisar antes dessa data.",
    ]);
    expect(panelDates(store, DURING_WINDOW)[1]?.left).toBe("");
  });

  it("the same store past the date says the time is over, in the lines and in the dates", () => {
    const store = at("closing", { canRecover: false });
    expect(phaseLines(store, AFTER_WINDOW)[0]).toBe(
      "O prazo para desfazer acabou. Não dá mais para reabrir esta loja."
    );
    expect(panelDates(store, AFTER_WINDOW)[1]?.left).toBe("prazo encerrado");
  });

  it("names the store in the title and shows no technical code in any phase", () => {
    expect(panelTitle(STORE)).toBe("Loja de Teste está encerrada");
    for (const phase of [
      "closing",
      "closed",
      "deletion_scheduled",
      "deletable",
      "purged",
    ] as const) {
      for (const now of [DURING_WINDOW, AFTER_WINDOW, NEAR_D, AT_D]) {
        const text = [
          ...phaseLines(at(phase), now),
          ...panelDates(at(phase), now).flatMap((date) => [
            date.term,
            date.value,
            date.left,
          ]),
        ].join("\n");
        expect(text, `${phase} at ${now}`).not.toMatch(TECHNICAL);
      }
    }
  });
});

describe("the three dates and the days left (AC-5)", () => {
  it("always shows the request, the end of the undo and D, in the store's time zone", () => {
    expect(panelDates(at("closing"), DURING_WINDOW)).toEqual([
      { left: "", term: "Encerrada em", value: "20 de outubro de 2026" },
      {
        left: "faltam 20 dias",
        term: "Desfazer até",
        value: "19 de novembro de 2026, às 09:00",
      },
      {
        left: "faltam 80 dias",
        term: "Dados podem ser apagados a partir de",
        value: "18 de janeiro de 2027",
      },
    ]);
  });

  it("says a deadline that passed is over, and counts one day and the last day", () => {
    const dates = panelDates(at("deletion_scheduled"), ONE_MS_BEFORE_D);
    expect(dates[1]?.left).toBe("prazo encerrado");
    expect(dates[2]?.left).toBe("falta 1 dia");
    const lastDay = Date.parse("2026-11-19T11:00:00.000Z");
    expect(panelDates(at("closing"), lastDay)[1]?.left).toBe("termina hoje");
    expect(panelDates(at("deletable"), AT_D)[2]?.left).toBe(
      "já podem ser apagados"
    );
  });

  it("writes the dates of another time zone in its own calendar", () => {
    const manaus = at("closing", { timezone: "America/Manaus" });
    expect(panelDates(manaus, DURING_WINDOW)[1]?.value).toBe(
      "19 de novembro de 2026, às 08:00"
    );
  });

  it("is the same with or without a legal hold: only the server's phase and dates decide (AC-5)", () => {
    const withHold = { ...at("deletion_scheduled") };
    const withoutHold = { ...at("deletion_scheduled") };
    expect(phaseLines(withHold, NEAR_D)).toEqual(
      phaseLines(withoutHold, NEAR_D)
    );
  });
});

describe("the renewal (AC-18)", () => {
  it("has a sentence for each value the server sends, and says nothing but that it could not confirm with none", () => {
    expect(renewalText("not_handled")).toBe(
      "Cancele a renovação no provedor de pagamento."
    );
    expect(renewalText("pending")).toBe(
      "A renovação do plano está sendo cancelada."
    );
    expect(renewalText("cancelled")).toBe(
      "A renovação do plano foi cancelada."
    );
    expect(renewalText(null)).toBe(RENEWAL_UNKNOWN_TEXT);
  });

  it("never says cancelled without `cancelled`", () => {
    for (const renewal of ["not_handled", "pending", null] as const) {
      expect(renewalText(renewal)).not.toMatch(SAYS_CANCELLED);
    }
  });
});

describe("the copy of a closed store (AC-7)", () => {
  it("can be asked for up to the first instant of D and not from it", () => {
    expect(copyRequestOpen(at("deletion_scheduled"), ONE_MS_BEFORE_D)).toBe(
      true
    );
    expect(copyRequestOpen(at("deletion_scheduled"), AT_D)).toBe(false);
    expect(copyRequestOpen(at("deletable"), ONE_MS_BEFORE_D)).toBe(false);
    expect(copyRequestOpen(at("purged"), DURING_WINDOW)).toBe(false);
  });

  it("lists only the copies asked for after the closure, which its route downloads", () => {
    const base = {
      errorCode: null,
      expiresAt: null,
      files: [],
      formats: ["json"] as const,
      requestedAt: STORE.requestedAt,
      status: "requested" as const,
    };
    expect(
      closedStoreExports([
        { ...base, id: "a", mode: "active" },
        { ...base, id: "b", mode: "closed" },
      ])
    ).toEqual([{ ...base, id: "b" }]);
    expect(closedExportFileHref("b", 2)).toBe("/api/closed-exports/b/files/2");
  });

  it("explains the recent sign-in and the end of the time in its own words, and leaves the rest to the common texts", () => {
    const refusal = (reason: string, code = "FORBIDDEN") => ({
      code,
      data: { reason },
      status: code === "FORBIDDEN" ? 403 : 409,
    });
    expect(
      closedRequestRefusal(refusal("fresh_session_required"), STORE)
    ).toEqual({ repeatsNow: false, text: FRESH_SESSION_TEXT });
    expect(
      closedRequestRefusal(
        refusal("closed_export_unavailable", "CONFLICT"),
        STORE
      )
    ).toEqual({ repeatsNow: true, text: copyClosedText(STORE) });
    expect(
      closedRequestRefusal(refusal("export_limit_reached", "CONFLICT"), STORE)
    ).toBeNull();
    expect(FRESH_SESSION_TEXT).toContain("15 minutos");
  });
});

describe("the undo and the moment after the closure", () => {
  it("shows the undo only while closing, recoverable and before its end by the clock", () => {
    expect(undoOpen(at("closing"), DURING_WINDOW)).toBe(true);
    expect(undoOpen(at("closing"), Date.parse(STORE.recoverUntil) - 1)).toBe(
      true
    );
    expect(undoOpen(at("closing"), Date.parse(STORE.recoverUntil))).toBe(false);
    expect(undoOpen(at("closing", { canRecover: false }), DURING_WINDOW)).toBe(
      false
    );
    expect(undoOpen(at("closed"), DURING_WINDOW)).toBe(false);
  });

  it("says the store was closed, until when it can be undone, and that the data can be downloaded", () => {
    expect(justClosedText(STORE)).toBe(
      "Loja encerrada. Você pode desfazer até 19 de novembro de 2026, às 09:00. Seus dados ficam guardados e você pode baixá-los."
    );
  });

  it("takes a read with no session to the sign-in, and any other failure to the error", () => {
    expect(panelLoadFailure({ code: "UNAUTHORIZED", status: 401 })).toBe(
      "session"
    );
    expect(panelLoadFailure(new TypeError("Failed to fetch"))).toBe("error");
    expect(panelLoadFailure({ code: "FORBIDDEN", status: 403 })).toBe("error");
    expect(
      panelLoadFailure({
        code: "FORBIDDEN",
        data: {
          pending: [{ document: "terms", version: 1 }],
          reason: "legal_acceptance_required",
        },
        status: 403,
      })
    ).toBe("acceptance");
  });
});

describe("an Atualizar that fails (AC-4, AC-5)", () => {
  const loaded: PanelLoad = {
    refreshFailed: false,
    status: "loaded",
    stores: [STORE],
  };

  it("keeps the stores, and so the dates and the copy, and marks the failure", () => {
    expect(loadAfterFailure(loaded, "error")).toEqual({
      refreshFailed: true,
      status: "loaded",
      stores: [STORE],
    });
  });

  it("replaces the panel with the error only when nothing was read yet", () => {
    expect(loadAfterFailure({ status: "loading" }, "error")).toEqual({
      status: "error",
    });
    expect(loadAfterFailure({ status: "error" }, "error")).toEqual({
      status: "error",
    });
  });

  it("still takes a lost session or acceptance to its page, whatever was on screen", () => {
    expect(loadAfterFailure(loaded, "session")).toEqual({ status: "session" });
    expect(loadAfterFailure(loaded, "acceptance")).toEqual({
      status: "acceptance",
    });
  });

  it("keeps the stores and the notice while the next read is on its way", () => {
    const failed = loadAfterFailure(loaded, "error");
    expect(loadWhenReading(failed, 1)).toEqual(failed);
    expect(loadWhenReading(loaded, 0)).toEqual({ status: "loading" });
    expect(loadWhenReading({ status: "error" }, 1)).toEqual({
      status: "loading",
    });
  });

  it("takes the focus to the title only when a retry works and the focus fell to the page", () => {
    const failed = loadAfterFailure(loaded, "error");
    expect(focusTitleAfterRetry(failed, loaded, true)).toBe(true);
    expect(focusTitleAfterRetry(failed, loaded, false)).toBe(false);
    expect(focusTitleAfterRetry(failed, failed, true)).toBe(false);
    expect(focusTitleAfterRetry(loaded, loaded, true)).toBe(false);
    expect(focusTitleAfterRetry(failed, { status: "session" }, true)).toBe(
      false
    );
  });

  it("says only what is known: the screen is from the last read", () => {
    expect(PANEL_REFRESH_FAILED_TEXT).toBe(
      "Não deu para atualizar. O que está na tela é da última leitura."
    );
    expect(PANEL_REFRESH_FAILED_TEXT).not.toMatch(CLAIMS_STATE);
  });
});

const CLAIMS_STATE = /nada foi alterado|desfeito|encerramento/i;
const TECHNICAL_IN_UNDO = /_|organização|closure|FORBIDDEN|CONFLICT/;
const CLAIMS_AN_OUTCOME = /reaberta|não foi desfeito/i;
const refusal = (code: string, reason?: string, status = 409) => ({
  code,
  data: reason === undefined ? undefined : { reason },
  status,
});

describe("the answer of an undo (AC-8, AC-10)", () => {
  it("leaves the phase of closure_not_recoverable to a new read of the server", () => {
    expect(undoFailure(refusal("CONFLICT", "closure_not_recoverable"))).toEqual(
      { kind: "not_recoverable" }
    );
  });

  it("a store the server no longer lists as closed was reopened elsewhere", () => {
    expect(notRecoverableOutcome(null, DURING_WINDOW)).toEqual({
      kind: "reopened",
      store: null,
      text: UNDO_ALREADY_REOPENED_TEXT,
    });
    expect(UNDO_ALREADY_REOPENED_TEXT).toBe(
      "A loja já foi reaberta em outro aparelho."
    );
  });

  it("a read that confirms the closed store says the window is over and shows the server's store, without the undo", () => {
    const reread = at("closed", { canRecover: false });
    const outcome = notRecoverableOutcome(reread, AFTER_WINDOW);
    expect(outcome).toEqual({
      kind: "said",
      store: reread,
      text: UNDO_WINDOW_OVER_TEXT,
    });
    expect(undoOpen(reread, AFTER_WINDOW)).toBe(false);
    expect(panelDates(reread, AFTER_WINDOW)[1]?.left).toBe("prazo encerrado");
    expect(phaseLines(reread, AFTER_WINDOW)[0]).toBe(
      "O prazo para desfazer acabou. Não dá mais para reabrir esta loja."
    );
  });

  it("a read that still shows an open undo does not claim the window is over", () => {
    expect(notRecoverableOutcome(at("closing"), DURING_WINDOW)).toEqual({
      kind: "said",
      store: at("closing"),
      text: UNDO_REFUSED_TEXT,
    });
  });

  it("a failed read says it may be either, as a warning, with no store of its own", () => {
    expect(notRecoverableOutcome(undefined, DURING_WINDOW)).toEqual({
      kind: "said",
      store: null,
      text: UNDO_NOT_RECOVERABLE_UNKNOWN_TEXT,
    });
    expect(UNDO_NOT_RECOVERABLE_UNKNOWN_TEXT).toBe(
      "O prazo acabou ou a loja já foi reaberta. Toque em Atualizar para ver a situação da loja."
    );
    expect(undoOutcomeUnknown(UNDO_NOT_RECOVERABLE_UNKNOWN_TEXT)).toBe(true);
    expect(undoOutcomeUnknown(UNDO_UNKNOWN_TEXT)).toBe(true);
    expect(undoOutcomeUnknown(UNDO_WINDOW_OVER_TEXT)).toBe(false);
  });

  it("says why another active store blocks it (L6)", () => {
    expect(
      undoFailure(refusal("CONFLICT", "another_organization_active"))
    ).toEqual({ kind: "said", text: UNDO_OTHER_ACTIVE_TEXT });
  });

  it("never says reopened nor not undone when the answer may have come after the reopening", () => {
    for (const error of [
      new NoWorkerAnswerError("intercepted"),
      new TypeError("Failed to fetch"),
      refusal("SERVICE_UNAVAILABLE", undefined, 503),
      refusal("SERVICE_UNAVAILABLE", "server_busy", 503),
      refusal("INTERNAL_SERVER_ERROR", undefined, 500),
      refusal("TOO_MANY_REQUESTS", undefined, 429),
    ]) {
      expect(undoFailure(error)).toEqual({
        kind: "said",
        text: UNDO_UNKNOWN_TEXT,
      });
    }
    expect(UNDO_UNKNOWN_TEXT).not.toMatch(CLAIMS_AN_OUTCOME);
  });

  it("a definite refusal with no reason of its own says nothing was undone, without a code", () => {
    for (const error of [
      refusal("FORBIDDEN", undefined, 403),
      refusal("NOT_FOUND", undefined, 404),
      refusal("CONFLICT", "something_else"),
      refusal("BAD_REQUEST", undefined, 400),
    ]) {
      expect(undoFailure(error)).toEqual({
        kind: "said",
        text: UNDO_REFUSED_TEXT,
      });
    }
  });

  it("an entry older than 15 minutes says to sign in again and that nothing was changed", () => {
    expect(
      undoFailure(refusal("FORBIDDEN", "fresh_session_required", 403))
    ).toEqual({ kind: "said", text: UNDO_FRESH_SESSION_TEXT });
    expect(UNDO_FRESH_SESSION_TEXT).toBe(
      "Por segurança, para desfazer o encerramento é preciso ter entrado há menos de 15 minutos. Saia, entre de novo e desfaça o encerramento. Nada foi alterado."
    );
    expect(undoFailure(refusal("FORBIDDEN", "something_else", 403))).toEqual({
      kind: "said",
      text: UNDO_REFUSED_TEXT,
    });
  });

  it("sends a missing session or acceptance to its own screen", () => {
    expect(undoFailure(refusal("UNAUTHORIZED", undefined, 401))).toEqual({
      kind: "session",
    });
    expect(
      undoFailure(refusal("FORBIDDEN", "legal_acceptance_required", 403))
    ).toEqual({ kind: "acceptance" });
  });

  it("shows no technical code in any text of the undo", () => {
    for (const text of [
      UNDO_TITLE,
      UNDO_EFFECTS_TEXT,
      UNDO_CONFIRM,
      REOPENED_TEXT,
      UNDO_WINDOW_OVER_TEXT,
      UNDO_ALREADY_REOPENED_TEXT,
      UNDO_NOT_RECOVERABLE_UNKNOWN_TEXT,
      UNDO_OTHER_ACTIVE_TEXT,
      UNDO_REFUSED_TEXT,
      UNDO_UNKNOWN_TEXT,
    ]) {
      expect(text).not.toMatch(TECHNICAL_IN_UNDO);
    }
  });
});

describe("the device of a closed store (AC-11)", () => {
  it("says when the store was closed, in its time zone, and that the queue stays", () => {
    expect(deviceClosedText(STORE, true)).toBe(
      "Esta loja foi encerrada em 20 de outubro de 2026. A cópia deste aparelho foi apagada; o que não foi enviado continua guardado na fila."
    );
    expect(deviceClosedText(null, true)).toBe(
      "Esta loja foi encerrada. A cópia deste aparelho foi apagada; o que não foi enviado continua guardado na fila."
    );
  });

  it("after a first try of a sale refused, says it was not recorded and where the cart is, and never that the sale is in the queue", () => {
    const text = deviceClosedText(STORE, true, "not_recorded");
    expect(text).toBe(
      "Esta loja foi encerrada em 20 de outubro de 2026. A venda que você acabou de confirmar não foi registrada. A cópia deste aparelho foi apagada. O que já estava na fila continua guardado. O carrinho fica guardado aqui e volta em Vender se a loja reabrir. Se você fechar o Polaris, ele se perde."
    );
    expect(text).not.toContain("o que não foi enviado");
    expect(deviceClosedText(null, false, "not_recorded")).toBe(
      "Esta loja foi encerrada. A venda que você acabou de confirmar não foi registrada. O que já estava na fila deste aparelho continua guardado. O carrinho fica guardado aqui e volta em Vender se a loja reabrir. Se você fechar o Polaris, ele se perde."
    );
    expect(deviceClosedText(null, false, "not_recorded")).not.toContain(
      "apagada"
    );
  });

  it("after a refused sale whose command had already been sent with no answer, does not say it was not recorded", () => {
    const text = deviceClosedText(STORE, true, "maybe_recorded");
    expect(text).toBe(
      "Esta loja foi encerrada em 20 de outubro de 2026. Não deu para saber se a venda que você acabou de confirmar foi registrada. Se uma tentativa anterior chegou ao servidor, ela está na cópia dos seus dados. A cópia deste aparelho foi apagada. O que já estava na fila continua guardado. O carrinho fica guardado aqui e volta em Vender se a loja reabrir. Se você fechar o Polaris, ele se perde."
    );
    expect(text).not.toContain("não foi registrada");
    expect(deviceClosedText(null, false, "maybe_recorded")).not.toContain(
      "apagada"
    );
  });

  it("keeps the sentences of the refused sale free of semicolons and of the word tab", () => {
    for (const cause of ["not_recorded", "maybe_recorded"] as const) {
      for (const dropped of [true, false]) {
        const text = deviceClosedText(STORE, dropped, cause);
        expect(text).not.toContain(";");
        expect(text).not.toContain("aba");
      }
    }
  });

  it("never says the copy was deleted before the device confirmed it", () => {
    expect(deviceClosedText(STORE, false)).toBe(
      "Esta loja foi encerrada em 20 de outubro de 2026. O que não foi enviado continua guardado na fila deste aparelho."
    );
    expect(deviceClosedText(null, false)).not.toContain("apagada");
    expect(DEVICE_CLOSED_LINK).toBe("Ver a loja encerrada");
  });
});
