import type { CustomerReadModel } from "@polaris/contracts";
import { legalAcceptanceMessage, rpcErrorCode } from "../lib/rpc-error";
import type { PendingCustomer } from "../offline/customer-create";
import type { PendingCustomerUpdate } from "../offline/customer-update";
import type { CustomerDraft } from "./customer-draft";

export type CustomerListStatus = "active" | "archived";
export type CustomerAction = "anonymize" | "archive" | "restore";
export type CustomerFailure =
  | CustomerAction
  | "duplicate-check"
  | "load"
  | "save";

export const STATUS_OPTIONS: ReadonlyArray<
  readonly [CustomerListStatus, string]
> = [
  ["active", "Ativos"],
  ["archived", "Arquivados"],
];

export const CONTACT_REQUIRED_TEXT =
  "Informe ao menos um telefone ou email para o cliente.";
export const NAME_REQUIRED_TEXT = "Informe o nome do cliente.";

const ONLY_DIGITS = /^[0-9]+$/;

/**
 * The phone as the list shows it: 11 digits as "(11) 90000-0003", 10 as "(11) 3000-0003". Any other size, or
 * anything with more than digits (typed with its own marks), stays as it was typed.
 */
export function formatCustomerPhone(phone: string): string {
  const digits = phone.trim();
  if (!ONLY_DIGITS.test(digits)) {
    return phone;
  }
  if (digits.length === 11) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  }
  return phone;
}

export function hasCustomerContact(draft: CustomerDraft): boolean {
  return Boolean(draft.phone.trim() || draft.email.trim());
}

export function isCustomerListStatus(
  value: string
): value is CustomerListStatus {
  return value === "active" || value === "archived";
}

/** What did not happen, without the sentence about the session: the notice of the shell carries that one. */
function unauthorizedText(action?: CustomerFailure): string {
  switch (action) {
    case "anonymize":
      return "O cliente não foi anonimizado.";
    case "archive":
      return "O cliente não foi arquivado.";
    case "restore":
      return "O cliente não foi restaurado.";
    case "load":
      return "Não foi possível carregar os clientes.";
    case "duplicate-check":
      return "Não foi possível conferir se o cliente já existe.";
    default:
      return "O cliente não foi salvo.";
  }
}

export function customerErrorMessage(
  error: unknown,
  action?: CustomerFailure
): string {
  if (
    error instanceof Error &&
    error.message === "customer_has_pending_command"
  ) {
    return "Este cliente já tem uma alteração ou um cadastro aguardando envio. Espere o envio ou resolva em Pendências.";
  }
  const unaccepted = legalAcceptanceMessage(
    error,
    action === "load" ? "os clientes" : undefined
  );
  if (unaccepted !== undefined) {
    return unaccepted;
  }
  const code = rpcErrorCode(error);
  if (code === "UNAUTHORIZED") {
    return unauthorizedText(action);
  }
  if (code === "FORBIDDEN") {
    return "Sua conta não tem acesso a esta loja ou a esta ação.";
  }
  if (
    code === "BAD_REQUEST" &&
    (action === "save" || action === "duplicate-check")
  ) {
    return "Confira o nome e informe ao menos um telefone ou email válido.";
  }
  if (code === "CONFLICT") {
    return "Os dados do cliente mudaram em outra solicitação. Atualize a lista e tente novamente.";
  }
  if (code === "NOT_FOUND") {
    return "O cliente não existe mais nesta loja.";
  }
  if (code === "SERVICE_UNAVAILABLE" && action === "duplicate-check") {
    return "Não foi possível verificar possíveis clientes repetidos. Tente novamente antes de salvar.";
  }
  if (code === "SERVICE_UNAVAILABLE") {
    return "A lista de clientes está temporariamente indisponível. Tente novamente.";
  }
  if (action === "load") {
    return "Não foi possível carregar os clientes. Tente novamente.";
  }
  return "Não foi possível salvar o cliente. Revise os campos e tente novamente.";
}

export function customerStatusLabel(customer: CustomerReadModel): string {
  if (customer.anonymizedAt !== null) {
    return "Anonimizado";
  }
  return customer.status === "active" ? "Ativo" : "Arquivado";
}

/**
 * Nothing can be done to a customer the server has not confirmed, nor on top of
 * an edit it has not confirmed (the next one would be made from a version the
 * server has not produced yet).
 */
export function lockedReasonFor(
  syncState: PendingCustomer | undefined,
  updateState: PendingCustomerUpdate | undefined
): string | null {
  if (syncState) {
    return "Disponível depois que o servidor confirmar o cadastro.";
  }
  if (updateState) {
    return updateState.state === "rejected"
      ? "A alteração foi recusada. Resolva em Pendências antes de alterar de novo."
      : "Disponível depois que o servidor confirmar a alteração.";
  }
  return null;
}

export function syncStateLabel(
  syncState: PendingCustomer | PendingCustomerUpdate,
  isUpdate: boolean
): string {
  if (syncState.state === "rejected") {
    return isUpdate
      ? "Alteração recusada pelo servidor"
      : "Recusado pelo servidor";
  }
  if (syncState.state === "sending") {
    return isUpdate ? "Enviando alteração…" : "Enviando…";
  }
  return isUpdate ? "Alteração aguardando envio" : "Aguardando envio";
}
