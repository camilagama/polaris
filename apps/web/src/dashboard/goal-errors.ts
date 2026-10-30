import {
  commonFailureMessage,
  rpcErrorCode,
  rpcErrorReason,
} from "../lib/rpc-error";
import { isLimitReached } from "../subscription/limit-help-model";

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

/** The plan's limit of goals in progress refused the new one (L5 of the corte 1.6): never "try again". */
export const GOAL_LIMIT_REACHED =
  "Seu plano chegou ao limite de metas em andamento. Nada foi criado.";

/**
 * Said after the limit only when a goal in progress or paused can be cancelled: a cancelled goal frees its place, a
 * goal paused by the plan still takes one (T-3 of the corte 1.6).
 */
export const GOAL_LIMIT_CANCEL_HINT = "Cancele uma meta para abrir lugar.";

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
  const common = commonFailureMessage(error, READ_SUBJECTS[action], {
    directWrite: READ_SUBJECTS[action] === undefined,
  });
  if (common !== undefined) {
    return common;
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
  if (action === "create" && isLimitReached(error)) {
    return GOAL_LIMIT_REACHED;
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
