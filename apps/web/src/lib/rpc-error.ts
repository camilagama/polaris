import { isNoAnswer } from "./connection";

/** The oRPC error code (BAD_REQUEST, CONFLICT, ...), when the error has one. */
export function rpcErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const { code } = error as { code?: unknown };
  return typeof code === "string" ? code : undefined;
}

/** The stable domain code the server sends in `error.data.reason`. */
export function rpcErrorReason(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("data" in error)) {
    return undefined;
  }
  const { data } = error as { data?: unknown };
  if (typeof data !== "object" || data === null || !("reason" in data)) {
    return undefined;
  }
  const { reason } = data as { reason?: unknown };
  return typeof reason === "string" ? reason : undefined;
}

/**
 * The server refused the call because the user has not accepted the versions in force of the Terms of
 * Use and of the Privacy Policy (ADR 0100). It is a FORBIDDEN with its own reason, and it is NOT a refused
 * session: nothing local is dropped, the queue waits, and the screen offers `/aceite`.
 */
export function isLegalAcceptanceRefusal(error: unknown): boolean {
  return (
    rpcErrorCode(error) === "FORBIDDEN" &&
    rpcErrorReason(error) === "legal_acceptance_required"
  );
}

const LEGAL_ACCEPTANCE_MISSING =
  "falta aceitar os Termos de Uso e a Política de Privacidade.";

/** Text of a write refused for the missing legal acceptance. */
export const legalAcceptanceWriteMessage = `Não foi feito: ${LEGAL_ACCEPTANCE_MISSING}`;

/**
 * Shared by every screen error mapper, called before the generic FORBIDDEN one: the refusal for the missing
 * legal acceptance is not a lack of permission, so it must not read as "sua conta não tem acesso". With a
 * `subject` it is a failed read ("Não foi possível carregar {subject}: ..."); without, a failed write.
 * Undefined when the error is not that refusal.
 */
export function legalAcceptanceMessage(
  error: unknown,
  subject?: string
): string | undefined {
  if (!isLegalAcceptanceRefusal(error)) {
    return undefined;
  }
  return subject === undefined
    ? legalAcceptanceWriteMessage
    : `Não foi possível carregar ${subject}: ${LEGAL_ACCEPTANCE_MISSING}`;
}

const definiteCodes = new Set([
  "BAD_REQUEST",
  "CONFLICT",
  "FORBIDDEN",
  "NOT_FOUND",
  "UNAUTHORIZED",
]);

/**
 * True when the server answered definitively (a 4xx): the command did not take
 * effect. Network failures, 5xx and anything unrecognized may have taken
 * effect, so callers must treat them as an unknown outcome.
 */
export function isDefiniteRpcRejection(error: unknown): boolean {
  const code = rpcErrorCode(error);
  return code !== undefined && definiteCodes.has(code);
}

/**
 * The call got no answer from the Worker: no network, a timeout, or a response that was not the Worker's
 * (a captive portal, a proxy). Never a refusal: nothing about the session or the lease follows from it.
 */
export function isConnectionFailure(error: unknown): boolean {
  return isNoAnswer(error);
}

/**
 * A change whose answer the connection cut: it may have been saved, so the text never says it was not. The
 * screen reads again when the connection returns, and never sends the change again by itself.
 */
export const CHANGE_OUTCOME_UNKNOWN =
  "A conexão caiu antes da resposta. Não sabemos se a alteração foi salva. Quando a internet voltar, a tela é atualizada: confira antes de tentar de novo.";

/** Message for a failed read, by the oRPC code alone. */
export function readErrorMessage(error: unknown, subject: string): string {
  const code = rpcErrorCode(error);
  // the session notice says the rest; here only what did not happen
  if (code === "UNAUTHORIZED") {
    return `Não foi possível carregar ${subject}.`;
  }
  const unaccepted = legalAcceptanceMessage(error, subject);
  if (unaccepted !== undefined) {
    return unaccepted;
  }
  if (code === "FORBIDDEN") {
    return "Sua conta não tem acesso a esta loja ou a esta ação.";
  }
  if (isConnectionFailure(error)) {
    return `Não foi possível carregar ${subject}: a conexão falhou. Tente novamente.`;
  }
  return `Não foi possível carregar ${subject}. Tente novamente.`;
}

/** The `data.reason` of the 503 the router gives an unexpected fault: "try again" (`unexpectedRpcError`). */
const TRANSIENT_REASON = "server_busy";

/**
 * A READ that failed in a way another try may fix: no answer (`isNoAnswer`, which includes a response without the
 * Worker's mark), `SERVICE_UNAVAILABLE` with no reason or with the transient one the server gives an unexpected fault
 * (`server_busy`; one with another reason, like `billing_not_configured`, is not tried again), or a 5xx with no
 * reason of its own: the 500 of an error nobody named, and the page the runtime or Cloudflare answers for a Worker it
 * killed (the CPU limit, 1102, "code had hung": `server_failed` in `connection.ts`), which oRPC reads as an error of
 * the status it carries (502, 503, 52x...). A 4xx is the server's answer: trying again says the same. A 429 above
 * all: the tab waits for its `Retry-After` (`read-gate.ts`), and the screen says so at once.
 */
export function isTransientReadFailure(error: unknown): boolean {
  if (isNoAnswer(error)) {
    return true;
  }
  const reason = rpcErrorReason(error);
  if (rpcErrorCode(error) === "SERVICE_UNAVAILABLE") {
    return reason === undefined || reason === TRANSIENT_REASON;
  }
  const { status } = (error ?? {}) as { status?: unknown };
  return typeof status === "number" && status >= 500 && reason === undefined;
}
