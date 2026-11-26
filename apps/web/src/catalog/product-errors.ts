import { isLimitReached } from "../subscription/limit-help-model";
import {
  CHANGE_FAULT_UNKNOWN,
  commonFailureMessage,
  isConnectionFailure,
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

export type ProductAction = "archive" | "restore" | "delete";

/** A 503 of a read keeps its text; a direct write may have been saved, so it never invites a second try. */
function unavailableMessage(action: string | undefined): string {
  return action === undefined
    ? "O catálogo está temporariamente indisponível. Tente novamente."
    : CHANGE_FAULT_UNKNOWN;
}

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
    return unavailableMessage(action);
  }
  return "Não foi possível concluir a operação. Tente novamente.";
}

/** What the dialog of "Excluir produto" says of a refusal, and what the screen does besides saying it. */
export interface ProductDeleteRefusal {
  /** The balance is not zero: the message carries the way to the stock. */
  toStock: boolean;
  /** The list may be out of date (the product changed or left): it is read again. */
  reread: boolean;
  text: string;
}

const TOO_SOON = "daqui a pouco";

/** The time the hour's ceiling opens again, rounded up to the minute so it never says a time earlier than the real one. */
function releaseTime(retryAfterSeconds: unknown, now: Date): string {
  if (
    typeof retryAfterSeconds !== "number" ||
    !Number.isFinite(retryAfterSeconds)
  ) {
    return TOO_SOON;
  }
  const minute = 60_000;
  const at = new Date(
    Math.ceil(
      (now.getTime() + Math.max(1, retryAfterSeconds) * 1000) / minute
    ) * minute
  );
  return new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(at);
}

function retryAfterOf(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("data" in error)) {
    return undefined;
  }
  const { data } = error as { data?: { retryAfterSeconds?: unknown } | null };
  return data?.retryAfterSeconds;
}

/** The balance of the product when the server refused for it, or `null` when it could not be read. */
function stockText(balance: number | null): string {
  return balance === null ? "estoque" : `${balance} em estoque`;
}

/**
 * The refusal of `product.delete`, in the words of the dialog. `balance` is the quantity in stock the screen read after
 * a refusal for the balance (the server does not send it); `now` is the clock the hour of the ceiling counts from.
 */
export function productDeleteRefusal(
  error: unknown,
  name: string,
  balance: number | null,
  now: Date
): ProductDeleteRefusal {
  const code = rpcErrorCode(error);
  const reason = rpcErrorReason(error);
  if (code === "CONFLICT" && reason === "product_stock_not_empty") {
    return {
      reread: false,
      text: `Não dá para excluir “${name}” porque ele ainda tem ${stockText(balance)}. Zere o estoque na baixa ou na contagem e tente de novo.`,
      toStock: true,
    };
  }
  if (
    code === "TOO_MANY_REQUESTS" &&
    reason === "product_delete_rate_limited"
  ) {
    const when = releaseTime(retryAfterOf(error), now);
    return {
      reread: false,
      text:
        when === TOO_SOON
          ? "Você excluiu muitos produtos agora. Tente de novo daqui a pouco."
          : `Você excluiu muitos produtos agora. Tente de novo às ${when}.`,
      toStock: false,
    };
  }
  if (
    code === "CONFLICT" &&
    (reason === "product_version_conflict" ||
      reason === "product_lifecycle_conflict")
  ) {
    return {
      reread: true,
      text: `“${name}” mudou em outro aparelho. Atualize a lista e tente de novo.`,
      toStock: false,
    };
  }
  if (isConnectionFailure(error)) {
    return { reread: true, text: CHANGE_FAULT_UNKNOWN, toStock: false };
  }
  return {
    reread: true,
    text: productErrorMessage(error, "delete"),
    toStock: false,
  };
}
