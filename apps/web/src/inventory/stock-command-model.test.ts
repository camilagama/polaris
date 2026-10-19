import { describe, expect, it } from "vitest";
import {
  backToStockEditing,
  canCloseStock,
  cancelDiscardStock,
  discardLockedStock,
  editStockField,
  firstInvalidStockField,
  isStockLocked,
  mapStockError,
  parseUnitCost,
  prepareStockSubmission,
  requestDiscardStock,
  retargetStock,
  reviewStock,
  type StockAction,
  type StockCommandState,
  type StockResult,
  startStockCommand,
  stockActionBlock,
  stockConsequence,
  stockFailed,
  stockSubmitLabel,
  stockSucceeded,
  stockSummary,
  validateStockDraft,
  visibleStockIssues,
  writeOffReasonLabel,
} from "./stock-command-model";
import type { StockTarget } from "./stock-target";

const organizationId = "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0";
const variantId = "0199c2d0-0000-7000-8000-000000000002";
const today = "2026-10-13";

const target: StockTarget = {
  archived: false,
  movingAverageCost: "10.000000",
  productName: "Camiseta Polaris",
  quantity: 5,
  variantId,
  variantText: "Azul / M",
  version: 3,
};

const unknownCostTarget: StockTarget = {
  ...target,
  movingAverageCost: null,
};

function ids() {
  let n = 0;
  return () => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  };
}

function filled(
  action: StockAction,
  fields: Record<string, string>,
  forTarget: StockTarget = target
): StockCommandState {
  let state = startStockCommand(action, forTarget, today);
  for (const [field, value] of Object.entries(fields)) {
    state = editStockField(state, field as never, value);
  }
  return state;
}

const receiveFields = { quantity: "10", unitCost: "12,50" };
const countFields = { physicalQuantity: "7" };
const writeOffFields = { quantity: "2", reasonCode: "damaged" };

function confirming(state: StockCommandState): StockCommandState {
  const reviewed = reviewStock(state);
  expect(reviewed.step).toBe("confirming");
  return reviewed;
}

function issuesOf(state: StockCommandState) {
  return validateStockDraft(state.draft, state.target, state.today).issues;
}

describe("parseUnitCost", () => {
  it.each([
    ["12,34", "12.34"],
    ["12.34", "12.34"],
    ["0", "0"],
    ["0,5", "0.5"],
    ["007", "7"],
    ["1,234567", "1.234567"],
    ["  3 ", "3"],
  ])("accepts %s as %s", (text, value) => {
    expect(parseUnitCost(text)).toEqual({ kind: "ok", value });
  });

  it.each(["1.234,56", "1,2345678", "-1", "abc", "1,", ",5", "1e3"])(
    "rejects %s",
    (text) => {
      expect(parseUnitCost(text).kind).toBe("invalid");
    }
  );

  it("tells empty and too large apart", () => {
    expect(parseUnitCost("  ").kind).toBe("empty");
    expect(parseUnitCost("1".repeat(19)).kind).toBe("too_large");
    expect(parseUnitCost("1".repeat(18)).kind).toBe("ok");
  });
});

