import { describe, expect, it } from "vitest";
import {
  backToCancelEditing,
  CANCELLATION_EXPLANATION,
  type CancelSaleResult,
  type CancelState,
  cancelDiscardCancel,
  cancelFailed,
  cancellationReasonLabel,
  cancelSubmitLabel,
  cancelSucceeded,
  cancelSuccessMessage,
  closeCancel,
  discardLockedCancel,
  editCancelNote,
  editCancelReason,
  initialCancelState,
  isCancelLocked,
  mapCancelError,
  noteCounterText,
  openCancel,
  prepareCancelSubmission,
  requestDiscardCancel,
  reviewCancel,
  validateCancelDraft,
  visibleCancelErrors,
} from "./sale-cancellation-model";

const organizationId = "org_1";
const saleId = "77777777-7777-4777-8777-777777777777";

function sequentialIds(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `00000000-0000-4000-8000-${String(next).padStart(12, "0")}`;
  };
}

function confirming(
  reason: Parameters<typeof editCancelReason>[1] = "",
  note = ""
): CancelState {
  let state = openCancel(initialCancelState());
  state = editCancelReason(state, reason);
  state = editCancelNote(state, note);
  return reviewCancel(state);
}

function prepare(state: CancelState, createId = sequentialIds()) {
  return prepareCancelSubmission({ createId, organizationId, saleId, state });
}

function submitting(state: CancelState, createId = sequentialIds()) {
  const prepared = prepare(state, createId);
  if (!prepared.ok) {
    throw new Error("expected a prepared cancellation");
  }
  return prepared;
}

const result = (replayed: boolean): CancelSaleResult => ({
  cancellation: {
    cancelledAt: "2026-05-02T12:00:00.000Z",
    cancelledBy: "user_1",
    commandId: "00000000-0000-4000-8000-000000000001",
    id: "88888888-8888-4888-8888-888888888888",
    reasonCode: null,
    reasonNote: null,
    saleId,
  },
  replayed,
  restocked: [
    {
      position: 0,
      quantity: 2,
      variantId: "22222222-2222-4222-8222-222222222222",
    },
    {
      position: 1,
      quantity: 1,
      variantId: "33333333-3333-4333-8333-333333333333",
    },
  ],
});

describe("reason and note validation", () => {
  it("accepts no reason at all", () => {
    expect(validateCancelDraft({ reasonCode: "", reasonNote: "" })).toEqual({
      errors: {},
      input: { reasonCode: null, reasonNote: null },
    });
  });

  it("accepts a classified reason with or without a note, trimming it", () => {
    expect(
      validateCancelDraft({ reasonCode: "entry_error", reasonNote: "" }).input
    ).toEqual({ reasonCode: "entry_error", reasonNote: null });
    expect(
      validateCancelDraft({
        reasonCode: "customer_request",
        reasonNote: "  Desistiu na loja  ",
      }).input
    ).toEqual({
      reasonCode: "customer_request",
      reasonNote: "Desistiu na loja",
    });
  });

  it("requires a note only for Outro", () => {
    const other = validateCancelDraft({
      reasonCode: "other",
      reasonNote: "  ",
    });
    expect(other.input).toBeNull();
    expect(other.errors.note).toBe("Descreva o motivo em “Outro”.");
    expect(
      validateCancelDraft({ reasonCode: "other", reasonNote: "Troca de loja" })
        .input
    ).toEqual({ reasonCode: "other", reasonNote: "Troca de loja" });
  });

  it("does not allow a note without a reason", () => {
    const draft = validateCancelDraft({ reasonCode: "", reasonNote: "texto" });
    expect(draft.input).toBeNull();
    expect(draft.errors.reason).toContain("Escolha um motivo");
  });

  it("limits the note to 500 code points, counting emoji as one", () => {
    const ok = "😀".repeat(500);
    expect(
      validateCancelDraft({ reasonCode: "other", reasonNote: ok }).input
    ).not.toBeNull();
    const tooLong = validateCancelDraft({
      reasonCode: "other",
      reasonNote: `${ok}x`,
    });
    expect(tooLong.input).toBeNull();
    expect(tooLong.errors.note).toContain("500");
    expect(noteCounterText({ reasonCode: "other", reasonNote: ok })).toBe(
      "500/500"
    );
  });

  it("labels the stored reasons", () => {
    expect(cancellationReasonLabel("customer_request")).toBe(
      "Cliente desistiu"
    );
    expect(cancellationReasonLabel("entry_error")).toBe("Erro de lançamento");
    expect(cancellationReasonLabel("payment_issue")).toBe(
      "Problema no pagamento"
    );
    expect(cancellationReasonLabel("other")).toBe("Outro");
    expect(cancellationReasonLabel(null)).toBe("Sem motivo informado");
  });

  it("explains that the sale is kept, stock returns per item and it is final", () => {
    expect(CANCELLATION_EXPLANATION).toContain("preservados");
    expect(CANCELLATION_EXPLANATION).toContain("item a item");
    expect(CANCELLATION_EXPLANATION).toContain("não pode ser desfeito");
  });
});

