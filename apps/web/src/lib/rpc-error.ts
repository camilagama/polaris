import { SESSION_ENDED_MESSAGE } from "./session-ended-text";
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
  if (code === "UNAUTHORIZED") {
    return SESSION_ENDED_MESSAGE;
  }
  if (code === "FORBIDDEN") {
    return "Sua conta não tem acesso a esta organização ou ação.";
  }
  return `Não foi possível carregar ${subject}. Tente novamente.`;
}
