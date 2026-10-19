import { rpcErrorCode } from "../lib/rpc-error";
import { SESSION_ENDED_MESSAGE } from "../lib/session-ended-text";

/** Portuguese text for a failed period result request. */
export function periodSummaryErrorMessage(error: unknown): string {
  const code = rpcErrorCode(error);
  if (code === "UNAUTHORIZED") {
    return SESSION_ENDED_MESSAGE;
  }
  if (code === "FORBIDDEN") {
    return "Sua conta não tem acesso ao resultado desta organização.";
  }
  if (code === "BAD_REQUEST") {
    return "Não foi possível calcular o resultado deste período. Escolha outro mês.";
  }
  if (code === "SERVICE_UNAVAILABLE") {
    return "O resultado está temporariamente indisponível. Tente novamente.";
  }
  return "Não foi possível carregar o resultado. Tente novamente.";
}

/** Codes of a server that is down or not answering in time (not one that answered "no"). */
const OUTAGE_CODES = new Set([
  "BAD_GATEWAY",
  "GATEWAY_TIMEOUT",
  "INTERNAL_SERVER_ERROR",
  "SERVICE_UNAVAILABLE",
]);

/**
 * True when the server could not answer (no network, or an outage), so the
 * device's copy of the month may stand in for it. A server that answered
 * (unauthorized, forbidden, invalid request, not found...) said something the
 * copy must never contradict.
 */
export function periodSummaryMayUseCopy(error: unknown): boolean {
  const code = rpcErrorCode(error);
  return code === undefined || OUTAGE_CODES.has(code);
}