describe("receive validation", () => {
  it("accepts a quantity, a required unit cost and today's date", () => {
    const { body, issues } = validateStockDraft(
      filled("receive", receiveFields).draft,
      target,
      today
    );
    expect(issues).toEqual([]);
    expect(body).toEqual({
      action: "receive",
      occurredOn: today,
      quantity: 10,
      unitCost: "12.50",
    });
  });

  it("requires the unit cost and the quantity", () => {
    const issues = issuesOf(filled("receive", {}));
    expect(issues.map((issue) => [issue.field, issue.empty])).toEqual([
      ["quantity", true],
      ["unitCost", true],
    ]);
    expect(issues[1]?.message).toContain("obrigatório");
  });

  it("rejects zero, fractions and absurd quantities", () => {
    for (const quantity of ["0", "1,5", "-2", "abc"]) {
      expect(
        issuesOf(filled("receive", { ...receiveFields, quantity }))[0]
      ).toMatchObject({ field: "quantity", empty: false });
    }
    expect(
      issuesOf(
        filled("receive", { ...receiveFields, quantity: "2147483648" })
      )[0]?.message
    ).toContain("2.147.483.647");
  });

  it("refuses a receipt that would pass the stock limit", () => {
    const state = filled(
      "receive",
      { ...receiveFields, quantity: "2147483647" },
      target
    );
    expect(issuesOf(state)[0]?.message).toContain("saldo");
  });

  it("rejects future and impossible dates", () => {
    expect(
      issuesOf(
        filled("receive", { ...receiveFields, occurredOn: "2026-10-14" })
      )[0]
    ).toMatchObject({
      field: "occurredOn",
      message: "A data não pode ser futura.",
    });
    expect(
      issuesOf(
        filled("receive", { ...receiveFields, occurredOn: "2026-02-30" })
      )[0]
    ).toMatchObject({ field: "occurredOn" });
    expect(
      issuesOf(filled("receive", { ...receiveFields, occurredOn: "" }))[0]
    ).toMatchObject({ empty: true, field: "occurredOn" });
    expect(
      validateStockDraft(
        filled("receive", { ...receiveFields, occurredOn: "2026-10-01" }).draft,
        target,
        today
      ).body
    ).toMatchObject({ occurredOn: "2026-10-01" });
  });

  it("blocks receiving into a positive balance of unknown cost", () => {
    expect(stockActionBlock("receive", unknownCostTarget)).toContain(
      "bloqueado"
    );
    expect(
      stockActionBlock("receive", { ...unknownCostTarget, quantity: 0 })
    ).toBeNull();
    expect(stockActionBlock("receive", target)).toBeNull();
    const blocked = startStockCommand("receive", unknownCostTarget, today);
    expect(reviewStock(editStockField(blocked, "quantity", "1"))).toEqual(
      editStockField(blocked, "quantity", "1")
    );
  });
});

describe("count validation", () => {
  it("sends the balance version the screen read", () => {
    expect(
      validateStockDraft(filled("count", countFields).draft, target, today).body
    ).toEqual({
      action: "count",
      expectedVersion: 3,
      occurredOn: today,
      physicalQuantity: 7,
      valuationUnitCost: null,
    });
  });

  it("accepts zero as a count and requires some quantity", () => {
    expect(
      validateStockDraft(
        filled("count", { physicalQuantity: "0" }).draft,
        target,
        today
      ).body
    ).toMatchObject({ physicalQuantity: 0 });
    expect(issuesOf(filled("count", {}))[0]).toMatchObject({
      empty: true,
      field: "physicalQuantity",
    });
  });

  it("takes a valuation only while the cost is unknown", () => {
    const known = filled("count", {
      ...countFields,
      valuationUnitCost: "9,90",
    });
    expect(validateStockDraft(known.draft, target, today).body).toMatchObject({
      valuationUnitCost: null,
    });
    const unknown = filled(
      "count",
      { ...countFields, valuationUnitCost: "9,90" },
      unknownCostTarget
    );
    expect(
      validateStockDraft(unknown.draft, unknownCostTarget, today).body
    ).toMatchObject({ valuationUnitCost: "9.90" });
  });

  it("rejects a valuation on a zero count or an unparsable one", () => {
    const zero = filled(
      "count",
      { physicalQuantity: "0", valuationUnitCost: "5" },
      unknownCostTarget
    );
    expect(issuesOf(zero)[0]).toMatchObject({ field: "valuationUnitCost" });
    const bad = filled(
      "count",
      { ...countFields, valuationUnitCost: "abc" },
      unknownCostTarget
    );
    expect(issuesOf(bad)[0]).toMatchObject({ field: "valuationUnitCost" });
  });
});

