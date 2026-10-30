import { isLimitReached } from "../subscription/limit-help-model";
import {
  commonFailureMessage,
  rpcErrorCode,
  rpcErrorReason,
} from "../lib/rpc-error";

/**
 * The same product named again with other data than the first try, which was saved: the list (under the veil of the
 * dialog, read again) shows the saved one.
 */
const PRODUCT_ALREADY_CREATED =
  "Este produto já foi cadastrado, com outros dados. Feche e confira na lista antes de cadastrar de novo.";

export function isProductAlreadyCreated(error: unknown): boolean {
  return (
    rpcErrorCode(error) === "CONFLICT" &&
    rpcErrorReason(error) === "product_create_conflict"
  );
}

/** The plan's active-variant limit refused the new product: the only limit the registration meets. No number, no key (the server sends none) and no way out the screen could not keep (archived still counts). */
export const PRODUCT_LIMIT_REACHED =
  "Seu plano chegou ao limite de variantes. Nada foi cadastrado.";

/** A refusal of the registration that the server could not name: it does not blame the category. */
const PRODUCT_CREATE_UNKNOWN_CONFLICT =
  "Não foi possível cadastrar o produto agora. Tente novamente.";

/** The reasons that say the chosen category cannot take a product. */
const CATEGORY_REASONS: ReadonlySet<string> = new Set([
  "product_category_unavailable",
  "category_deleted",
  "category_lifecycle_conflict",
]);

/** The registration was refused because of the chosen category: the form opens it, for another to be picked. */
export function isCategoryUnavailable(error: unknown): boolean {
  const reason = rpcErrorReason(error);
  return (
    rpcErrorCode(error) === "CONFLICT" &&
    reason !== undefined &&
    CATEGORY_REASONS.has(reason)
  );
}

export type ProductAction = "archive" | "restore";

/** What the person is told when a product call fails; no action means the list could not be read. */
export function productErrorMessage(
  error: unknown,
  action?: ProductAction | "create" | "update"
): string {
  const common = commonFailureMessage(
    error,
    action === undefined ? "os produtos" : undefined,
    { directWrite: action !== undefined }
  );
  if (common !== undefined) {
    return common;
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
  if (action === "create" && isLimitReached(error)) {
    return PRODUCT_LIMIT_REACHED;
  }
  if (code === "CONFLICT" && action === "create") {
    return isCategoryUnavailable(error)
      ? "A categoria selecionada não está mais disponível. Escolha outra em Mais detalhes e tente novamente."
      : PRODUCT_CREATE_UNKNOWN_CONFLICT;
  }
  if (code === "CONFLICT" && action === "update") {
    return "A categoria pode ter sido arquivada ou o produto mudou. Confira os dados e tente novamente.";
  }
  if (code === "CONFLICT") {
    return "O produto mudou em outra solicitação. Atualize a lista e tente novamente.";
  }
  if (code === "SERVICE_UNAVAILABLE") {
    return "O catálogo está temporariamente indisponível. Tente novamente.";
  }
  return "Não foi possível concluir a operação. Tente novamente.";
}
