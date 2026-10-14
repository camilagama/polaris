import { rpcErrorCode } from "../lib/rpc-error";

export type ExpenseAction =
  | "category-archive"
  | "category-create"
  | "category-rename"
  | "category-restore"
  | "load"
  | "restore"
  | "save"
  | "void";

type ErrorSubject = "category" | "expense";

function subjectOf(action: ExpenseAction): ErrorSubject {
  return action.startsWith("category-") ? "category" : "expense";
}

function badRequestMessage(action: ExpenseAction): string | null {
  if (action === "save") {
    return "Confira o valor, a descrição e a data de competência. A data precisa estar entre 2000 e um ano à frente.";
  }
  if (action === "category-create" || action === "category-rename") {
    return "Informe um nome de categoria com até 100 caracteres.";
  }
  return null;
}

function conflictMessage(action: ExpenseAction): string {
  if (action === "category-create" || action === "category-rename") {
    return "Já existe uma categoria com esse nome";
  }
  if (action === "save") {
    return "Esta despesa mudou em outra solicitação, foi anulada ou a categoria escolhida não está mais disponível. Os dados foram recarregados; abra a despesa de novo para editar.";
  }
  if (action === "restore") {
    return "A despesa mudou em outra solicitação ou a categoria dela não está mais disponível. A lista foi atualizada.";
  }
  if (subjectOf(action) === "category") {
    return "A categoria mudou em outra solicitação. A lista foi atualizada.";
  }
  return "A despesa mudou em outra solicitação. A lista foi atualizada.";
}

function fallbackMessage(action: ExpenseAction): string {
  if (action === "load") {
    return "Não foi possível carregar as despesas. Tente novamente.";
  }
  return "Não foi possível concluir a operação. Tente novamente.";
}

/** Portuguese text for a failed expense or expense category request. */
export function expenseErrorMessage(
  error: unknown,
  action: ExpenseAction
): string {
  const code = rpcErrorCode(error);
  if (code === "UNAUTHORIZED") {
    return "Sua sessão não está ativa. Entre novamente para acessar as despesas.";
  }
  if (code === "FORBIDDEN") {
    return "Sua conta não tem acesso a esta organização ou ação.";
  }
  if (code === "BAD_REQUEST") {
    return badRequestMessage(action) ?? fallbackMessage(action);
  }
  if (code === "CONFLICT") {
    return conflictMessage(action);
  }
  if (code === "NOT_FOUND") {
    return subjectOf(action) === "category"
      ? "A categoria não existe mais nesta organização."
      : "A despesa não existe mais nesta organização.";
  }
  if (code === "SERVICE_UNAVAILABLE") {
    return "As despesas estão temporariamente indisponíveis. Tente novamente.";
  }
  return fallbackMessage(action);
}
