import { rpcErrorCode } from "../lib/rpc-error";

export type ExpenseAction =
  | "category-archive"
  | "category-create"
  | "category-rename"
  | "category-restore"
  | "load"
  | "restore"
  | "rule-archive"
  | "rule-load"
  | "rule-restore"
  | "rule-save"
  | "save"
  | "void";

type ErrorSubject = "category" | "expense" | "rule";

function subjectOf(action: ExpenseAction): ErrorSubject {
  if (action.startsWith("category-")) {
    return "category";
  }
  return action.startsWith("rule-") ? "rule" : "expense";
}

function badRequestMessage(action: ExpenseAction): string | null {
  if (action === "save") {
    return "Confira o valor, a descrição e a data de competência. A data precisa estar entre 2000 e um ano à frente.";
  }
  if (action === "rule-save") {
    return "Confira o valor, a descrição e as datas. O início precisa estar entre 2000 e um ano à frente, e o fim não pode ser antes do início.";
  }
  if (action === "category-create" || action === "category-rename") {
    return "Informe um nome de categoria com até 100 caracteres.";
  }
  return null;
}

function conflictMessage(action: ExpenseAction): string {
  if (action === "category-create" || action === "category-rename") {
    return "Já existe uma categoria com esse nome, ou ela mudou em outra solicitação. A lista foi atualizada.";
  }
  if (action === "save") {
    return "Esta despesa mudou em outra solicitação, foi anulada ou a categoria escolhida não está mais disponível. Os dados foram recarregados; abra a despesa de novo para editar.";
  }
  if (action === "rule-save") {
    return "Esta despesa recorrente mudou em outra solicitação, ou a categoria escolhida não está mais disponível. Os dados foram recarregados; abra a recorrência de novo para editar.";
  }
  if (action === "restore") {
    return "A despesa mudou em outra solicitação. A lista foi atualizada.";
  }
  const subject = subjectOf(action);
  if (subject === "category") {
    return "A categoria mudou em outra solicitação. A lista foi atualizada.";
  }
  if (subject === "rule") {
    return "A despesa recorrente mudou em outra solicitação. A lista foi atualizada.";
  }
  return "A despesa mudou em outra solicitação. A lista foi atualizada.";
}

function notFoundMessage(action: ExpenseAction): string {
  const subject = subjectOf(action);
  if (subject === "category") {
    return "A categoria não existe mais nesta organização.";
  }
  return subject === "rule"
    ? "A despesa recorrente não existe mais nesta organização."
    : "A despesa não existe mais nesta organização.";
}

function fallbackMessage(action: ExpenseAction): string {
  if (action === "load") {
    return "Não foi possível carregar as despesas. Tente novamente.";
  }
  if (action === "rule-load") {
    return "Não foi possível carregar as despesas recorrentes. Tente novamente.";
  }
  return "Não foi possível concluir a operação. Tente novamente.";
}

/** Portuguese text for a failed expense, expense rule or expense category request. */
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
    return notFoundMessage(action);
  }
  if (code === "SERVICE_UNAVAILABLE") {
    return "As despesas estão temporariamente indisponíveis. Tente novamente.";
  }
  return fallbackMessage(action);
}
