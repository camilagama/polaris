import { describe, expect, it } from "vitest";
import {
  isDefiniteRpcRejection,
  isLegalAcceptanceRefusal,
  readErrorMessage,
  rpcErrorCode,
  rpcErrorReason,
} from "./rpc-error";

describe("rpc error helpers", () => {
  it("reads the oRPC code and the domain reason only when well formed", () => {
    expect(rpcErrorCode({ code: "CONFLICT" })).toBe("CONFLICT");
    expect(rpcErrorCode({ code: 409 })).toBeUndefined();
    expect(rpcErrorCode(new TypeError("Failed to fetch"))).toBeUndefined();
    expect(rpcErrorCode(null)).toBeUndefined();
    expect(rpcErrorReason({ data: { reason: "insufficient_stock" } })).toBe(
      "insufficient_stock"
    );
    expect(rpcErrorReason({ data: { reason: 1 } })).toBeUndefined();
    expect(rpcErrorReason({ data: null })).toBeUndefined();
    expect(rpcErrorReason({})).toBeUndefined();
  });

  it("treats 4xx codes as definite and everything else as unknown", () => {
    for (const code of [
      "BAD_REQUEST",
      "CONFLICT",
      "FORBIDDEN",
      "NOT_FOUND",
      "UNAUTHORIZED",
    ]) {
      expect(isDefiniteRpcRejection({ code })).toBe(true);
    }
    for (const code of ["INTERNAL_SERVER_ERROR", "SERVICE_UNAVAILABLE", "X"]) {
      expect(isDefiniteRpcRejection({ code })).toBe(false);
    }
    expect(isDefiniteRpcRejection(new TypeError("Failed to fetch"))).toBe(
      false
    );
  });

  it("explains failed reads in Portuguese without leaking details", () => {
    // only what did not happen: the sentence about the session is the notice's alone
    expect(readErrorMessage({ code: "UNAUTHORIZED" }, "o estoque")).toBe(
      "Não foi possível carregar o estoque."
    );
    expect(readErrorMessage({ code: "FORBIDDEN" }, "o estoque")).toContain(
      "acesso"
    );
    expect(readErrorMessage(new Error("boom"), "o estoque")).toBe(
      "Não foi possível carregar o estoque. Tente novamente."
    );
  });
});

describe("the refusal for lack of the legal acceptance", () => {
  const refusal = {
    code: "FORBIDDEN",
    data: { reason: "legal_acceptance_required" },
    status: 403,
  };

  it("is a FORBIDDEN with its own reason, and nothing else", () => {
    expect(isLegalAcceptanceRefusal(refusal)).toBe(true);
    expect(isLegalAcceptanceRefusal({ code: "FORBIDDEN" })).toBe(false);
    expect(
      isLegalAcceptanceRefusal({
        code: "FORBIDDEN",
        data: { reason: "other" },
      })
    ).toBe(false);
    expect(
      isLegalAcceptanceRefusal({
        code: "UNAUTHORIZED",
        data: { reason: "legal_acceptance_required" },
      })
    ).toBe(false);
    expect(isLegalAcceptanceRefusal(new TypeError("Failed to fetch"))).toBe(
      false
    );
    expect(isLegalAcceptanceRefusal(null)).toBe(false);
  });

  it("is a definite rejection, and a read says what is missing", () => {
    expect(isDefiniteRpcRejection(refusal)).toBe(true);
    const message = readErrorMessage(refusal, "o estoque");
    expect(message).toContain("Termos de Uso");
    expect(message).toContain("Política de Privacidade");
    expect(message).not.toContain("organização");
  });
});
