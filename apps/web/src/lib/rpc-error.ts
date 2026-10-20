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
    return "Sua conta não tem acesso a esta organização ou ação.";
  }
  return `Não foi possível carregar ${subject}. Tente novamente.`;
}
