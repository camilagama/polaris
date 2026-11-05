import { brasiliaDay } from "./format";

/**
 * The closed lists of a privacy case (ADR 0077) as the page offers them: each code of the domain's list, in its
 * order, with its words. The script imports nothing of the domain, so `src/ui/privacy-lists.test.ts` compares every
 * list here with `@polaris/domain/admin/privacy-case` and fails when a code is added, removed or reordered there.
 * A code the server returns that is not here is shown as unknown, never as a known one.
 */

/** The least a note must say when the reason is a legal retention; `src/ui/privacy-lists.test.ts` compares it with the domain's. */
export const MIN_LEGAL_RETENTION_NOTE_LENGTH = 10;

export type Choices = readonly (readonly [code: string, label: string])[];

export const REQUEST_TYPES: Choices = [
  ["access", "Acesso aos dados"],
  ["correction", "Correção"],
  ["deletion", "Exclusão"],
  ["portability", "Portabilidade"],
  ["objection", "Oposição"],
  ["restriction", "Limitação do uso"],
  ["other", "Outro"],
];

export const REQUESTER_KINDS: Choices = [
  ["data_subject", "Titular dos dados"],
  ["organization_owner", "Dono da loja"],
  ["authority", "Autoridade"],
  ["other", "Outro"],
];

export const CHANNELS: Choices = [
  ["email", "E-mail"],
  ["in_app", "Pelo app"],
  ["support_ticket", "Chamado de suporte"],
  ["other", "Outro"],
];

export const IDENTITY_STATUSES: Choices = [
  ["verified", "Confirmada"],
  ["failed", "Não confirmada"],
];

export const IDENTITY_METHODS: Choices = [
  ["authenticated_session", "Sessão autenticada no Polaris"],
  ["email_ownership", "Posse do e-mail"],
  ["owner_confirmation", "Confirmação do dono da loja"],
  ["document_review", "Documento conferido fora do Polaris, sem guardar"],
  ["other", "Outro"],
];

export const ROLES: Choices = [
  ["controller", "Controlador: o Polaris decide sobre o dado"],
  ["processor", "Operador: o Polaris só processa, pela loja"],
];

export const CATEGORIES: Choices = [
  ["account", "Conta"],
  ["authentication", "Entrada e sessões"],
  ["organization_profile", "Dados da loja"],
  ["customers", "Clientes da loja"],
  ["sales", "Vendas"],
  ["inventory_catalog", "Estoque e catálogo"],
  ["media", "Imagens"],
  ["billing", "Cobrança"],
  ["audit_logs", "Registros de auditoria"],
];

export const DECISIONS: Choices = [
  ["accept", "Aceitar"],
  ["partially_accept", "Aceitar em parte"],
  ["reject", "Recusar"],
  ["redirect_to_controller", "Encaminhar ao controlador (a loja)"],
];

export const DECISION_REASONS: Choices = [
  ["identity_not_verified", "Identidade não confirmada"],
  ["no_authority", "Quem pede não tem autoridade"],
  ["controller_is_reseller", "O controlador é a loja"],
  ["legal_retention", "Guarda por obrigação legal (diga a norma na nota)"],
  ["manifestly_unfounded", "Pedido sem fundamento"],
  ["not_personal_data", "Não é dado pessoal"],
  ["other", "Outro"],
];

export const ACTIONS: Choices = [
  ["customer_anonymized", "Cliente anonimizado"],
  ["organization_closed", "Loja encerrada"],
  ["export_delivered", "Exportação entregue"],
  ["purge_scheduled", "Purge agendado"],
  ["redirected_to_reseller", "Encaminhado à loja"],
  ["no_action_required", "Nada a fazer"],
  ["other", "Outro"],
];

/** The stages of the workflow, in order (`PRIVACY_STAGES`), as the list says where a case is. */
export const STAGES: Choices = [
  ["requested", "Falta a identidade"],
  ["identity_checked", "Falta o papel do Polaris"],
  ["role_determined", "Falta o escopo"],
  ["scoped", "Falta a decisão"],
  ["decided", "Decidido"],
  ["executed", "Ações registradas"],
  ["resolved", "Resolvido"],
];

