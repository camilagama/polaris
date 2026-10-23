import { describe, expect, it } from "vitest";
import { NoWorkerAnswerError } from "./connection";
import {
  isConnectionFailure,
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

describe("a call that got no answer from the Worker", () => {
  it("is a connection failure for a network error, no Worker answer, a timeout, an abort or a cause of those", () => {
    expect(isConnectionFailure(new TypeError("Failed to fetch"))).toBe(true);
    expect(isConnectionFailure(new NoWorkerAnswerError("intercepted"))).toBe(
      true
    );
    expect(
      isConnectionFailure(new DOMException("timeout", "TimeoutError"))
    ).toBe(true);
    expect(isConnectionFailure(new DOMException("aborted", "AbortError"))).toBe(
      true
    );
    expect(
      isConnectionFailure(
        new Error("wrapper", {
          cause: new Error("middle", {
            cause: new TypeError("Failed to fetch"),
          }),
        })
      )
    ).toBe(true);
  });

  it("is not one for an answer of the Worker or for any other error", () => {
    expect(isConnectionFailure({ code: "UNAUTHORIZED" })).toBe(false);
    expect(isConnectionFailure(new Error("boom"))).toBe(false);
    expect(isConnectionFailure(null)).toBe(false);
    expect(isConnectionFailure("Failed to fetch")).toBe(false);
    // a TypeError that carries an oRPC code is an answer, not a failed fetch
    expect(
      isConnectionFailure(
        Object.assign(new TypeError("x"), { code: "INTERNAL_SERVER_ERROR" })
      )
    ).toBe(false);
  });

  it("is said in a failed read as a connection that failed", () => {
    expect(
      readErrorMessage(new TypeError("Failed to fetch"), "o estoque")
    ).toBe(
      "Não foi possível carregar o estoque: a conexão falhou. Tente novamente."
    );
    expect(
      readErrorMessage(new NoWorkerAnswerError("unproven"), "o estoque")
    ).toBe(
      "Não foi possível carregar o estoque: a conexão falhou. Tente novamente."
    );
  });
});
