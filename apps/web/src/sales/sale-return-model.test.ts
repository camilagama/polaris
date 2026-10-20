import { describe, expect, it } from "vitest";
import {
  backToReturnEditing,
  cancelDiscardReturn,
  closeReturn,
  discardLockedReturn,
  editRestocked,
  editReturned,
  editReturnNote,
  editReturnReason,
  initialReturnState,
  isReturnDraftChanged,
  isReturnLocked,
  mapReturnError,
  openReturn,
  prepareReturnSubmission,
  RETURN_EXPLANATION,
  type ReturnDraft,
  type ReturnSaleResult,
  type ReturnState,
  requestDiscardReturn,
  returnFailed,
  returnPanelKey,
  returnReasonLabel,
  returnReview,
  returnSubmitLabel,
  returnSucceeded,
  returnSuccessMessage,
  returnTableRows,
  reviewReturn,
  totalAvailable,
  validateReturnDraft,
  visibleReturnErrors,
} from "./sale-return-model";

const organizationId = "org_1";
const saleId = "77777777-7777-4777-8777-777777777777";

function sequentialIds(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `00000000-0000-4000-8000-${String(next).padStart(12, "0")}`;
  };
}

const rows = returnTableRows(
  [
    {
      availableToReturn: 2,
      position: 0,
      restockedQuantity: 1,
      returnedQuantity: 1,
      sold: 3,
    },
    {
      availableToReturn: 0,
      position: 1,
      restockedQuantity: 1,
      returnedQuantity: 1,
      sold: 1,
    },
    {
      availableToReturn: 4,
      position: 2,
      restockedQuantity: 0,
      returnedQuantity: 0,
      sold: 4,
    },
  ],
  new Map([
    [0, "Camiseta — Azul"],
    [1, "Boné"],
  ])
);

function editing(): ReturnState {
  return openReturn(initialReturnState(), rows);
}

/** Returns 2 of the camiseta; restocked follows it until edited. */
function ready(overrides: (state: ReturnState) => ReturnState = (s) => s) {
  return overrides(editReturned(editing(), 0, "2"));
}

function confirming(overrides: (state: ReturnState) => ReturnState = (s) => s) {
  return reviewReturn(ready(overrides));
}

function prepare(state: ReturnState, createId = sequentialIds()) {
  return prepareReturnSubmission({ createId, organizationId, saleId, state });
}

function submitting(state: ReturnState, createId = sequentialIds()) {
  const prepared = prepare(state, createId);
  if (!prepared.ok) {
    throw new Error("expected a prepared return");
  }
  return prepared;
}

const result = (replayed: boolean): ReturnSaleResult => ({
  lines: [
    { position: 0, restockedQuantity: 1, returnedQuantity: 2 },
    { position: 2, restockedQuantity: 1, returnedQuantity: 1 },
  ],
  replayed,
  saleReturn: {
    commandId: "00000000-0000-4000-8000-000000000001",
    id: "88888888-8888-4888-8888-888888888888",
    reasonCode: null,
    reasonNote: null,
    returnedAt: "2026-05-02T12:00:00.000Z",
    returnedBy: "user_1",
    saleId,
  },
});

function draftOf(state: ReturnState): ReturnDraft {
  return state.draft;
}

