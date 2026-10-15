import { describe, expect, it } from "vitest";
import {
  periodSummaryErrorMessage,
  periodSummaryMayUseCopy,
} from "./dashboard-errors";

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

describe("periodSummaryMayUseCopy", () => {
  it("allows the copy when the server could not answer", () => {
    expect(periodSummaryMayUseCopy(new TypeError("Failed to fetch"))).toBe(
      true
    );
    expect(periodSummaryMayUseCopy({ code: "SERVICE_UNAVAILABLE" })).toBe(true);
    expect(periodSummaryMayUseCopy({ code: "INTERNAL_SERVER_ERROR" })).toBe(
      true
    );
    expect(periodSummaryMayUseCopy({ code: "BAD_GATEWAY" })).toBe(true);
    expect(periodSummaryMayUseCopy({ code: "GATEWAY_TIMEOUT" })).toBe(true);
  });

  it("never lets the copy contradict an answer of the server", () => {
    for (const code of [
      "UNAUTHORIZED",
      "FORBIDDEN",
      "BAD_REQUEST",
      "NOT_FOUND",
      "CONFLICT",
      "TOO_MANY_REQUESTS",
    ]) {
      expect(periodSummaryMayUseCopy({ code })).toBe(false);
    }
  });
});