describe("two-step flow", () => {
  it("starts closed and opens into the editing step", () => {
    const state = initialCancelState();
    expect(state.step).toBe("closed");
    expect(openCancel(state).step).toBe("editing");
  });

  it("clears the note when the reason is cleared", () => {
    let state = openCancel(initialCancelState());
    state = editCancelReason(state, "other");
    state = editCancelNote(state, "algo");
    expect(state.draft.reasonNote).toBe("algo");
    state = editCancelReason(state, "");
    expect(state.draft).toEqual({ reasonCode: "", reasonNote: "" });
  });

  it("blocks the review for an invalid draft and shows the required error only afterwards", () => {
    let state = editCancelReason(openCancel(initialCancelState()), "other");
    expect(visibleCancelErrors(state)).toEqual({});
    state = reviewCancel(state);
    expect(state.step).toBe("editing");
    expect(visibleCancelErrors(state).note).toBe(
      "Descreva o motivo em “Outro”."
    );
  });

  it("shows a too-long note immediately", () => {
    let state = editCancelReason(openCancel(initialCancelState()), "other");
    state = editCancelNote(state, "x".repeat(501));
    expect(visibleCancelErrors(state).note).toContain("500");
  });

  it("moves to the confirmation step, back, and closes by abandoning the draft", () => {
    const state = confirming("payment_issue", "estorno");
    expect(state.step).toBe("confirming");
    expect(editCancelNote(state, "mudou")).toBe(state);
    const back = backToCancelEditing(state);
    expect(back.step).toBe("editing");
    expect(closeCancel(back)).toEqual(initialCancelState());
  });
});

