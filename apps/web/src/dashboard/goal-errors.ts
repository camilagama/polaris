import {
  legalAcceptanceMessage,
  rpcErrorCode,
  rpcErrorReason,
} from "../lib/rpc-error";

export type GoalAction = "cancel" | "create" | "history" | "load" | "update";

const BAD_REQUEST_MESSAGES: Partial<Record<GoalAction, string>> = {
  create:
    "Confira o que a meta mede, o período e o alvo. O alvo precisa ser maior que zero, o período tem no máximo 366 dias e o início fica entre 2000 e um ano à frente.",
  update:
    "Confira o nome e o alvo. O alvo precisa ser maior que zero e o nome tem no máximo 100 caracteres.",
};

const CONFLICT_MESSAGES: Partial<Record<GoalAction, string>> = {
  cancel:
    "Esta meta mudou em outra solicitação ou já não está em andamento. A lista foi atualizada.",
  update:
    "Esta meta mudou em outra solicitação ou já não está em andamento, então não foi alterada. A lista foi atualizada; abra a meta de novo para editar.",
};

function fallbackMessage(action: GoalAction): string {
  if (action === "load") {
    return "Não foi possível carregar as metas. Tente novamente.";
  }
  if (action === "history") {
    return "Não foi possível carregar o histórico do alvo. Tente novamente.";
  }
  return "Não foi possível concluir a operação. Tente novamente.";
}

/** What each read action loads, for the text of the missing legal acceptance (the other actions are writes). */
const READ_SUBJECTS: Partial<Record<GoalAction, string>> = {
  history: "o histórico do alvo",
  load: "as metas",
};

/** Portuguese text for a failed goal request. */
export function goalErrorMessage(error: unknown, action: GoalAction): string {
  const unaccepted = legalAcceptanceMessage(error, READ_SUBJECTS[action]);
  if (unaccepted !== undefined) {
    return unaccepted;
  }
  const code = rpcErrorCode(error);
  if (code === "UNAUTHORIZED") {
    if (action === "load") {
      return "Não foi possível carregar as metas.";
    }
    return action === "history"
      ? "Não foi possível carregar o histórico do alvo."
      : "A meta não foi alterada.";
  }
  if (code === "FORBIDDEN") {
    return "Sua conta não tem acesso às metas desta loja.";
  }
  if (code === "BAD_REQUEST") {
    return BAD_REQUEST_MESSAGES[action] ?? fallbackMessage(action);
  }
  if (code === "CONFLICT") {
    if (rpcErrorReason(error) === "goal_paused_by_plan") {
      return "Seu plano permite menos metas em andamento do que você tem, então esta meta está pausada e não pode ser editada. Cancele-a ou aguarde o plano permitir.";
    }
    return CONFLICT_MESSAGES[action] ?? fallbackMessage(action);
  }
  if (code === "NOT_FOUND") {
    return "A meta não existe mais nesta loja.";
  }
  if (code === "SERVICE_UNAVAILABLE") {
    return "As metas estão temporariamente indisponíveis. Tente novamente.";
  }
  return fallbackMessage(action);
}
