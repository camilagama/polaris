import { rpcErrorCode } from "../lib/rpc-error";

/** Portuguese text for a failed period result request. */
export function periodSummaryErrorMessage(error: unknown): string {
  const code = rpcErrorCode(error);
  if (code === "UNAUTHORIZED") {
    return "Sua sessão não está ativa. Entre novamente para ver o resultado.";
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