describe("submission and idempotency", () => {
  it("builds one cancel request with the version 1 command", () => {
    const prepared = submitting(confirming("customer_request", "  nota "));
    expect(prepared.request).toEqual({
      commandId: "00000000-0000-4000-8000-000000000001",
      commandVersion: 1,
      organizationId,
      reasonCode: "customer_request",
      reasonNote: "nota",
      saleId,
    });
    expect(prepared.state.submission).toEqual({ phase: "submitting" });
    expect(cancelSubmitLabel(prepared.state)).toBe("Cancelando…");
  });

  it("sends no reason or note when none was informed", () => {
    expect(submitting(confirming()).request).toMatchObject({
      reasonCode: null,
      reasonNote: null,
    });
  });

  it("refuses to submit from the editing step", () => {
    const editing = openCancel(initialCancelState());
    expect(prepare(editing).ok).toBe(false);
  });

  it("guards against a double submit", () => {
    const first = submitting(confirming("entry_error"));
    const second = prepare(first.state);
    expect(second.ok).toBe(false);
    expect(second.state).toBe(first.state);
  });

  it("keeps the same command ID for an identical retry after a definite failure", () => {
    const ids = sequentialIds();
    const first = submitting(confirming("entry_error"), ids);
    const failed = cancelFailed(first.state, { code: "CONFLICT" });
    expect(failed.submission.phase).toBe("failed");
    expect(failed.step).toBe("editing");
    const again = submitting(reviewCancel(failed), ids);
    expect(again.request.commandId).toBe(first.request.commandId);
  });

  it("creates a fresh command ID after any edit of reason or note", () => {
    const ids = sequentialIds();
    const first = submitting(confirming("entry_error", "a"), ids);
    const failed = cancelFailed(first.state, { code: "BAD_REQUEST" });
    const edited = reviewCancel(editCancelNote(failed, "b"));
    expect(submitting(edited, ids).request.commandId).not.toBe(
      first.request.commandId
    );
    const reasonEdited = reviewCancel(
      editCancelReason(failed, "payment_issue")
    );
    expect(submitting(reasonEdited, ids).request.commandId).not.toBe(
      first.request.commandId
    );
  });

  it("drops the attempt after a command conflict so the next confirm is fresh", () => {
    const ids = sequentialIds();
    const first = submitting(confirming("entry_error"), ids);
    const failed = cancelFailed(first.state, {
      code: "CONFLICT",
      data: { reason: "sale_cancellation_command_conflict" },
    });
    expect(failed.attempt).toBeNull();
    expect(submitting(reviewCancel(failed), ids).request.commandId).not.toBe(
      first.request.commandId
    );
  });

  it("reports success and replay, and the flow closes", () => {
    const done = cancelSucceeded(result(false));
    expect(done.step).toBe("closed");
    expect(done.submission).toMatchObject({
      message:
        "Venda cancelada. O estoque foi devolvido item a item (2 itens).",
      phase: "success",
      replayed: false,
    });
    expect(cancelSuccessMessage(result(true))).toBe(
      "Esta venda já havia sido cancelada com este mesmo pedido. Nada foi duplicado."
    );
  });
});

describe("error mapping", () => {
  it("maps an already cancelled sale and asks to reload the detail", () => {
    const failure = mapCancelError({
      code: "CONFLICT",
      data: { reason: "sale_already_cancelled" },
    });
    expect(failure.message).toContain("já foi cancelada");
    expect(failure.reloadDetail).toBe(true);
    expect(failure.unknownOutcome).toBe(false);
  });

  it("explains that a sale with returns cannot be cancelled and reloads the detail", () => {
    const failure = mapCancelError({
      code: "CONFLICT",
      data: { reason: "sale_has_returns" },
    });
    expect(failure.message).toContain("já tem devoluções");
    expect(failure.message).toContain("não pode ser cancelada por inteiro");
    expect(failure.reloadDetail).toBe(true);
    expect(failure.unknownOutcome).toBe(false);
  });

  it("explains a removed product for both reasons", () => {
    for (const reason of ["sale_product_unavailable", "product_deleted"]) {
      const failure = mapCancelError({ code: "CONFLICT", data: { reason } });
      expect(failure.message, reason).toContain(
        "o estoque não pode ser devolvido"
      );
      expect(failure.reloadDetail, reason).toBe(false);
    }
  });

  it("maps a missing sale and an invalid cancellation", () => {
    expect(
      mapCancelError({ code: "NOT_FOUND", data: { reason: "sale_not_found" } })
        .message
    ).toContain("não foi encontrada");
    const invalid = mapCancelError({
      code: "BAD_REQUEST",
      data: { reason: "invalid_sale_cancellation" },
    });
    expect(invalid.message).toContain("“Outro” exige uma observação");
    expect(invalid.reason).toBe("invalid_sale_cancellation");
  });

  it("falls back to generic per-code messages for a missing or unknown reason", () => {
    expect(mapCancelError({ code: "CONFLICT" }).message).toContain(
      "O estado da venda mudou"
    );
    expect(
      mapCancelError({ code: "CONFLICT", data: { reason: "novo" } }).message
    ).toContain("O estado da venda mudou");
    expect(mapCancelError({ code: "BAD_REQUEST" }).message).toContain(
      "recusou o pedido"
    );
    expect(mapCancelError({ code: "NOT_FOUND" }).reloadDetail).toBe(true);
  });

  it("uses the existing generic messages for authorization errors", () => {
    expect(mapCancelError({ code: "UNAUTHORIZED" }).message).toContain(
      "sessão"
    );
    const forbidden = mapCancelError({
      code: "FORBIDDEN",
      data: { reason: "sale_already_cancelled" },
    });
    expect(forbidden.message).toBe(
      "Sua conta não tem acesso a esta organização ou ação."
    );
    expect(forbidden.reason).toBeNull();
  });

  it("treats network, 5xx and unknown errors as an unknown outcome", () => {
    for (const error of [
      new TypeError("Failed to fetch"),
      { code: "SERVICE_UNAVAILABLE" },
      { code: "INTERNAL_SERVER_ERROR" },
      new Error("boom"),
    ]) {
      const failure = mapCancelError(error);
      expect(failure.unknownOutcome).toBe(true);
      expect(failure.message).toContain("Tentar novamente (seguro)");
    }
  });
});

