import { describe, expect, it } from "vitest";
import { periodSummaryErrorMessage } from "./dashboard-errors";

describe("periodSummaryErrorMessage", () => {
  it("explains each code the server answers with", () => {
    expect(periodSummaryErrorMessage({ code: "UNAUTHORIZED" })).toContain(
      "sessão"
    );
    expect(periodSummaryErrorMessage({ code: "FORBIDDEN" })).toContain(
      "não tem acesso"
    );
    expect(periodSummaryErrorMessage({ code: "BAD_REQUEST" })).toContain(
      "Escolha outro mês"
    );
    expect(
      periodSummaryErrorMessage({ code: "SERVICE_UNAVAILABLE" })
    ).toContain("temporariamente indisponível");
  });

  it("falls back to a generic message for anything else", () => {
    const fallback = "Não foi possível carregar o resultado. Tente novamente.";
    expect(periodSummaryErrorMessage({ code: "INTERNAL_SERVER_ERROR" })).toBe(
      fallback
    );
    expect(periodSummaryErrorMessage(new Error("boom"))).toBe(fallback);
  });
});
