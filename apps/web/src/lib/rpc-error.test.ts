import { describe, expect, it } from "vitest";
import { NoWorkerAnswerError } from "./connection";
import {
  CHANGE_CUT_BY_SERVER,
  CHANGE_FAULT_UNKNOWN,
  commonFailureMessage,
  isConnectionFailure,
  isDefiniteRpcRejection,
  isLegalAcceptanceRefusal,
  isOrganizationClosedRefusal,
  isPlatformCut,
  isTransientReadFailure,
  readErrorMessage,
  rpcErrorCode,
  rpcErrorReason,
  serverCutWriteMessage,
  unconfirmedWriteFaultMessage,
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

describe("the refusal for a closed organization", () => {
  it("is a FORBIDDEN with the reason organization_closed, and nothing else", () => {
    expect(
      isOrganizationClosedRefusal({
        code: "FORBIDDEN",
        data: { reason: "organization_closed" },
        status: 403,
      })
    ).toBe(true);
    expect(isOrganizationClosedRefusal({ code: "FORBIDDEN" })).toBe(false);
    expect(
      isOrganizationClosedRefusal({ code: "FORBIDDEN", data: undefined })
    ).toBe(false);
    expect(
      isOrganizationClosedRefusal({
        code: "FORBIDDEN",
        data: { reason: "legal_acceptance_required" },
      })
    ).toBe(false);
    expect(
      isOrganizationClosedRefusal({
        code: "UNAUTHORIZED",
        data: { reason: "organization_closed" },
      })
    ).toBe(false);
    expect(
      isOrganizationClosedRefusal({
        code: "CONFLICT",
        data: { reason: "organization_closed" },
      })
    ).toBe(false);
    expect(isOrganizationClosedRefusal(new TypeError("Failed to fetch"))).toBe(
      false
    );
    expect(isOrganizationClosedRefusal(null)).toBe(false);
  });

  it("is not the refusal for the legal acceptance", () => {
    expect(
      isLegalAcceptanceRefusal({
        code: "FORBIDDEN",
        data: { reason: "organization_closed" },
      })
    ).toBe(false);
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
const MAY_HAVE_BEEN_SAVED = /pode ter sido salvo/i;

describe("a call the platform killed (the regime of the Free plan)", () => {
  /** What oRPC gives for the platform's page of a Worker it killed: `connection.ts` names it `platform_cut`. */
  const platformCut = Object.assign(new Error("cut"), {
    code: "SERVICE_UNAVAILABLE",
    data: { reason: "platform_cut" },
    status: 503,
  });
  const workerBusy = Object.assign(new Error("busy"), {
    code: "SERVICE_UNAVAILABLE",
    data: { reason: "server_busy" },
    status: 503,
  });

  it("is only the platform's 5xx with no mark of the Worker; never the Worker's own 5xx, no answer or a 4xx", () => {
    expect(isPlatformCut(platformCut)).toBe(true);
    expect(isPlatformCut(workerBusy)).toBe(false);
    expect(
      isPlatformCut(
        Object.assign(new Error("bad gateway"), {
          code: "BAD_GATEWAY",
          status: 502,
        })
      )
    ).toBe(false);
    expect(isPlatformCut({ code: "INTERNAL_SERVER_ERROR", status: 500 })).toBe(
      false
    );
    expect(isPlatformCut(new TypeError("Failed to fetch"))).toBe(false);
    expect(isPlatformCut(new NoWorkerAnswerError("unproven"))).toBe(false);
    expect(
      isPlatformCut({
        code: "CONFLICT",
        data: { reason: "platform_cut" },
        status: 409,
      })
    ).toBe(false);
    expect(
      isPlatformCut({
        code: "SERVICE_UNAVAILABLE",
        data: { reason: "platform_cut" },
      })
    ).toBe(false);
    expect(isPlatformCut({ code: "TOO_MANY_REQUESTS", status: 429 })).toBe(
      false
    );
    expect(isPlatformCut({ code: "CONFLICT", status: 409 })).toBe(false);
  });

  it("is a read another try may fix, as the Worker's 503 server_busy still is", () => {
    expect(isTransientReadFailure(platformCut)).toBe(true);
    expect(
      isTransientReadFailure({
        code: "BAD_GATEWAY",
        data: { reason: "platform_cut" },
        status: 502,
      })
    ).toBe(true);
    expect(isTransientReadFailure(workerBusy)).toBe(true);
    expect(
      isTransientReadFailure({
        code: "SERVICE_UNAVAILABLE",
        data: { reason: "billing_not_configured" },
        status: 503,
      })
    ).toBe(false);
  });

  it("is said in a write sent at once as a server that did not confirm, never as the internet", () => {
    expect(serverCutWriteMessage(platformCut)).toBe(CHANGE_CUT_BY_SERVER);
    expect(CHANGE_CUT_BY_SERVER).toBe(
      "O servidor está ocupado e não confirmou. Pode ter sido salvo: confira em alguns minutos antes de repetir."
    );
    expect(CHANGE_CUT_BY_SERVER).not.toMatch(BLAMES_THE_NETWORK);
    expect(serverCutWriteMessage(workerBusy)).toBeUndefined();
    expect(
      serverCutWriteMessage(new TypeError("Failed to fetch"))
    ).toBeUndefined();
    expect(serverCutWriteMessage({ code: "BAD_REQUEST" })).toBeUndefined();
  });

  it("says 'pode ter sido salvo' only of a write, never of a read", () => {
    expect(commonFailureMessage(platformCut)).toBe(CHANGE_CUT_BY_SERVER);
    expect(commonFailureMessage(platformCut, "os produtos")).toBeUndefined();
    expect(readErrorMessage(platformCut, "os produtos")).not.toMatch(
      MAY_HAVE_BEEN_SAVED
    );
  });

  it("says a direct write that met the Worker's 503 may have been saved, only when the screen says it is one", () => {
    expect(CHANGE_FAULT_UNKNOWN).toBe(
      "A alteração não foi confirmada. Pode ter sido salva: confira antes de repetir."
    );
    expect(CHANGE_FAULT_UNKNOWN).not.toMatch(BLAMES_THE_NETWORK);
    expect(unconfirmedWriteFaultMessage(workerBusy)).toBe(CHANGE_FAULT_UNKNOWN);
    expect(
      unconfirmedWriteFaultMessage({ code: "SERVICE_UNAVAILABLE", status: 503 })
    ).toBe(CHANGE_FAULT_UNKNOWN);
    expect(
      commonFailureMessage(workerBusy, undefined, { directWrite: true })
    ).toBe(CHANGE_FAULT_UNKNOWN);
    expect(commonFailureMessage(workerBusy)).toBeUndefined();
    expect(
      commonFailureMessage(workerBusy, "os produtos", { directWrite: true })
    ).toBeUndefined();
    expect(
      commonFailureMessage(platformCut, undefined, { directWrite: true })
    ).toBe(CHANGE_CUT_BY_SERVER);
    expect(readErrorMessage(workerBusy, "os produtos")).toBe(
      "Não foi possível carregar os produtos. Tente novamente."
    );
  });

  it("is no unknown fault for another reason of the 503, for a 4xx or for no answer", () => {
    for (const error of [
      {
        code: "SERVICE_UNAVAILABLE",
        data: { reason: "billing_not_configured" },
      },
      { code: "CONFLICT" },
      { code: "INTERNAL_SERVER_ERROR" },
      new TypeError("Failed to fetch"),
    ]) {
      expect(unconfirmedWriteFaultMessage(error)).toBeUndefined();
    }
  });
});