describe("what can still be returned", () => {
  it("builds one row per sold item with labels, in position order", () => {
    expect(rows.map((row) => row.label)).toEqual([
      "Camiseta — Azul",
      "Boné",
      "Item 3",
    ]);
    expect(rows[0]).toMatchObject({
      available: 2,
      restocked: 1,
      returned: 1,
      sold: 3,
    });
    expect(totalAvailable(rows)).toBe(6);
    expect(totalAvailable([])).toBe(0);
  });

  it("changes the panel key when availability changes", () => {
    const before = returnPanelKey(rows);
    const after = returnPanelKey(
      rows.map((row) => (row.position === 0 ? { ...row, available: 1 } : row))
    );
    expect(before).not.toBe(after);
  });

  it("explains that no refund is processed and the sale is kept", () => {
    expect(RETURN_EXPLANATION).toContain("não é alterada");
    expect(RETURN_EXPLANATION).toContain("Volta ao estoque");
    expect(RETURN_EXPLANATION).toContain("não processa reembolsos");
    expect(returnReasonLabel("defective")).toBe("Item com defeito");
    expect(returnReasonLabel("wrong_item")).toBe("Item errado");
    expect(returnReasonLabel("customer_request")).toBe("Cliente desistiu");
    expect(returnReasonLabel("other")).toBe("Outro");
    expect(returnReasonLabel(null)).toBe("Sem motivo informado");
  });
});

describe("opening and editing", () => {
  it("opens with a blank line only for items with units available", () => {
    const state = editing();
    expect(state.step).toBe("editing");
    expect(draftOf(state).lines.map((line) => line.position)).toEqual([0, 2]);
    expect(draftOf(state).lines[0]).toMatchObject({
      available: 2,
      restocked: "",
      returned: "",
    });
  });

  it("makes restocked follow returned until the operator edits it", () => {
    let state = editReturned(editing(), 0, "2");
    expect(draftOf(state).lines[0]).toMatchObject({
      restocked: "2",
      returned: "2",
    });
    state = editRestocked(state, 0, "1");
    state = editReturned(state, 0, "1");
    expect(draftOf(state).lines[0]).toMatchObject({
      restocked: "1",
      restockedTouched: true,
      returned: "1",
    });
  });

  it("clears the note with the reason and ignores edits outside the editing step", () => {
    let state = editReturnReason(ready(), "other");
    state = editReturnNote(state, "algo");
    expect(draftOf(state).reasonNote).toBe("algo");
    expect(draftOf(editReturnReason(state, "")).reasonNote).toBe("");
    const closed = initialReturnState();
    expect(editReturned(closed, 0, "1")).toBe(closed);
    const review = confirming();
    expect(editReturned(review, 0, "1")).toBe(review);
    expect(backToReturnEditing(review).step).toBe("editing");
    expect(closeReturn(review)).toEqual(initialReturnState());
  });
});

