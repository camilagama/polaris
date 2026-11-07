import type { CustomerReadModel } from "@polaris/contracts";
import { searchKey } from "../catalog/product-search-model";
import {
  CHANGE_FAULT_UNKNOWN,
  commonFailureMessage,
  legalAcceptanceMessage,
  rpcErrorCode,
} from "../lib/rpc-error";
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

const MOBILE_OR_LANDLINE = /^(\d\d)(\d{4,5})(\d{4})$/;

/**
 * The phone as the list shows it: 11 digits as "(11) 90000-0003", 10 as "(11) 3000-0003". Any other size, or
 * anything with more than digits (typed with its own marks), stays as it was typed.
 */
export function formatCustomerPhone(phone: string): string {
  return phone.replace(MOBILE_OR_LANDLINE, "($1) $2-$3");
}

const NOT_DIGIT = /\D/g;
const PHONE_TYPED = /^[\d\s().+-]+$/;
/** "55" before a DDD and 8 or 9 digits: a phone pasted with the country code, kept here without it. */
const BRAZIL_PREFIXED = /^55(\d{10,11})$/;

const TYPED_COUNTRY_CODE = /^\+55/;

/**
 * A typed "+55" is the country code whatever follows it, so a partial "+55 11" looks for "11". Without the "+", 55 is
 * a real area code (RS) and only a full phone of 12 or 13 digits loses it.
 */
function withoutCountryCode(typed: string): string {
  const digits = typed.replace(NOT_DIGIT, "");
  if (TYPED_COUNTRY_CODE.test(typed.trim())) {
    return digits.slice(2);
  }
  return BRAZIL_PREFIXED.exec(digits)?.[1] ?? digits;
}

/**
 * The customers whose name, phone or e-mail has the typed text (an empty text keeps them all), in the order they
 * came. The name and the e-mail ignore accents and case; a query made of digits and phone marks compares digits only,
 * so "(11) 9000", "119000" and "11 9000" find the same customer.
 */
export function filterCustomers<
  T extends Pick<CustomerReadModel, "email" | "name" | "phone">,
>(customers: readonly T[], query: string): T[] {
  const key = searchKey(query);
  if (key === "") {
    return [...customers];
  }
  // only a query typed as a phone compares digits: "Loja 2" is a name, not the phone digit 2
  const digits = PHONE_TYPED.test(query.trim())
    ? withoutCountryCode(query)
    : "";
  return customers.filter(
    (customer) =>
      searchKey(customer.name).includes(key) ||
      (customer.email !== null && searchKey(customer.email).includes(key)) ||
      (digits !== "" &&
        customer.phone !== null &&
        customer.phone.replace(NOT_DIGIT, "").includes(digits))
  );
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
  // the duplicate check is a read: a cut of it is no write that may have been saved
  const common =
    action === "duplicate-check"
      ? legalAcceptanceMessage(error)
      : commonFailureMessage(
          error,
          action === "load" ? "os clientes" : undefined,
          { directWrite: action !== "load" }
        );
  if (common !== undefined) {
    return common;
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
    return action === "load"
      ? "A lista de clientes está temporariamente indisponível. Tente novamente."
      : CHANGE_FAULT_UNKNOWN;
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
