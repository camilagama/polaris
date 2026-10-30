import {
  CLOSURE_RECOVERY_WINDOW_DAYS,
  closureConfirmationMatches,
} from "@polaris/domain/organization/closure";
import { CLOSURE_DELETABLE_AFTER_DAYS } from "@polaris/domain/organization/closure-deadlines";
import {
  isConnectionFailure,
  isDefiniteRpcRejection,
  isPlatformCut,
  legalAcceptanceMessage,
  rpcErrorCode,
  rpcErrorReason,
} from "../lib/rpc-error";

export const CLOSE_SECTION_TITLE = "Encerrar a loja";
export const CLOSE_SECTION_TEXT =
  "Encerrar para de vez as vendas, o estoque e os cadastros desta loja. Você ainda pode baixar seus dados depois.";
export const CLOSE_OPEN_BUTTON = "Encerrar a loja";
export const CLOSE_CONFIRM_BUTTON = "Encerrar a loja";
export const CLOSE_SENDING_BUTTON = "Encerrando…";
export const CLOSE_BACK_BUTTON = "Voltar";
export const CLOSE_WARNINGS_INTRO = "Ao encerrar:";
export const OTHER_DEVICES_TEXT =
  "Se você usa o Polaris em outros aparelhos, abra-os com internet e envie o que estiver guardado antes de encerrar.";
export const NAME_MISSING_TEXT =
  "Digite o nome da loja como aparece acima para habilitar o botão.";
export const QUEUE_CHECKING_TEXT =
  "Conferindo as operações guardadas neste aparelho…";
export const QUEUE_UNREADABLE_TEXT =
  "Não foi possível conferir as operações guardadas neste aparelho. Recarregue a página e tente de novo.";
export const BILLING_ON_TEXT =
  "A renovação do plano é cancelada; o painel mostra quando foi confirmada.";
export const BILLING_OFF_TEXT =
  "A cobrança do plano não é cancelada por aqui. Cancele a renovação no provedor de pagamento.";

export const CLOSE_MISMATCH_TEXT =
  "O nome digitado não é o nome da loja. Nada foi encerrado.";
export const CLOSE_NOT_ACTIVE_TEXT =
  "Esta loja não está ativa e não pode ser encerrada agora. Nada foi encerrado.";
export const CLOSE_ALREADY_CLOSED_TEXT =
  "Esta loja já foi encerrada. Veja a loja encerrada.";
export const CLOSE_FORBIDDEN_TEXT =
  "Só o dono da loja pode encerrá-la. Nada foi encerrado.";
export const CLOSE_SESSION_TEXT =
  "Sua sessão terminou. Entre de novo para encerrar a loja. Nada foi encerrado.";
export const CLOSE_UNCONFIRMED_TEXT =
  "O encerramento não foi confirmado. A loja pode ter sido encerrada: veja a loja encerrada antes de tentar de novo.";
export const CLOSE_FAILED_TEXT =
  "Não foi possível encerrar a loja. Nada foi encerrado. Tente de novo.";

export function closeDialogTitle(storeName: string): string {
  return `Encerrar a loja ${storeName}`;
}

export function confirmationLabel(storeName: string): string {
  return `Para confirmar, digite o nome da loja: ${storeName}`;
}

/**
 * The fixed warnings, in order (ADR 0081): what stops at once, the days to undo, the days to download, that the data
 * may be deleted, the fiscal records, and the renewal. `billingSelfService` is the global flag `listMine` gives
 * (BILLING_SELF_SERVICE_ENABLED): on, the server asks the provider to cancel the renewal at the closure, and the panel
 * says when it was confirmed (a store whose provider Polaris does not cancel stays `not_handled`), so the text never
 * says it is cancelled already.
 */
export function closureWarnings(billingSelfService: boolean): string[] {
  return [
    "Vender, mexer no estoque e cadastrar param na hora. Os aparelhos perdem o acesso sem internet.",
    `Por ${CLOSURE_RECOVERY_WINDOW_DAYS} dias você pode desfazer o encerramento.`,
    `Por ${CLOSURE_DELETABLE_AFTER_DAYS} dias você ainda entra só para baixar seus dados: vendas, estoque, clientes, despesas, produtos e imagens.`,
    `Depois de ${CLOSURE_DELETABLE_AFTER_DAYS} dias, os dados da loja podem ser apagados e não dá para recuperar.`,
    "Guardar os documentos fiscais é responsabilidade sua. Baixe seus dados antes.",
    billingSelfService ? BILLING_ON_TEXT : BILLING_OFF_TEXT,
  ];
}