describe("write-off validation", () => {
  it("needs a quantity within the balance and a structured reason", () => {
    expect(
      validateStockDraft(
        filled("write_off", writeOffFields).draft,
        target,
        today
      ).body
    ).toEqual({
      action: "write_off",
      occurredOn: today,
      quantity: 2,
      reasonCode: "damaged",
      reasonNote: null,
    });
    expect(
      issuesOf(filled("write_off", { quantity: "6", reasonCode: "lost" }))[0]
    ).toMatchObject({ field: "quantity", empty: false });
    expect(issuesOf(filled("write_off", { quantity: "1" }))[0]).toMatchObject({
      empty: true,
      field: "reasonCode",
    });
  });

  it("requires a note for Outro and trims and limits it", () => {
    expect(
      issuesOf(filled("write_off", { quantity: "1", reasonCode: "other" }))[0]
    ).toMatchObject({ empty: true, field: "reasonNote" });
    expect(
      validateStockDraft(
        filled("write_off", {
          quantity: "1",
          reasonCode: "other",
          reasonNote: "  caixa molhada  ",
        }).draft,
        target,
        today
      ).body
    ).toMatchObject({ reasonNote: "caixa molhada" });
    const tooLong = filled("write_off", {
      quantity: "1",
      reasonCode: "damaged",
      reasonNote: "😀".repeat(501),
    });
    expect(issuesOf(tooLong)[0]).toMatchObject({ field: "reasonNote" });
    const limit = filled("write_off", {
      quantity: "1",
      reasonCode: "damaged",
      reasonNote: "😀".repeat(500),
    });
    expect(issuesOf(limit)).toEqual([]);
  });

  it("cannot start without balance", () => {
    expect(stockActionBlock("write_off", { ...target, quantity: 0 })).toContain(
      "saldo 0"
    );
    expect(stockActionBlock("write_off", target)).toBeNull();
    expect(stockActionBlock("count", { ...target, quantity: 0 })).toBeNull();
  });

  it("knows every reason label", () => {
    for (const code of [
      "damaged",
      "expired",
      "lost",
      "stolen",
      "internal_use",
      "other",
    ]) {
      expect(writeOffReasonLabel(code)).not.toBe("Motivo desconhecido");
    }
    expect(writeOffReasonLabel("nope")).toBe("Motivo desconhecido");
  });
});

describe("form flow", () => {
  it("shows format errors live and required ones only after a review try", () => {
    let state = filled("receive", { quantity: "abc" });
    expect(visibleStockIssues(state).map((issue) => issue.field)).toEqual([
      "quantity",
    ]);
    state = reviewStock(state);
    expect(state.step).toBe("editing");
    expect(state.showErrors).toBe(true);
    expect(visibleStockIssues(state).map((issue) => issue.field)).toEqual([
      "quantity",
      "unitCost",
    ]);
  });

  it("focuses the first invalid field in the order shown", () => {
    const issues = issuesOf(
      filled("write_off", { quantity: "1", reasonCode: "other" })
    );
    expect(firstInvalidStockField("write_off", issues)).toBe("reasonNote");
    expect(firstInvalidStockField("receive", [])).toBeNull();
  });

  it("moves to confirmation only with a valid draft and can go back", () => {
    const state = confirming(filled("receive", receiveFields));
    expect(backToStockEditing(state).step).toBe("editing");
    expect(editStockField(state, "quantity", "99")).toBe(state);
  });

  it("ignores fields that do not belong to the action", () => {
    const state = startStockCommand("receive", target, today);
    expect(editStockField(state, "reasonCode", "lost")).toBe(state);
  });
});

