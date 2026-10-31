/**
 * The full purge of a closed organization (plan PR107, ADR 0081 and 0102). The privacy job schedules it on
 * its own seven local days before D (the closure period of the approved class `closed_organization`), behind
 * the switch `CLOSURE_AUTO_PURGE_ENABLED`; an explicit administrative command under a privacy case still
 * schedules it for the exceptions. The executor then removes the storage first (exports and image masters
 * and derivatives), the rows second, in one transaction that writes the deletion ledger tombstone before
 * deleting, and sweeps the storage prefixes once more.
 */
import type { PrivacyDataCategory } from "../admin/privacy-case";
import {
  RETENTION_POLICIES,
  type RetentionPolicy,
  retentionPolicyIn,
} from "./retention";

/** The order of the workflow; each step can be run again without effect once it is done. */
export const ORGANIZATION_PURGE_STEPS = Object.freeze([
  "mark_storage",
  "exports_storage",
  "media_storage",
  "database",
  "second_sweep",
] as const);

/**
 * How long a run holds a purge. Longer than the lease of a data export (10 minutes), so a purge that
 * waited for an export never overlaps the next run of the same purge.
 */
export const ORGANIZATION_PURGE_LEASE_SECONDS = 15 * 60;

/**
 * A purge whose step failed for the third time or more (a failure the database does not name as a refusal on purpose)
 * is not advancing: the job reports it as stalled.
 */
export const ORGANIZATION_PURGE_STALLED_ATTEMPTS = 3;

const OPAQUE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class InvalidOrganizationIdError extends Error {
  readonly code = "invalid_organization_id";

  constructor() {
    super("invalid_organization_id");
    this.name = "InvalidOrganizationIdError";
  }
}

function checkedOrganizationId(organizationId: string): string {
  if (!OPAQUE_ID.test(organizationId)) {
    throw new InvalidOrganizationIdError();
  }
  return organizationId;
}

/** Every export of the organization, ready or not (ADR 0078). */
export function organizationExportPrefix(organizationId: string): string {
  return `exports/v1/${checkedOrganizationId(organizationId)}/`;
}

/**
 * Every image master of the organization. The upload key encodes the ID with `encodeURIComponent`,
 * which leaves an opaque ID as it is.
 */
export function organizationMediaPrefix(organizationId: string): string {
  return `media/v2/${encodeURIComponent(checkedOrganizationId(organizationId))}/`;
}

/**
 * The closure period (ADR 0081): the purge
 * removes the tenant's operational data only once the organization has been closed for this long, and refuses
 * before it (`closure_period_not_elapsed`), whatever recovery window the closure had. Polaris is the processor
 * of that data and the fiscal duty to keep it is the customer's, who has the export. The owner only reads and
 * exports during the period (the read-only mode of ADR 0081). The migration holds the same period (`interval '90
 * days'` in `admin_schedule_organization_purge` and `organization_purge_blocker`; the calendar days of D in
 * `closure_deadlines`, which `schedule_closed_organization_purges` reads).
 */
export const ORGANIZATION_PURGE_CLOSURE_PERIOD_DAYS = 90;

/**
 * The time the Admin's schedule adds after the end of the closure period, from the retention registry:
 * only a class approved with a plain duration would add one. `closed_organization` is approved in calendar
 * days of the closure (ADR 0102), which is the period itself, not a delay after it, so it adds nothing. No
 * period is invented here.
 */
export function purgeDelayAfterWindowMs(
  policies: readonly RetentionPolicy[] = RETENTION_POLICIES
): number {
  const policy = retentionPolicyIn(policies, "closed_organization");
  return policy.status === "aprovada" && policy.period.kind === "duration"
    ? policy.period.ms
    : 0;
}

/**
 * Whether a job may put a closed organization into the purge on its own (ADR 0102): only while the class
 * is approved with the closure period in calendar days, the very period the database counts, and with the
 * job declared. A class put back to proposed, or a period that differs from the database, turns it off.
 */
export function automaticPurgeSchedulingAllowed(
  policies: readonly RetentionPolicy[] = RETENTION_POLICIES
): boolean {
  const policy = retentionPolicyIn(policies, "closed_organization");
  return (
    policy.status === "aprovada" &&
    policy.period.kind === "closure_calendar_days" &&
    policy.period.days === ORGANIZATION_PURGE_CLOSURE_PERIOD_DAYS &&
    "job" in policy &&
    policy.job === "privacy.closure_purge_schedule"
  );
}

/**
 * The categories a privacy case must cover for its accepted deletion to start a purge: every tenant
 * category the purge removes (ADR 0081), and exactly those. Account, authentication, billing and the audit
 * logs are not here (the audit of the tenant survives the purge, ADR 0081 amended): the purge keeps them, so a case that claims them is refused instead of recording a decision the
 * purge does not carry out. The migration holds the same list (`whole_organization` in
 * `admin_schedule_organization_purge`), and the gate proves each category is required and each kept one refused.
 */
export const ORGANIZATION_PURGE_REQUIRED_SCOPE = Object.freeze([
  "organization_profile",
  "customers",
  "sales",
  "inventory_catalog",
  "media",
] as const satisfies readonly PrivacyDataCategory[]);

const ORGANIZATION_PURGE_REQUIRED_SCOPE_LABEL =
  ORGANIZATION_PURGE_REQUIRED_SCOPE.join(", ");

/**
 * Why the database refused to schedule or cancel a purge; each one is a state to change first, not an
 * input error.
 */
