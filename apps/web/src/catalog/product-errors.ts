import {
  legalAcceptanceMessage,
  rpcErrorCode,
  rpcErrorReason,
} from "../lib/rpc-error";

/** The same product named again with other data than the first try, which was saved: the list shows the saved one. */
const PRODUCT_ALREADY_CREATED =
  "Este produto já foi cadastrado, com outros dados. Veja a lista e confira antes de cadastrar de novo.";

export function isProductAlreadyCreated(error: unknown): boolean {
  return (
    rpcErrorCode(error) === "CONFLICT" &&
    rpcErrorReason(error) === "product_create_conflict"
  );
}

export type ProductAction = "archive" | "restore";

/** What the person is told when a product call fails; no action means the list could not be read. */
export function productErrorMessage(
  error: unknown,
  action?: ProductAction | "create" | "update"
): string {
  const unaccepted = legalAcceptanceMessage(
    error,
    action === undefined ? "os produtos" : undefined
  );
  if (unaccepted !== undefined) {
    return unaccepted;
  }
  const code = rpcErrorCode(error);
  if (code === "UNAUTHORIZED") {
    return action === undefined
      ? "Não foi possível carregar os produtos."
      : "O produto não foi alterado.";
  }
  if (code === "FORBIDDEN") {
    return "Sua conta não tem acesso a esta loja ou a esta ação.";
  }
  if (code === "BAD_REQUEST") {
    return "Informe um nome de produto válido.";
  }
  if (code === "NOT_FOUND") {
    return "O produto não existe mais nesta loja.";
  }
  if (isProductAlreadyCreated(error)) {
    return PRODUCT_ALREADY_CREATED;
  }
  if (code === "CONFLICT" && action === "create") {
    return "A categoria selecionada não está mais disponível. Atualize a lista e tente novamente.";
  }
  if (code === "CONFLICT" && action === "update") {
    return "A categoria pode ter sido arquivada ou o produto mudou. Atualize a lista e tente novamente.";
  }
  if (code === "CONFLICT") {
    return "O produto mudou em outra solicitação. Atualize a lista e tente novamente.";
  }
  if (code === "SERVICE_UNAVAILABLE") {
    return "O catálogo está temporariamente indisponível. Tente novamente.";
  }
  return "Não foi possível concluir a operação. Tente novamente.";
}