describe("submission and idempotency", () => {
  it("builds the single command with a fresh command ID", () => {
    const createId = ids();
    const prepared = prepareStockSubmission({
      createId,
      organizationId,
      state: confirming(filled("receive", receiveFields)),
    });
    expect(prepared.ok).toBe(true);
    if (prepared.ok) {
      expect(prepared.call).toEqual({
        action: "receive",
        input: {
          commandId: "00000000-0000-4000-8000-000000000001",
          commandVersion: 1,
          occurredOn: today,
          organizationId,
          quantity: 10,
          unitCost: "12.50",
          variantId,
        },
      });
      expect(prepared.state.submission.phase).toBe("submitting");
      expect(isStockLocked(prepared.state)).toBe(true);
    }
  });

  it("sends the count with expectedVersion and an optional valuation", () => {
    const state = confirming(
      filled(
        "count",
        { ...countFields, valuationUnitCost: "4,25" },
        unknownCostTarget
      )
    );
    const prepared = prepareStockSubmission({
      createId: ids(),
      organizationId,
      state,
    });
    expect(prepared.ok && prepared.call).toMatchObject({
      action: "count",
      input: {
        expectedVersion: 3,
        physicalQuantity: 7,
        valuationUnitCost: "4.25",
        variantId,
      },
    });
  });

  it("sends the write-off with the structured reason and note", () => {
    const prepared = prepareStockSubmission({
      createId: ids(),
      organizationId,
      state: confirming(
        filled("write_off", {
          quantity: "2",
          reasonCode: "other",
          reasonNote: " caixa molhada ",
        })
      ),
    });
    expect(prepared.ok && prepared.call).toMatchObject({
      action: "write_off",
      input: {
        quantity: 2,
        reasonCode: "other",
        reasonNote: "caixa molhada",
      },
    });
  });

  it("refuses to start from editing, while in flight or after success", () => {
    const editing = filled("receive", receiveFields);
    expect(
      prepareStockSubmission({
        createId: ids(),
        organizationId,
        state: editing,
      }).ok
    ).toBe(false);
    const first = prepareStockSubmission({
      createId: ids(),
      organizationId,
      state: confirming(editing),
    });
    expect(first.ok).toBe(true);
    expect(
      prepareStockSubmission({
        createId: ids(),
        organizationId,
        state: first.state,
      }).ok
    ).toBe(false);
  });

  it("reuses the command ID for an identical repeat and renews it after an edit", () => {
    const createId = ids();
    const first = prepareStockSubmission({
      createId,
      organizationId,
      state: confirming(filled("write_off", writeOffFields)),
    });
    if (!first.ok) {
      throw new Error("expected a prepared command");
    }
    // A definite failure that is not about the command ID keeps the attempt.
    const failed = stockFailed(first.state, {
      code: "CONFLICT",
      data: { reason: "insufficient_stock" },
    });
    expect(failed.step).toBe("editing");
    const repeat = prepareStockSubmission({
      createId,
      organizationId,
      state: confirming(failed),
    });
    expect(repeat.ok && repeat.call.input.commandId).toBe(
      first.call.input.commandId
    );
    // Editing the quantity makes a different payload: a new command ID.
    const edited = confirming(editStockField(failed, "quantity", "1"));
    const changed = prepareStockSubmission({
      createId,
      organizationId,
      state: edited,
    });
    expect(changed.ok && changed.call.input.commandId).not.toBe(
      first.call.input.commandId
    );
  });

  it("does not lock after a definite rejection and shows the reason", () => {
    const first = prepareStockSubmission({
      createId: ids(),
      organizationId,
      state: confirming(filled("write_off", writeOffFields)),
    });
    const failed = stockFailed(first.state, {
      code: "CONFLICT",
      data: { reason: "insufficient_stock" },
    });
    expect(failed.submission).toMatchObject({
      failure: { refreshBalance: true, unknownOutcome: false },
      phase: "failed",
    });
    expect(isStockLocked(failed)).toBe(false);
    expect(canCloseStock(failed)).toBe(true);
  });

  it("drops the attempt when the server says the command ID was reused", () => {
    const createId = ids();
    const first = prepareStockSubmission({
      createId,
      organizationId,
      state: confirming(filled("receive", receiveFields)),
    });
    const failed = stockFailed(first.state, {
      code: "CONFLICT",
      data: { reason: "stock_command_conflict" },
    });
    expect(failed.attempt).toBeNull();
    const next = prepareStockSubmission({
      createId,
      organizationId,
      state: confirming(failed),
    });
    expect(next.ok && next.call.input.commandId).not.toBe(
      first.ok && first.call.input.commandId
    );
  });

  it("locks on an unknown outcome, retries with the same command ID, then succeeds", () => {
    const createId = ids();
    const first = prepareStockSubmission({
      createId,
      organizationId,
      state: confirming(filled("receive", receiveFields)),
    });
    if (!first.ok) {
      throw new Error("expected a prepared command");
    }
    const locked = stockFailed(first.state, new TypeError("Failed to fetch"));
    expect(locked.submission.phase).toBe("locked");
    expect(canCloseStock(locked)).toBe(false);
    expect(editStockField(locked, "quantity", "1")).toBe(locked);
    expect(stockSubmitLabel(locked)).toBe("Tentar novamente (seguro)");

    const retry = prepareStockSubmission({
      createId,
      organizationId,
      state: locked,
    });
    expect(retry.ok && retry.call.input.commandId).toBe(
      first.call.input.commandId
    );
    expect(retry.state.submission.phase).toBe("submitting");
  });

  it("treats a 5xx like an unknown outcome", () => {
    const first = prepareStockSubmission({
      createId: ids(),
      organizationId,
      state: confirming(filled("write_off", writeOffFields)),
    });
    expect(
      stockFailed(first.state, { code: "SERVICE_UNAVAILABLE" }).submission.phase
    ).toBe("locked");
    expect(
      stockFailed(first.state, { code: "INTERNAL_SERVER_ERROR" }).submission
        .phase
    ).toBe("locked");
  });

  it("discards a locked attempt only after a second, explicit confirmation", () => {
    const first = prepareStockSubmission({
      createId: ids(),
      organizationId,
      state: confirming(filled("receive", receiveFields)),
    });
    const locked = stockFailed(first.state, new TypeError("offline"));
    expect(discardLockedStock(locked)).toBeNull();
    const asking = requestDiscardStock(locked);
    expect(asking.submission).toMatchObject({ confirmingDiscard: true });
    expect(cancelDiscardStock(asking).submission).toMatchObject({
      confirmingDiscard: false,
    });
    const fresh = discardLockedStock(asking);
    expect(fresh).not.toBeNull();
    expect(fresh?.attempt).toBeNull();
    expect(fresh?.draft).toMatchObject({ quantity: "" });
    expect(fresh?.submission.phase).toBe("idle");
  });

  it("records the balance the server returned and describes each result", () => {
    const run = (action: StockAction, fields: Record<string, string>) => {
      const prepared = prepareStockSubmission({
        createId: ids(),
        organizationId,
        state: confirming(filled(action, fields)),
      });
      if (!prepared.ok) {
        throw new Error("expected a prepared command");
      }
      return prepared.state;
    };
    const result = (quantity: number, replayed = false): StockResult => ({
      balance: {
        movingAverageCost: "11.000000",
        quantity,
        variantId,
        version: 4,
      },
      replayed,
    });

    const received = stockSucceeded(run("receive", receiveFields), result(15));
    expect(received.submission).toMatchObject({
      message: expect.stringContaining("Saldo atual: 15 unidades"),
      phase: "success",
      replayed: false,
    });
    expect(received.target).toMatchObject({ quantity: 15, version: 4 });
    expect(received.attempt).toBeNull();
    expect(canCloseStock(received)).toBe(true);
    expect(isStockLocked(received)).toBe(true);

    expect(
      stockSucceeded(run("count", countFields), result(7)).submission
    ).toMatchObject({ message: expect.stringContaining("+2 unidades") });
    expect(
      stockSucceeded(run("count", { physicalQuantity: "5" }), result(5))
        .submission
    ).toMatchObject({ message: expect.stringContaining("sem diferença") });
    expect(
      stockSucceeded(run("write_off", writeOffFields), result(3)).submission
    ).toMatchObject({ message: expect.stringContaining("Baixa registrada") });
    expect(
      stockSucceeded(run("receive", receiveFields), result(15, true)).submission
    ).toMatchObject({
      message: expect.stringContaining("Nada foi duplicado"),
      replayed: true,
    });
  });

  it("applies a fresher balance to the target without losing the draft", () => {
    const state = confirming(filled("write_off", writeOffFields));
    const next = retargetStock(state, {
      movingAverageCost: "10.000000",
      quantity: 1,
      variantId,
      version: 9,
    });
    expect(next.target).toMatchObject({ quantity: 1, version: 9 });
    expect(next.draft).toEqual(state.draft);
    expect(next.step).toBe("editing");
    expect(
      retargetStock(state, {
        movingAverageCost: null,
        quantity: 1,
        variantId: "other",
        version: 1,
      })
    ).toBe(state);
  });
});