describe("validation", () => {
  it("skips blank lines but needs at least one line", () => {
    const empty = validateReturnDraft(draftOf(editing()));
    expect(empty.input).toBeNull();
    expect(empty.errors.items).toBe(
      "Informe a quantidade devolvida de pelo menos um item."
    );
    const one = validateReturnDraft(draftOf(ready()));
    expect(one.input?.items).toEqual([
      { position: 0, restockedQuantity: 2, returnedQuantity: 2 },
    ]);
  });

  it("keeps returned between 1 and what is available", () => {
    for (const text of ["0", "3", "-1", "1.5", "abc"]) {
      const validated = validateReturnDraft(
        draftOf(editReturned(editing(), 0, text))
      );
      expect(validated.input, text).toBeNull();
      expect(validated.errors.lines[0]?.returned, text).toBe(
        "Use um número inteiro de 1 a 2."
      );
    }
  });

  it("keeps restocked between 0 and the returned quantity", () => {
    const over = validateReturnDraft(
      draftOf(editRestocked(editReturned(editing(), 0, "2"), 0, "3"))
    );
    expect(over.input).toBeNull();
    expect(over.errors.lines[0]?.restocked).toContain("0 até a quantidade");
    const zero = validateReturnDraft(
      draftOf(editRestocked(editReturned(editing(), 0, "2"), 0, "0"))
    );
    expect(zero.input?.items[0]).toMatchObject({ restockedQuantity: 0 });
    const blank = validateReturnDraft(
      draftOf(editRestocked(editReturned(editing(), 0, "2"), 0, ""))
    );
    expect(blank.errors.lines[0]?.restocked).toContain("0 se nenhum");
  });

  it("returns some units to stock and keeps one out (damaged)", () => {
    const state = editRestocked(editReturned(editing(), 0, "2"), 0, "1");
    expect(validateReturnDraft(draftOf(state)).input?.items).toEqual([
      { position: 0, restockedQuantity: 1, returnedQuantity: 2 },
    ]);
  });

  it("asks for the returned quantity when only restocked was filled", () => {
    const validated = validateReturnDraft(
      draftOf(editRestocked(editing(), 0, "1"))
    );
    expect(validated.errors.lines[0]?.returned).toBe(
      "Informe quantos foram devolvidos."
    );
  });

  it("applies the reason and note rules", () => {
    const other = validateReturnDraft(
      draftOf(editReturnReason(ready(), "other"))
    );
    expect(other.input).toBeNull();
    expect(other.errors.note).toBe("Descreva o motivo em “Outro”.");
    const defective = validateReturnDraft(
      draftOf(
        editReturnNote(editReturnReason(ready(), "defective"), "  rasgada ")
      )
    );
    expect(defective.input).toMatchObject({
      reasonCode: "defective",
      reasonNote: "rasgada",
    });
    const tooLong = validateReturnDraft({
      ...draftOf(ready()),
      reasonCode: "other",
      reasonNote: "x".repeat(501),
    });
    expect(tooLong.errors.note).toContain("500");
    const noReason = validateReturnDraft({
      ...draftOf(ready()),
      reasonNote: "texto",
    });
    expect(noReason.errors.reason).toContain("Escolha um motivo");
  });

  it("shows errors only after a review attempt, except a too-long note", () => {
    const blocked = reviewReturn(editing());
    expect(blocked.step).toBe("editing");
    expect(visibleReturnErrors(editing())).toEqual({ lines: {} });
    expect(visibleReturnErrors(blocked).items).toContain("pelo menos um item");
    const long = editReturnNote(
      editReturnReason(editing(), "other"),
      "x".repeat(501)
    );
    expect(visibleReturnErrors(long).note).toContain("500");
  });
});

describe("confirmation step", () => {
  it("summarizes per item and the stock effect, with no refund", () => {
    const state = confirming((s) => editRestocked(s, 0, "1"));
    expect(state.step).toBe("confirming");
    const review = returnReview(state);
    expect(review?.lines[0]?.text).toBe(
      "Camiseta — Azul: devolvidas 2, voltam ao estoque 1"
    );
    expect(review?.totalsText).toContain("Total: 2 devolvidas");
    expect(review?.totalsText).toContain("1 voltam ao estoque");
    expect(review?.totalsText).toContain("1 não voltam");
    expect(review?.totalsText).toContain("Nenhum reembolso");
    expect(review?.reasonText).toBe("Sem motivo informado");
    expect(returnReview(editing())).toBeNull();
  });
});