export const ORGANIZATION_PURGE_REFUSALS = Object.freeze([
  "organization_mismatch",
  "organization_not_closed",
  "privacy_case_required",
  "privacy_case_not_deletion",
  "privacy_requester_not_owner",
  "privacy_case_not_accepted",
  "privacy_scope_incomplete",
  "privacy_scope_covers_kept_data",
  "recovery_window_open",
  "closure_period_not_elapsed",
  "legal_hold_active",
  "tenant_access_active",
  "paid_access_running",
  "purge_not_scheduled",
  "purge_in_progress",
  "purge_storage_touched",
  "purge_already_done",
  // the act of the support on the closure notices (ADR 0102, amended)
  "organization_not_in_closure",
  "closure_notice_not_due",
  "closure_notice_pending",
  "closure_notice_delivered",
  "closure_notice_no_owner",
  "closure_notice_owner_present",
  "closure_notice_not_refused",
  "closure_notice_not_unverified",
  "closure_notice_owner_verified",
] as const);

export type OrganizationPurgeRefusalCode =
  (typeof ORGANIZATION_PURGE_REFUSALS)[number];

/** What an operator reads for each refusal: the state to change first, never a database message. */
const ORGANIZATION_PURGE_REFUSAL_MESSAGES: Readonly<
  Record<OrganizationPurgeRefusalCode, string>
> = Object.freeze({
  closure_notice_delivered:
    "O aviso de 7 dias deste encerramento já foi entregue (ou dispensado): não há o que reenviar nem dispensar.",
  closure_notice_no_owner:
    "A organização não tem dono ativo para receber o aviso. Se ninguém pode ser avisado, dispense o aviso com a decisão do caso.",
  closure_notice_not_refused:
    "O provedor de e-mail não recusou o aviso de 7 dias deste encerramento para o dono atual (ou ainda há um aviso esperando envio): reenvie o aviso antes de dispensá-lo.",
  closure_notice_not_unverified:
    "Nenhuma tentativa de envio do aviso de 7 dias encontrou o e-mail do dono sem verificação: com o e-mail dos avisos ligado, espere a tentativa ou reenvie o aviso.",
  closure_notice_owner_verified:
    "O dono já verificou o e-mail depois da última tentativa de envio do aviso de 7 dias: não dispense. O repasse envia o aviso que está devido.",
  closure_notice_owner_present:
    "A organização ainda tem dono ativo: a conta do dono não foi apagada. Reenvie o aviso ou use o motivo que corresponde ao caso.",
  closure_notice_not_due:
    "O aviso de 7 dias deste encerramento ainda não venceu: não há o que reenviar nem dispensar.",
  closure_notice_pending:
    "Há um aviso deste encerramento esperando envio. Espere o envio ou, se ninguém pode ser avisado, dispense o aviso.",
  closure_period_not_elapsed: `A organização foi encerrada há menos de ${ORGANIZATION_PURGE_CLOSURE_PERIOD_DAYS} dias: o purge só começa depois desse prazo, para o dono poder ler e exportar os dados.`,
  legal_hold_active:
    "Há uma trava legal vigente na organização: o purge não é agendado nem executado enquanto ela não for liberada.",
  organization_mismatch: "A organização informada não é a do caso.",
  organization_not_closed:
    "A organização não está encerrada (ativa, suspensa ou ainda em encerramento).",
  organization_not_in_closure:
    "A organização não está em encerramento (ativa, suspensa, com o encerramento desfeito ou já apagada).",
  paid_access_running:
    "A organização ainda tem período de teste ou acesso pago em andamento.",
  privacy_case_not_accepted:
    "O pedido de exclusão ainda não foi decidido ou não foi aceito por inteiro.",
  privacy_case_not_deletion:
    "O caso de privacidade não é um pedido de exclusão.",
  privacy_case_required:
    "Um caso de suporte comum não inicia o purge: use o caso de privacidade do pedido de exclusão.",
  privacy_requester_not_owner:
    "O pedido de exclusão não foi feito pelo dono da organização.",
  privacy_scope_covers_kept_data: `O escopo do caso inclui dados que o purge mantém (conta, autenticação, cobrança ou registros de auditoria). Registre o escopo exato do que o purge apaga: ${ORGANIZATION_PURGE_REQUIRED_SCOPE_LABEL}.`,
  privacy_scope_incomplete: `O escopo do caso não cobre tudo o que o purge apaga (${ORGANIZATION_PURGE_REQUIRED_SCOPE_LABEL}).`,
  purge_already_done: "O purge já foi concluído e não pode ser desfeito.",
  purge_in_progress:
    "Uma execução está segurando o purge agora. Espere a concessão terminar (até 15 minutos): se ela já tiver começado a apagar arquivos no armazenamento, o cancelamento continuará recusado.",
  purge_not_scheduled: "Não há purge agendado para esta organização.",
  purge_storage_touched:
    "O purge já começou a apagar arquivos no armazenamento e não pode mais ser cancelado.",
  recovery_window_open: "A janela de recuperação da organização não acabou.",
  tenant_access_active:
    "Há acesso temporário do Admin vigente à organização: revogue-o antes.",
});

export function organizationPurgeRefusalMessage(
  code: OrganizationPurgeRefusalCode
): string {
  return ORGANIZATION_PURGE_REFUSAL_MESSAGES[code];
}

export class OrganizationPurgeRefusedError extends Error {
  readonly code: OrganizationPurgeRefusalCode;

  constructor(code: OrganizationPurgeRefusalCode) {
    super(code);
    this.code = code;
    this.name = "OrganizationPurgeRefusedError";
  }
}

/** The named refusal for a database message, or null when the message is not one of them. */
export function organizationPurgeRefusalFromMessage(
  message: string
): OrganizationPurgeRefusalCode | null {
  return (
    ORGANIZATION_PURGE_REFUSALS.find((candidate) => candidate === message) ??
    null
  );
}