/** The words of a code in a list; an unknown code is said to be unknown, with the code as text. */
export function labelOf(list: Choices, code: string | null): string {
  if (code === null) {
    return "—";
  }
  return list.find(([known]) => known === code)?.[1] ?? `desconhecido: ${code}`;
}

export function isCode(list: Choices, code: string): boolean {
  return list.some(([known]) => known === code);
}

const BRASILIA_DAY = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "America/Sao_Paulo",
  year: "numeric",
});
const DAY_MS = 86_400_000;

/** The calendar day of a moment in Brasília, as the UTC midnight of that day (a count of days, never a date shown). */
function dayNumber(moment: Date): number {
  const [year, month, day] = BRASILIA_DAY.format(moment).split("-").map(Number);
  return Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1) / DAY_MS;
}

export interface DueText {
  /** The due date as the server keeps it, dd/mm/aaaa in Brasília. */
  day: string;
  text: string;
  /** Two days or less, or past: said in words and set as a warning. */
  warn: boolean;
}

export const PROVISIONAL = "prazo provisório";

/**
 * How far the due date the server returned is, in words. The date is never computed here: it is the server's
 * `dueAt`; the case is said to be late by the server's `overdue`, or when that day is already past on the page's
 * clock (a page left open overnight). Only the count of calendar days between today in Brasília and that day is
 * taken, because the route returns the date and not the count.
 */
export function dueText(dueAt: string, overdue: boolean, now: Date): DueText {
  const due = new Date(dueAt);
  const day = brasiliaDay(dueAt);
  if (Number.isNaN(due.getTime())) {
    return { day, text: "prazo não lido", warn: true };
  }
  if (overdue) {
    return { day, text: `prazo vencido em ${day}`, warn: true };
  }
  const days = dayNumber(due) - dayNumber(now);
  if (days < 0) {
    return { day, text: `prazo vencido em ${day}`, warn: true };
  }
  if (days === 0) {
    return { day, text: "vence hoje", warn: true };
  }
  if (days <= 2) {
    return {
      day,
      text: days === 1 ? "vence em 1 dia" : `vence em ${days} dias`,
      warn: true,
    };
  }
  return { day, text: `faltam ${days} dias`, warn: false };
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The path of a privacy case's screen, or null when the server's ID is not a UUID (no link is made from it). */
export function privacyCasePath(id: unknown): string | null {
  return typeof id === "string" && UUID.test(id)
    ? `/privacidade/${id.toLowerCase()}`
    : null;
}

/**
 * Why the notice of D minus 7 days may be dismissed (`CLOSURE_NOTICE_DISMISSAL_REASONS`, ADR 0102): the closed list
 * the server accepts, in the domain's order. The code sent is always one of these; the server checks that the reason
 * fits the facts it keeps, and `src/ui/privacy-lists.test.ts` ties this list to the domain's.
 */
export const CLOSURE_NOTICE_DISMISSALS: Choices = [
  ["owner_account_deleted", "A conta do dono da loja foi apagada"],
  ["email_not_verified", "O e-mail do dono não foi verificado"],
  ["email_undeliverable", "O e-mail do dono recusa o aviso (não é entregável)"],
];

/**
 * The states of a store in which the server accepts reissuing or dismissing the notice of D minus 7 days
 * (`CLOSURE_NOTICE_ORGANIZATION_STATUSES`): the section is offered for these and not for another state the page knows.
 * `src/ui/closure-notice-statuses.test.ts` ties this list to the domain's and to the database function's.
 */
export const CLOSURE_NOTICE_ORGANIZATION_STATUSES: readonly string[] = [
  "closing",
  "closed",
  "purge_pending",
];

/**
 * The categories an accepted deletion must cover, exactly, for the purge to be scheduled under it
 * (`ORGANIZATION_PURGE_REQUIRED_SCOPE`): the screen offers the purge only to such a case and the server checks it
 * again. `src/ui/privacy-lists.test.ts` ties this list to the domain's.
 */
export const PURGE_SCOPE: readonly string[] = [
  "organization_profile",
  "customers",
  "sales",
  "inventory_catalog",
  "media",
];