describe("submission and idempotency", () => {
  it("builds one return request with the version 1 command", () => {
    const prepared = submitting(
      confirming((s) => editReturnReason(editReturnNote(s, ""), "wrong_item"))
    );
    expect(prepared.request).toEqual({
      commandId: "00000000-0000-4000-8000-000000000001",
      commandVersion: 1,
      items: [{ position: 0, restockedQuantity: 2, returnedQuantity: 2 }],
      organizationId,
      reasonCode: "wrong_item",
      reasonNote: null,
      saleId,
    });
    expect(prepared.state.submission).toEqual({ phase: "submitting" });
    expect(returnSubmitLabel(prepared.state)).toBe("Registrando devolução…");
  });

  it("refuses to submit from the editing step and guards a double submit", () => {
    expect(prepare(ready()).ok).toBe(false);
    const first = submitting(confirming());
    const second = prepare(first.state);
    expect(second.ok).toBe(false);
    expect(second.state).toBe(first.state);
  });

  it("keeps the command ID for an identical retry after a definite failure", () => {
    const ids = sequentialIds();
    const first = submitting(confirming(), ids);
    const failed = returnFailed(first.state, { code: "CONFLICT" });
    expect(failed.submission.phase).toBe("failed");
    expect(failed.step).toBe("editing");
    const again = submitting(reviewReturn(failed), ids);
    expect(again.request.commandId).toBe(first.request.commandId);
  });

  it("creates a fresh command ID after any edit", () => {
    const ids = sequentialIds();
    const first = submitting(confirming(), ids);
    const failed = returnFailed(first.state, { code: "BAD_REQUEST" });
    for (const edit of [
      (s: ReturnState) => editReturned(s, 0, "1"),
      (s: ReturnState) => editRestocked(s, 0, "0"),
      (s: ReturnState) => editReturnReason(s, "defective"),
    ]) {
      const next = submitting(reviewReturn(edit(failed)), ids);
      expect(next.request.commandId).not.toBe(first.request.commandId);
    }
  });

  it("drops the attempt after a command conflict", () => {
    const ids = sequentialIds();
    const first = submitting(confirming(), ids);
    const failed = returnFailed(first.state, {
      code: "CONFLICT",
      data: { reason: "sale_return_command_conflict" },
    });
    expect(failed.attempt).toBeNull();
    expect(submitting(reviewReturn(failed), ids).request.commandId).not.toBe(
      first.request.commandId
    );
  });

  it("reports success and replay, and closes the flow", () => {
    const done = returnSucceeded(result(false));
    expect(done.step).toBe("closed");
    expect(done.submission).toMatchObject({
      phase: "success",
      replayed: false,
    });
    expect(returnSuccessMessage(result(false))).toBe(
      "Devolução registrada: 3 unidades no total; 2 voltaram ao estoque. O Polaris não processou nenhum reembolso."
    );
    expect(returnSuccessMessage(result(true))).toBe(
      "Esta devolução já havia sido registrada com este mesmo pedido. Nada foi duplicado."
    );
  });
});

describe("error mapping", () => {
  it("reloads the detail when the quantity exceeds what is available", () => {
    const failure = mapReturnError({
      code: "CONFLICT",
      data: { reason: "sale_return_exceeds_available" },
    });
    expect(failure.message).toContain("acima do disponível para devolução");
    expect(failure.reloadDetail).toBe(true);
    expect(failure.unknownOutcome).toBe(false);
  });

  it("discards the attempt when the command ID collides with a stock movement", () => {
    const failure = mapReturnError({
      code: "CONFLICT",
      data: { reason: "stock_command_conflict" },
    });
    expect(failure.discardAttempt).toBe(true);
    expect(failure.unknownOutcome).toBe(false);
  });

  it("explains the stock limit without locking the attempt", () => {
    const failure = mapReturnError({
      code: "CONFLICT",
      data: { reason: "inventory_quantity_limit" },
    });
    expect(failure.message).toContain("limite");
    expect(failure.discardAttempt).toBeFalsy();
    expect(failure.unknownOutcome).toBe(false);
  });
  it("reloads when the sale was cancelled", () => {
    const failure = mapReturnError({
      code: "CONFLICT",
      data: { reason: "sale_not_returnable" },
    });
    expect(failure.message).toContain("cancelada");
    expect(failure.reloadDetail).toBe(true);
  });

  it("asks for a fresh attempt after a command conflict", () => {
    const failure = mapReturnError({
      code: "CONFLICT",
      data: { reason: "sale_return_command_conflict" },
    });
    expect(failure.discardAttempt).toBe(true);
  });

  it("explains a removed product and suggests restocking zero", () => {
    for (const reason of ["sale_product_unavailable", "product_deleted"]) {
      const failure = mapReturnError({ code: "CONFLICT", data: { reason } });
      expect(failure.message, reason).toContain("não podem voltar ao estoque");
      expect(failure.message, reason).toContain("Registre 0");
      expect(failure.reloadDetail, reason).toBe(false);
    }
  });

  it("maps invalid returns and a missing sale", () => {
    expect(
      mapReturnError({
        code: "BAD_REQUEST",
        data: { reason: "invalid_sale_return" },
      }).message
    ).toContain("A devolução foi recusada");
    expect(
      mapReturnError({
        code: "NOT_FOUND",
        data: { reason: "sale_not_found" },
      }).message
    ).toContain("não foi encontrada");
  });

  it("falls back to generic messages, and authorization stays generic", () => {
    expect(mapReturnError({ code: "CONFLICT" }).message).toContain(
      "O estado da venda mudou"
    );
    expect(
      mapReturnError({ code: "CONFLICT", data: { reason: "novo" } }).message
    ).toContain("O estado da venda mudou");
    expect(mapReturnError({ code: "FORBIDDEN" }).message).toBe(
      "Sua conta não tem acesso a esta organização ou ação."
    );
  });
});

