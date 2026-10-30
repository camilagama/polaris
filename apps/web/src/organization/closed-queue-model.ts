import type { ClosedStore } from "./closed-store-model";
import {
  QUEUE_CHECKING_TEXT,
  QUEUE_UNREADABLE_TEXT,
  type QueueCounts,
} from "./closure-model";

export const QUEUE_SECTION_TITLE = "Neste aparelho";
export const DISCARD_BUTTON = "Descartar o que não foi enviado…";
export const DISCARD_BACK = "Voltar";
export const DISCARD_CONFIRM = "Sim, descartar";
export const DISCARD_SENDING = "Descartando…";
export const DISCARD_DONE_TEXT = "Operações descartadas neste aparelho.";
export const DISCARD_UNREAD_TEXT =
  "Não foi possível conferir o que ficou neste aparelho. Recarregue a página para ver.";

/** What the device's queue holds for one store, by kind of operation; read from the disk, never from the server. */
export interface QueueKinds {
  others: number;
  registers: number;
  sales: number;
}

export type ClosedQueue =
  | { counts: QueueCounts; kind: "counted"; kinds: QueueKinds }
  | { kind: "unknown" }
  | { kind: "unreadable" };

export const DISCARD_NO_SESSION_TEXT =
  "Não foi possível descartar agora: não deu para confirmar a sua conta. Nada foi apagado. Confira a conexão e tente de novo.";

export type DiscardOutcome =
  | { kind: "done" }
  | { kind: "no_session" }
  | { kind: "left"; remaining: number }
  | { kind: "unread" };

const KNOWN_PHASES: ReadonlySet<string> = new Set([
  "closing",
  "closed",
  "deletion_scheduled",
  "deletable",
  "purged",
]);
const REGISTER_TYPES = /^(customer|product)\./;

export function emptyKinds(): QueueKinds {
  return { others: 0, registers: 0, sales: 0 };
}

export function kindOf(type: string): keyof QueueKinds {
  if (type === "sale.confirm") {
    return "sales";
  }
  return REGISTER_TYPES.test(type) ? "registers" : "others";
}

function queueTotal(counts: QueueCounts): number {
  return counts.pending + counts.sending + counts.rejected;
}

/**
 * Only the server's word that the undo is over (`canRecover` false) opens the discard: a clock past `recoverUntil`
 * does not, and a phase this device does not know reads as the window, because the undo would still send everything.
 */
export function discardOpen(store: ClosedStore): boolean {
  if (store.canRecover) {
    return false;
  }
  return KNOWN_PHASES.has(store.phase);
}

function operations(count: number): string {
  return count === 1 ? "1 operação" : `${count} operações`;
}

export function windowText(total: number): string {
  return total === 1
    ? "1 operação deste aparelho ainda não foi confirmada pelo servidor. Se você desfizer o encerramento, ela será enviada de novo."
    : `${total} operações deste aparelho ainda não foram confirmadas pelo servidor. Se você desfizer o encerramento, elas serão enviadas de novo.`;
}

function afterText(total: number): string {
  return total === 1
    ? "1 operação deste aparelho ficou sem confirmação do servidor e não será mais enviada: esta loja não volta. O que o servidor não confirmou não entra na cópia dos seus dados."
    : `${total} operações deste aparelho ficaram sem confirmação do servidor e não serão mais enviadas: esta loja não volta. O que o servidor não confirmou não entra na cópia dos seus dados.`;
}

export function discardTitle(total: number): string {
  return `Descartar ${operations(total)} deste aparelho?`;
}

function kindsList(kinds: QueueKinds): string {
  const parts: string[] = [];
  if (kinds.sales > 0) {
    parts.push("vendas");
  }
  if (kinds.registers > 0) {
    parts.push("cadastros");
  }
  if (kinds.others > 0) {
    parts.push(parts.length > 0 ? "outras operações" : "operações");
  }
  return parts.length > 1
    ? `${parts.slice(0, -1).join(", ")} e ${parts.at(-1)}`
    : (parts[0] ?? "operações");
}

/** Says "vendas" whenever one of the operations is a sale, and what is lost: the server never confirmed it. */
export function discardBody(kinds: QueueKinds): string {
  const lost =
    kinds.sales > 0
      ? "Vendas sem confirmação não estarão na cópia dos seus dados."
      : "O que não foi confirmado não estará na cópia dos seus dados.";
  return `O servidor não confirmou o que será descartado: ${kindsList(kinds)} deste aparelho. ${lost} Isso não tem volta.`;
}

export function leftText(remaining: number): string {
  const rest =
    remaining === 1
      ? "Restou 1 operação neste aparelho"
      : `Restaram ${remaining} operações neste aparelho`;
  return `Não foi possível descartar tudo. ${rest}. Nada mais foi apagado.`;
}

export function outcomeOf(after: ClosedQueue): DiscardOutcome {
  if (after.kind !== "counted") {
    return { kind: "unread" };
  }
  const remaining = queueTotal(after.counts);
  return remaining === 0 ? { kind: "done" } : { kind: "left", remaining };
}

export type QueueView =
  | { kind: "hidden" }
  | { kind: "reading"; text: string }
  | { kind: "unreadable"; text: string }
  | { kind: "window"; text: string }
  | { kind: "after"; text: string; total: number };

/**
 * What the card says of the queue. Nothing is ever said as "nothing to discard" while the queue is being read or
 * could not be: only a queue read as empty hides the card.
 */
export function queueView(queue: ClosedQueue, store: ClosedStore): QueueView {
  if (queue.kind === "unknown") {
    return { kind: "reading", text: QUEUE_CHECKING_TEXT };
  }
  if (queue.kind === "unreadable") {
    return { kind: "unreadable", text: QUEUE_UNREADABLE_TEXT };
  }
  const total = queueTotal(queue.counts);
  if (total === 0) {
    return { kind: "hidden" };
  }
  return discardOpen(store)
    ? { kind: "after", text: afterText(total), total }
    : { kind: "window", text: windowText(total) };
}
