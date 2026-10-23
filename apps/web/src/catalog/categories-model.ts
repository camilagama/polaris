import {
  type CategoryReadModel,
  categoryNameCodePointLength,
} from "@polaris/contracts";
import { legalAcceptanceMessage } from "../lib/rpc-error";

export type CategoryListStatus = "active" | "archived" | "deleted";
export type CategoryAction = "archive" | "delete" | "restore";

export const STATUS_OPTIONS: ReadonlyArray<
  readonly [CategoryListStatus, string]
> = [
  ["active", "Ativas"],
  ["archived", "Arquivadas"],
  ["deleted", "Removidas"],
];

export const STATUS_LABELS: Record<CategoryReadModel["status"], string> = {
  active: "Ativa",
  archived: "Arquivada",
  deleted: "Removida",
};

const MAX_CATEGORY_NAME = 100;
export const NAME_TOO_LONG =
  "O nome da categoria deve ter no máximo 100 caracteres.";

export const EMPTY_TEXT: Record<CategoryListStatus, string> = {
  active: "Nenhuma categoria ativa. Adicione a primeira do catálogo.",
  archived: "Não há categorias arquivadas.",
  deleted: "Não há categorias removidas.",
};

export function isCategoryListStatus(
  value: string
): value is CategoryListStatus {
  return value === "active" || value === "archived" || value === "deleted";
}

export function categoryNameIsTooLong(name: string): boolean {
  return categoryNameCodePointLength(name) > MAX_CATEGORY_NAME;
}

export function categoryNameCountLabel(name: string): string {
  const count = categoryNameCodePointLength(name);
  return count > MAX_CATEGORY_NAME
    ? `Limite de ${MAX_CATEGORY_NAME} caracteres excedido (${count}).`
    : `${count}/${MAX_CATEGORY_NAME} caracteres`;
}

function rpcErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const { code } = error as { code?: unknown };
  return typeof code === "string" ? code : undefined;
}

export type CategoryFailure = CategoryAction | "create" | "rename";

/** What the screen says when a call fails: `undefined` is the failure of reading the list. */
export function categoryErrorMessage(
  error: unknown,
  action?: CategoryFailure
): string {
  const unaccepted = legalAcceptanceMessage(
    error,
    action === undefined ? "as categorias" : undefined
  );
  if (unaccepted !== undefined) {
    return unaccepted;
  }
  const code = rpcErrorCode(error);
  if (code === "UNAUTHORIZED") {
    return action === undefined
      ? "Não foi possível carregar as categorias."
      : "A categoria não foi alterada.";
  }
  if (code === "FORBIDDEN") {
    return "Sua conta não tem acesso a esta organização ou ação.";
  }
  if (code === "CONFLICT" && (action === "create" || action === "rename")) {
    return "Já existe uma categoria com esse nome nesta organização.";
  }
  if (code === "CONFLICT" && action === "restore") {
    return "Categorias removidas não podem ser restauradas.";
  }
  if (code === "CONFLICT" && action === "delete") {
    return "Desvincule os produtos desta categoria antes de removê-la.";
  }
  if (code === "CONFLICT") {
    return "O estado da categoria mudou. Atualize a lista e tente novamente.";
  }
  if (code === "NOT_FOUND") {
    return "A categoria não existe mais nesta organização.";
  }
  if (code === "SERVICE_UNAVAILABLE") {
    return "O catálogo está temporariamente indisponível. Tente novamente.";
  }
  return "Não foi possível concluir a operação. Tente novamente.";
}

/** The notice of an action that went through. */
export function categoryActionNotice(
  action: CategoryAction,
  name: string,
  changed: boolean
): string {
  if (!changed) {
    return `A categoria “${name}” já estava nesse estado.`;
  }
  switch (action) {
    case "archive":
      return `Categoria “${name}” arquivada.`;
    case "delete":
      return `Categoria “${name}” removida; o registro de histórico foi preservado.`;
    default:
      return `Categoria “${name}” restaurada.`;
  }
}