export interface QueueCounts {
  pending: number;
  rejected: number;
  sending: number;
}

export type QueueState =
  | { kind: "counted"; counts: QueueCounts }
  | { kind: "unknown" }
  | { kind: "unreadable" };

export interface QueueNotice {
  blocks: boolean;
  lines: string[];
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

export function queueNotice(queue: QueueState): QueueNotice {
  if (queue.kind === "unknown") {
    return { blocks: true, lines: [QUEUE_CHECKING_TEXT] };
  }
  if (queue.kind === "unreadable") {
    return { blocks: true, lines: [QUEUE_UNREADABLE_TEXT] };
  }
  const waiting = queue.counts.pending + queue.counts.sending;
  const { rejected } = queue.counts;
  const lines: string[] = [];
  if (waiting > 0) {
    lines.push(
      `Este aparelho guarda ${waiting} ${plural(waiting, "operação que ainda não foi enviada", "operações que ainda não foram enviadas")}. Envie antes de encerrar.`
    );
  }
  if (rejected > 0) {
    lines.push(
      `Este aparelho tem ${rejected} ${plural(rejected, "registro recusado", "registros recusados")}. Resolva em Precisa de ação antes de encerrar.`
    );
  }
  return { blocks: lines.length > 0, lines };
}

/** The typed name is the store's: case and surrounding spaces aside, as the server compares it. */
export function nameConfirmed(typed: string, storeName: string): boolean {
  return closureConfirmationMatches(typed, storeName);
}

export interface CloseGate {
  enabled: boolean;
  reason: "connection" | "queue" | "name" | null;
}

export function closeGate({
  online,
  queue,
  storeName,
  typed,
}: {
  online: boolean;
  queue: QueueState;
  storeName: string;
  typed: string;
}): CloseGate {
  const notice = queueNotice(queue);
  const named = nameConfirmed(typed, storeName);
  if (!online) {
    return { enabled: false, reason: "connection" };
  }
  if (notice.blocks) {
    return { enabled: false, reason: "queue" };
  }
  if (!named) {
    return { enabled: false, reason: "name" };
  }
  return { enabled: true, reason: null };
}

export interface CloseRefusal {
  panelLink: boolean;
  text: string;
}

/** Any 5xx: the Worker may have failed after the COMMIT, so the closure is in doubt whatever the reason says. */
function serverFault(error: unknown): boolean {
  const { status } = (error ?? {}) as { status?: unknown };
  return typeof status === "number" && status >= 500;
}

export function closeRefusal(error: unknown): CloseRefusal {
  if (
    isConnectionFailure(error) ||
    isPlatformCut(error) ||
    serverFault(error)
  ) {
    return { panelLink: true, text: CLOSE_UNCONFIRMED_TEXT };
  }
  const reason = rpcErrorReason(error);
  if (reason === "closure_confirmation_mismatch") {
    return { panelLink: false, text: CLOSE_MISMATCH_TEXT };
  }
  if (reason === "organization_not_active") {
    return { panelLink: false, text: CLOSE_NOT_ACTIVE_TEXT };
  }
  if (reason === "organization_closed") {
    return { panelLink: true, text: CLOSE_ALREADY_CLOSED_TEXT };
  }
  const unaccepted = legalAcceptanceMessage(error);
  if (unaccepted !== undefined) {
    return { panelLink: false, text: unaccepted };
  }
  const code = rpcErrorCode(error);
  if (code === "FORBIDDEN") {
    return { panelLink: false, text: CLOSE_FORBIDDEN_TEXT };
  }
  if (code === "UNAUTHORIZED") {
    return { panelLink: false, text: CLOSE_SESSION_TEXT };
  }
  return isDefiniteRpcRejection(error)
    ? { panelLink: false, text: CLOSE_FAILED_TEXT }
    : { panelLink: true, text: CLOSE_UNCONFIRMED_TEXT };
}
