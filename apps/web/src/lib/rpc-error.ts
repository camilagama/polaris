import { isNoAnswer, PLATFORM_CUT_REASON } from "./connection";

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

/**
 * The Worker refused the body of the call for its size (`payload_too_large`, 413): oRPC reads the status as
 * `PAYLOAD_TOO_LARGE`. It is the answer of a size rule, not a failure of the server and not a refusal of the
 * command: the sync splits its batch.
 */
export function isPayloadTooLarge(error: unknown): boolean {
  return rpcErrorCode(error) === "PAYLOAD_TOO_LARGE";
}

const definiteCodes = new Set([
  "BAD_REQUEST",
  "CONFLICT",
  "FORBIDDEN",
  "NOT_FOUND",
  "PAYLOAD_TOO_LARGE",
  "UNAUTHORIZED",
]);

/**
 * True when the server answered definitively (a 4xx): the command did not take
 * effect. The 413 counts: the Worker answers it before the procedure runs, and a body cut while it is read
 * never reaches the procedure as a complete call. Network failures, 5xx and anything unrecognized may have taken
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
 * Worker's mark), the cut of the platform (`isPlatformCut`), `SERVICE_UNAVAILABLE` with no reason or with the
 * transient one the server gives an unexpected fault (`server_busy`; one with another reason, like
 * `billing_not_configured`, is not tried again), or a 5xx with no reason of its own (the 500 of an error nobody
 * named). A 4xx is the server's answer: trying again says the same. A 429 above all: the tab waits for its
 * `Retry-After` (`read-gate.ts`), and the screen says so at once.
 */
export function isTransientReadFailure(error: unknown): boolean {
  if (isNoAnswer(error) || isPlatformCut(error)) {
    return true;
  }
  const reason = rpcErrorReason(error);
  if (rpcErrorCode(error) === "SERVICE_UNAVAILABLE") {
    return reason === undefined || reason === TRANSIENT_REASON;
  }
  const { status } = (error ?? {}) as { status?: unknown };
  return typeof status === "number" && status >= 500 && reason === undefined;
}

/**
 * The platform killed the Worker on the call: the page Cloudflare answers with no mark of the Worker (the CPU limit
 * of the Free plan, 1102, "code had hung": `server_failed` in `connection.ts`, which gives it
 * `PLATFORM_CUT_REASON`). In the regime of the Free plan every call of the Worker dies like this for minutes,
 * whatever it is. Never an answer of the Worker itself, its 503 `server_busy` included: that one is a fault of the
 * call, which may be the same each time it goes. The reason is only ever born in the client (`connection.ts`) and
 * only on a 5xx, so a status below 500 is no cut whatever the reason says.
 */
export function isPlatformCut(error: unknown): boolean {
  const { status } = (error ?? {}) as { status?: unknown };
  return (
    rpcErrorReason(error) === PLATFORM_CUT_REASON &&
    typeof status === "number" &&
    status >= 500
  );
}

/**
 * A write sent at once (no queue) that the server cut: it may have been saved, so the text never says it was not, and
 * it blames no network. The screen never sends it again by itself (a write with no idempotency key may double).
 */
export const CHANGE_CUT_BY_SERVER =
  "O servidor está ocupado e não confirmou. Pode ter sido salvo: confira em alguns minutos antes de repetir.";

/** The text of a write the server cut (`isPlatformCut`); undefined for any other error. */
export function serverCutWriteMessage(error: unknown): string | undefined {
  return isPlatformCut(error) ? CHANGE_CUT_BY_SERVER : undefined;
}

/**
 * A direct write (no queue, no idempotency key) that met a 503. The Worker's own `server_busy` may come at the COMMIT
 * or after it, and a screen whose write mapper says every 503 of a write is this one (`unconfirmedWriteFaultMessage`
 * covers only `server_busy`) does the same for any reason: the change may be saved, so the text never says it was not
 * and never invites a second try, which could double it.
 */
export const CHANGE_FAULT_UNKNOWN =
  "A alteração não foi confirmada. Pode ter sido salva: confira antes de repetir.";

/** The text of a direct write the Worker answered with a 503 `server_busy` (or with no reason, as `isTransientReadFailure` also counts it: doubt is the safe side); undefined for any other error. */
export function unconfirmedWriteFaultMessage(
  error: unknown
): string | undefined {
  if (rpcErrorCode(error) !== "SERVICE_UNAVAILABLE") {
    return undefined;
  }
  const reason = rpcErrorReason(error);
  return reason === undefined || reason === TRANSIENT_REASON
    ? CHANGE_FAULT_UNKNOWN
    : undefined;
}

interface CommonFailureOptions {
  /** The call is a direct write: its 503 `server_busy` says the change may have been saved (`CHANGE_FAULT_UNKNOWN`). */
  directWrite?: boolean;
}

/**
 * What a screen says of a failed call before its own codes: the missing legal acceptance (`legalAcceptanceMessage`)
 * and, for a write (no `subject`), the server's cut (`serverCutWriteMessage`) and, when the screen says it is a direct
 * write, the 503 `server_busy` (`unconfirmedWriteFaultMessage`). Undefined for any other error.
 */
export function commonFailureMessage(
  error: unknown,
  subject?: string,
  options: CommonFailureOptions = {}
): string | undefined {
  const legal = legalAcceptanceMessage(error, subject);
  if (legal !== undefined || subject !== undefined) {
    return legal;
  }
  return (
    serverCutWriteMessage(error) ??
    (options.directWrite ? unconfirmedWriteFaultMessage(error) : undefined)
  );
}
