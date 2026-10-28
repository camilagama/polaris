import { describe, expect, it } from "vitest";
import { NoWorkerAnswerError } from "./connection";
import {
  CHANGE_CUT_BY_SERVER,
  isConnectionFailure,
  isDefiniteRpcRejection,
  isLegalAcceptanceRefusal,
  isPlatformCut,
  readErrorMessage,
  rpcErrorCode,
  rpcErrorReason,
  serverCutWriteMessage,
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
      "PAYLOAD_TOO_LARGE",
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

const BLAMES_THE_NETWORK = /conexão|internet/;

describe("a call the server got and died on (the regime of the Free plan)", () => {
  const platform503 = Object.assign(new Error("cut"), {
    code: "SERVICE_UNAVAILABLE",
    status: 503,
  });

  it("is the platform's 5xx with no reason, or the router's 503 server_busy; never no answer, never a 4xx", () => {
    expect(isPlatformCut(platform503)).toBe(true);
    expect(
      isPlatformCut(
        Object.assign(new Error("bad gateway"), {
          code: "BAD_GATEWAY",
          status: 502,
        })
      )
    ).toBe(true);
    expect(
      isPlatformCut({
        code: "SERVICE_UNAVAILABLE",
        data: { reason: "server_busy" },
        status: 503,
      })
    ).toBe(true);
    expect(
      isPlatformCut({
        code: "SERVICE_UNAVAILABLE",
        data: { reason: "billing_not_configured" },
        status: 503,
      })
    ).toBe(false);
    expect(isPlatformCut(new TypeError("Failed to fetch"))).toBe(false);
    expect(isPlatformCut(new NoWorkerAnswerError("unproven"))).toBe(false);
    expect(isPlatformCut({ code: "TOO_MANY_REQUESTS", status: 429 })).toBe(
      false
    );
    expect(isPlatformCut({ code: "CONFLICT", status: 409 })).toBe(false);
  });

  it("is said in a write sent at once as a server that did not confirm, never as the internet", () => {
    expect(serverCutWriteMessage(platform503)).toBe(CHANGE_CUT_BY_SERVER);
    expect(CHANGE_CUT_BY_SERVER).toBe(
      "O servidor está ocupado e não confirmou. Pode ter sido salvo: confira em 1 minuto antes de repetir."
    );
    expect(CHANGE_CUT_BY_SERVER).not.toMatch(BLAMES_THE_NETWORK);
    expect(
      serverCutWriteMessage(new TypeError("Failed to fetch"))
    ).toBeUndefined();
    expect(serverCutWriteMessage({ code: "BAD_REQUEST" })).toBeUndefined();
  });
});
