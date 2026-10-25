import { isNoAnswer } from "../lib/connection";
import { legalAcceptanceMessage, rpcErrorCode } from "../lib/rpc-error";

/** What the screen says for a period that has no copy on the device and cannot be read without a connection (AC-16). */
const NO_INTERNET_NO_COPY =
  "Sem internet e sem números guardados neste aparelho.";
const NO_INTERNET_FOR_PERIOD = "Este período só abre com internet.";

/**
 * Portuguese text for a failed period result request. `copyKept` says whether this period is one the device keeps a
 * copy of (a month): without a connection a month says it has no copy, any other period says it opens only online.
 */
export function periodSummaryErrorMessage(
  error: unknown,
  copyKept = true
): string {
  const unaccepted = legalAcceptanceMessage(error, "o resultado");
  if (unaccepted !== undefined) {
    return unaccepted;
  }
  if (isNoAnswer(error)) {
    return copyKept ? NO_INTERNET_NO_COPY : NO_INTERNET_FOR_PERIOD;
  }
  const code = rpcErrorCode(error);
  // the session notice says the rest; here only what did not happen
  if (code === "UNAUTHORIZED") {
    return "Não foi possível carregar o resultado.";
  }
  if (code === "FORBIDDEN") {
    return "Sua conta não tem acesso ao resultado desta loja.";
  }
  if (code === "BAD_REQUEST") {
    return "Não foi possível calcular o resultado deste período. Escolha outro período.";
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