describe("unknown-outcome lock", () => {
  const locked = () =>
    returnFailed(submitting(confirming()).state, new TypeError("x"));

  it("locks on network, 5xx and unknown errors but not on 4xx", () => {
    for (const error of [
      new TypeError("Failed to fetch"),
      { code: "SERVICE_UNAVAILABLE" },
      new Error("boom"),
    ]) {
      const state = returnFailed(submitting(confirming()).state, error);
      expect(state.submission.phase).toBe("locked");
      expect(isReturnLocked(state)).toBe(true);
      expect(returnSubmitLabel(state)).toBe("Tentar novamente (seguro)");
    }
    for (const error of [
      { code: "CONFLICT", data: { reason: "sale_not_returnable" } },
      { code: "BAD_REQUEST" },
      { code: "FORBIDDEN" },
    ]) {
      const state = returnFailed(submitting(confirming()).state, error);
      expect(state.submission.phase).toBe("failed");
      expect(isReturnLocked(state)).toBe(false);
    }
  });

  it("rejects edits and navigation while locked", () => {
    const state = locked();
    expect(editReturned(state, 0, "1")).toBe(state);
    expect(editRestocked(state, 0, "0")).toBe(state);
    expect(editReturnNote(state, "x")).toBe(state);
    expect(editReturnReason(state, "other")).toBe(state);
    expect(backToReturnEditing(state)).toBe(state);
    expect(closeReturn(state)).toBe(state);
    expect(reviewReturn(state)).toBe(state);
  });

  it("retries the locked attempt with the same command ID", () => {
    const ids = sequentialIds();
    const first = submitting(confirming(), ids);
    const state = returnFailed(first.state, new TypeError("x"));
    const retry = prepare(state, ids);
    expect(retry.ok && retry.request).toEqual(first.request);
    expect(retry.state.submission).toEqual({ phase: "submitting" });
  });

  it("needs an explicit second step to discard, then resets", () => {
    const state = locked();
    expect(discardLockedReturn(state)).toBeNull();
    const asked = requestDiscardReturn(state);
    expect(asked.submission).toMatchObject({ confirmingDiscard: true });
    expect(discardLockedReturn(cancelDiscardReturn(asked))).toBeNull();
    expect(discardLockedReturn(asked)).toEqual(initialReturnState());
    expect(discardLockedReturn(initialReturnState())).toBeNull();
  });

  it("unlocks after a locked retry succeeds", () => {
    expect(isReturnLocked(returnSucceeded(result(true)))).toBe(false);
  });
});

describe("isReturnDraftChanged (the sign that the session notice warns about)", () => {
  it("does not count a closed panel, or one opened with nothing put in", () => {
    expect(isReturnDraftChanged(initialReturnState())).toBe(false);
    expect(isReturnDraftChanged(editing())).toBe(false);
  });

  it("counts a returned quantity, a reason or a note", () => {
    expect(isReturnDraftChanged(editReturned(editing(), 0, "1"))).toBe(true);
    expect(isReturnDraftChanged(editReturnReason(editing(), "defective"))).toBe(
      true
    );
  });
});
