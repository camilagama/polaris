import { describe, expect, it } from "vitest";
import { type ExpenseAction, expenseErrorMessage } from "./expense-errors";

const WRITES: readonly ExpenseAction[] = [
  "category-archive",
  "category-create",
  "category-rename",
  "category-restore",
  "restore",
  "rule-archive",
  "rule-restore",
  "rule-save",
  "save",
  "void",
];

const busy = { code: "SERVICE_UNAVAILABLE", data: { reason: "server_busy" } };

describe("expenseErrorMessage com o 503", () => {
  it("toda escrita diz que pode ter sido salva e não convida a repetir", () => {
    for (const action of WRITES) {
      const message = expenseErrorMessage(busy, action);
      expect(message).toBe(
        "A alteração não foi confirmada. Pode ter sido salva: confira antes de repetir."
      );
      expect(message).not.toContain("Tente novamente");
      expect(expenseErrorMessage({ code: "SERVICE_UNAVAILABLE" }, action)).toBe(
        message
      );
    }
  });

  it("as leituras mantêm o texto de antes", () => {
    for (const action of ["load", "rule-load"] as const) {
      expect(expenseErrorMessage(busy, action)).toBe(
        "As despesas estão temporariamente indisponíveis. Tente novamente."
      );
    }
  });

  it("um 503 com outro motivo também é dúvida de escrita, e a leitura mantém o texto dela", () => {
    const other = { code: "SERVICE_UNAVAILABLE", data: { reason: "other" } };
    for (const action of WRITES) {
      expect(expenseErrorMessage(other, action)).toBe(
        "A alteração não foi confirmada. Pode ter sido salva: confira antes de repetir."
      );
    }
    for (const action of ["load", "rule-load"] as const) {
      expect(expenseErrorMessage(other, action)).toBe(
        "As despesas estão temporariamente indisponíveis. Tente novamente."
      );
    }
  });

  it("o corte da plataforma mantém o texto próprio", () => {
    expect(
      expenseErrorMessage(
        {
          code: "SERVICE_UNAVAILABLE",
          data: { reason: "platform_cut" },
          status: 503,
        },
        "save"
      )
    ).toContain("O servidor está ocupado");
  });
});
