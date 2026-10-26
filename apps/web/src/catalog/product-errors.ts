import {
  legalAcceptanceMessage,
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

export function isProductLimitReached(error: unknown): boolean {
  return (
    rpcErrorCode(error) === "CONFLICT" &&
    rpcErrorReason(error) === "entitlement_limit_reached"
  );
}

/** For whom cannot change the plan: the same limit text, and who can (AC-10 of the corte 61b, stage 2). */
export const PRODUCT_LIMIT_ASK_OWNER =
  "Fale com o dono da loja para mudar o plano.";

/**
 * What goes with the limit text (stage 2 of the corte 61b, AC-10), only with the Assinatura on: "Conhecer o Pro" for
 * whom may open it (`billing:manage`) while the store has a bigger plan to see (Free, or Free over the limit); for
 * whom may not, the way to the owner; nothing on Pro, in a trial or a plan that could not be read.
 */
export type ProductLimitHelp = "ask_owner" | "upgrade" | null;

export function productLimitHelp(input: {
  billingSelfService: boolean;
  canManageBilling: boolean;
  /** The state `billing.readPlan` gave, or null when it was not read. */
  planState: string | null;
}): ProductLimitHelp {
  if (!input.billingSelfService) {
    return null;
  }
  if (!input.canManageBilling) {
    return "ask_owner";
  }
  return input.planState === "free" || input.planState === "free_over_limit"
    ? "upgrade"
    : null;
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
  if (action === "create" && isProductLimitReached(error)) {
    return PRODUCT_LIMIT_REACHED;
  }
  if (code === "CONFLICT" && action === "create") {
    const reason = rpcErrorReason(error);
    return reason !== undefined && CATEGORY_REASONS.has(reason)
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
