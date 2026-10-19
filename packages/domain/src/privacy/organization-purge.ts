/**
 * The full purge of a closed organization (plan PR107, ADR 0081). The purge is started only by an
 * explicit administrative command on a `closed` organization; nothing schedules it on its own while
 * the retention of a closed organization is only proposed (ADR 0079). The executor then removes the
 * storage first (exports and image masters and derivatives), the rows second, in one transaction that
 * writes the deletion ledger tombstone before deleting, and sweeps the storage prefixes once more.
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
 * The closure period (decision of 18/10/2026, changed from 30 to 90 days on 19/10/2026, ADR 0081): the purge
 * removes the tenant's operational data only once the organization has been closed for this long, and refuses
 * before it (`closure_period_not_elapsed`), whatever recovery window the closure had. Polaris is the processor
 * of that data and the fiscal duty to keep it is the customer's, who has the export. The intent is that the
 * owner only reads and exports during the period; the read-only mode after the recovery window is a requirement
 * of ADR 0081, not built yet. The migration holds the same period (`interval '90 days'` in
 * `admin_schedule_organization_purge` and `organization_purge_blocker`).
 */
export const ORGANIZATION_PURGE_CLOSURE_PERIOD_DAYS = 90;

/**
 * The time between the end of the recovery window and the earliest purge, from the retention
 * registry. While `closed_organization` is only proposed it adds nothing: the window (approved, ADR
 * 0074) is the only wait, and the purge needs the explicit command. No period is invented here.
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
 * Whether a job may put a closed organization into the purge on its own. Only an approved class with
 * a period allows it; until then (today) the purge starts only by the administrative command, and no
 * job does it.
 */
export function automaticPurgeSchedulingAllowed(
  policies: readonly RetentionPolicy[] = RETENTION_POLICIES
): boolean {
  const policy = retentionPolicyIn(policies, "closed_organization");
  return policy.status === "aprovada" && policy.period.kind === "duration";
}

/**
 * The categories a privacy case must cover for its accepted deletion to start a purge: every tenant
 * category the purge removes (ADR 0081), and exactly those. Account, authentication and billing are not
 * here: the purge keeps them, so a case that claims them is refused instead of recording a decision the
 * purge does not carry out. The migration holds the same list (`whole_organization` in
 * `admin_schedule_organization_purge`), and the gate proves each category is required and each kept one refused.
 */
export const ORGANIZATION_PURGE_REQUIRED_SCOPE = Object.freeze([
  "organization_profile",
  "customers",
  "sales",
  "inventory_catalog",
  "media",
  "audit_logs",
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
] as const);

export type OrganizationPurgeRefusalCode =
  (typeof ORGANIZATION_PURGE_REFUSALS)[number];

/** What an operator reads for each refusal: the state to change first, never a database message. */
const ORGANIZATION_PURGE_REFUSAL_MESSAGES: Readonly<
  Record<OrganizationPurgeRefusalCode, string>
> = Object.freeze({
  closure_period_not_elapsed: `A organização foi encerrada há menos de ${ORGANIZATION_PURGE_CLOSURE_PERIOD_DAYS} dias: o purge só começa depois desse prazo, para o dono poder ler e exportar os dados.`,
  legal_hold_active:
    "Há uma trava legal vigente na organização: o purge não é agendado nem executado enquanto ela não for liberada.",
  organization_mismatch: "A organização informada não é a do caso.",
  organization_not_closed:
    "A organização não está encerrada (ativa, suspensa ou ainda em encerramento).",
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
  privacy_scope_covers_kept_data: `O escopo do caso inclui dados que o purge mantém (conta, autenticação ou cobrança). Registre o escopo exato do que o purge apaga: ${ORGANIZATION_PURGE_REQUIRED_SCOPE_LABEL}.`,
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