describe("mapStockError", () => {
  const cases: [
    string,
    string,
    string,
    Partial<ReturnType<typeof mapStockError>>,
  ][] = [
    [
      "CONFLICT",
      "insufficient_stock",
      "Estoque insuficiente",
      { refreshBalance: true },
    ],
    ["CONFLICT", "inventory_quantity_limit", "2.147.483.647", {}],
    [
      "CONFLICT",
      "inventory_cost_unavailable",
      "custo conhecido",
      { refreshBalance: true },
    ],
    [
      "CONFLICT",
      "stock_command_conflict",
      "outro conteúdo",
      { discardAttempt: true },
    ],
    [
      "CONFLICT",
      "inventory_version_conflict",
      "saldo mudou",
      { discardAttempt: true, refreshBalance: true },
    ],
    ["CONFLICT", "product_deleted", "removido", { reloadList: true }],
    [
      "NOT_FOUND",
      "inventory_variant_not_found",
      "não existe mais",
      { reloadList: true },
    ],
    [
      "NOT_FOUND",
      "product_variant_not_found",
      "não existe mais",
      { reloadList: true },
    ],
    ["NOT_FOUND", "product_not_found", "não existe mais", { reloadList: true }],
    ["BAD_REQUEST", "invalid_unit_cost", "6 casas decimais", {}],
    ["BAD_REQUEST", "inventory_cost_limit", "18 dígitos", {}],
    ["BAD_REQUEST", "invalid_inventory_count_input", "valoração", {}],
    ["BAD_REQUEST", "invalid_receive_stock_input", "validação", {}],
    ["BAD_REQUEST", "invalid_write_off_stock_input", "validação", {}],
    ["BAD_REQUEST", "invalid_stock_movement", "validação", {}],
    [
      "BAD_REQUEST",
      "unsupported_receive_stock_command_version",
      "Recarregue",
      {},
    ],
    [
      "BAD_REQUEST",
      "unsupported_inventory_count_command_version",
      "Recarregue",
      {},
    ],
    [
      "BAD_REQUEST",
      "unsupported_write_off_stock_command_version",
      "Recarregue",
      {},
    ],
  ];

  it.each(cases)(
    "%s / %s answers in Portuguese and never locks",
    (code, reason, text, flags) => {
      const failure = mapStockError("receive", { code, data: { reason } });
      expect(failure.message).toContain(text);
      expect(failure.reason).toBe(reason);
      expect(failure.unknownOutcome).toBe(false);
      expect(failure).toMatchObject(flags);
    }
  );

  it("falls back to the oRPC code when there is no known reason", () => {
    expect(mapStockError("count", { code: "UNAUTHORIZED" }).message).toContain(
      "sessão"
    );
    expect(mapStockError("count", { code: "FORBIDDEN" }).message).toContain(
      "permissão"
    );
    expect(mapStockError("count", { code: "BAD_REQUEST" }).message).toContain(
      "recusou"
    );
    expect(mapStockError("count", { code: "NOT_FOUND" })).toMatchObject({
      reloadList: true,
    });
    expect(
      mapStockError("count", { code: "CONFLICT", data: { reason: "x_new" } })
    ).toMatchObject({ reason: "x_new", refreshBalance: true });
  });

  it("only trusts the reason of a 400, 404 or 409", () => {
    expect(
      mapStockError("count", {
        code: "FORBIDDEN",
        data: { reason: "insufficient_stock" },
      }).reason
    ).toBeNull();
  });

  it("names the operation when the outcome is unknown", () => {
    expect(mapStockError("receive", new TypeError("x"))).toMatchObject({
      message: expect.stringContaining("o recebimento foi registrado"),
      unknownOutcome: true,
    });
    expect(
      mapStockError("count", { code: "INTERNAL_SERVER_ERROR" }).message
    ).toContain("a contagem foi registrada");
    expect(mapStockError("write_off", { code: "TIMEOUT" }).message).toContain(
      "a baixa foi registrado"
    );
  });
});