describe("unknown-outcome lock", () => {
  const locked = () =>
    cancelFailed(
      submitting(confirming("entry_error")).state,
      new TypeError("x")
    );

  it("locks on network, 5xx and unknown failures but not on 4xx", () => {
    expect(locked().submission.phase).toBe("locked");
    expect(isCancelLocked(locked())).toBe(true);
    expect(cancelSubmitLabel(locked())).toBe("Tentar novamente (seguro)");
    for (const error of [
      { code: "CONFLICT", data: { reason: "sale_already_cancelled" } },
      { code: "BAD_REQUEST" },
      { code: "FORBIDDEN" },
    ]) {
      const failed = cancelFailed(submitting(confirming()).state, error);
      expect(failed.submission.phase).toBe("failed");
      expect(isCancelLocked(failed)).toBe(false);
    }
  });

  it("rejects edits and navigation while locked", () => {
    const state = locked();
    expect(editCancelNote(state, "x")).toBe(state);
    expect(editCancelReason(state, "other")).toBe(state);
    expect(backToCancelEditing(state)).toBe(state);
    expect(closeCancel(state)).toBe(state);
    expect(reviewCancel(state)).toBe(state);
  });

  it("retries a locked attempt with the same command ID", () => {
    const ids = sequentialIds();
    const first = submitting(confirming("entry_error", "x"), ids);
    const state = cancelFailed(first.state, new TypeError("x"));
    const retry = prepare(state, ids);
    expect(retry.ok && retry.request).toEqual(first.request);
    expect(retry.state.submission).toEqual({ phase: "submitting" });
  });

  it("needs an explicit second step to discard, then resets", () => {
    const state = locked();
    expect(discardLockedCancel(state)).toBeNull();
    const asked = requestDiscardCancel(state);
    expect(asked.submission).toMatchObject({ confirmingDiscard: true });
    expect(isCancelLocked(asked)).toBe(true);
    expect(discardLockedCancel(cancelDiscardCancel(asked))).toBeNull();
    expect(discardLockedCancel(asked)).toEqual(initialCancelState());
    expect(discardLockedCancel(initialCancelState())).toBeNull();
  });

  it("locks again when the retry also has an unknown outcome", () => {
    const retrying = prepare(locked());
    expect(retrying.ok).toBe(true);
    expect(
      cancelFailed(retrying.state, { code: "GATEWAY_TIMEOUT" }).submission.phase
    ).toBe("locked");
  });

  it("unlocks after a locked retry succeeds", () => {
    expect(isCancelLocked(cancelSucceeded(result(true)))).toBe(false);
  });
});