describe("summaries", () => {
  it("previews a receipt with the resulting balance and average cost", () => {
    const state = filled("receive", receiveFields);
    const { body } = validateStockDraft(state.draft, target, today);
    if (!body) {
      throw new Error("expected a valid body");
    }
    const lines = stockSummary(body, target);
    const byLabel = Object.fromEntries(
      lines.map((line) => [line.label, line.value])
    );
    expect(byLabel.Variante).toBe("Camiseta Polaris — Azul / M");
    expect(byLabel["Quantidade recebida"]).toBe("+10 unidades");
    expect(byLabel["Custo unitário"]).toBe("R$ 12,50");
    expect(byLabel["Data do recebimento"]).toBe("13/10/2026");
    expect(byLabel["Saldo depois"]).toBe("15 unidades (hoje 5)");
    // (5 x 10,00 + 10 x 12,50) / 15 = 11,666667
    expect(byLabel["Custo médio previsto"]).toContain("R$ 11,666667");
  });

  it("previews a count with the difference and a still-unknown cost", () => {
    const state = filled("count", { physicalQuantity: "2" }, unknownCostTarget);
    const { body } = validateStockDraft(state.draft, unknownCostTarget, today);
    if (!body) {
      throw new Error("expected a valid body");
    }
    const byLabel = Object.fromEntries(
      stockSummary(body, unknownCostTarget).map((line) => [
        line.label,
        line.value,
      ])
    );
    expect(byLabel.Diferença).toBe("−3 unidades");
    expect(byLabel["Quantidade contada"]).toBe("2 unidades");
    expect(byLabel.Custo).toContain("desconhecido");
  });

  it("previews a write-off with reason, note and the balance after", () => {
    const state = filled("write_off", {
      quantity: "1",
      reasonCode: "other",
      reasonNote: "caixa molhada",
    });
    const { body } = validateStockDraft(state.draft, target, today);
    if (!body) {
      throw new Error("expected a valid body");
    }
    const byLabel = Object.fromEntries(
      stockSummary(body, target).map((line) => [line.label, line.value])
    );
    expect(byLabel["Quantidade baixada"]).toBe("−1 unidade");
    expect(byLabel.Motivo).toBe("Outro (descreva)");
    expect(byLabel.Observação).toBe("caixa molhada");
    expect(byLabel["Saldo depois"]).toBe("4 unidades (hoje 5)");
  });

  it("states the consequence of each action", () => {
    expect(stockConsequence("receive")).toContain("custo médio");
    expect(stockConsequence("count")).toContain("histórico");
    expect(stockConsequence("write_off")).toContain("nem cria despesa");
  });
});
