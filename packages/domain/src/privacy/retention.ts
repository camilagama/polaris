/**
 * Retention by data class (plan PR105, ADR 0079): how long each kind of data
 * is kept, where that rule comes from and whether it was approved. This is the
 * single place a period is declared; code that expires data reads its period
 * from here, never from a constant of its own.
 *
 * There is no single period for everything. A class is `aprovada` only when a
 * decision already on main (an ADR or a business rule) fixes it; everything
 * else is `proposta`, with the proposed period written in the ADR and no job.
 * A legal period (tax, accounting, LGPD) is the responsible person's decision
 * and is never approved by code, so a class whose basis is the law stays
 * proposed until that decision is recorded.
 */
export const RETENTION_CLASSES = Object.freeze([
  "media_staging_marker",
  "media_removed_image",
  "tenant_audit_events",
  "product_media",
  "customers",
  "sales_records",
  "inventory_ledger",
  "expenses_and_goals",
  "billing_events",
  "sync_commands",
  "sync_change_log",
  "data_exports",
  "closed_organization",
  "auth_sessions",
  "auth_verification",
  "auth_security_audit",
  "platform_audit_and_support",
  "privacy_cases",
  "deletion_ledger",
  "event_outbox",
  "queue_processing",
  "operational_incident",
  "provider_backups",
] as const);

export type RetentionClass = (typeof RETENTION_CLASSES)[number];

/** Why the data is kept for that long. */
export type RetentionBasis = "contrato" | "decisao" | "lei";

/** The purge jobs that already exist; each one serves exactly one approved class. */
export type RetentionPurgeJobId =
  | "media.removed_cleanup"
  | "media.staging_reconcile"
  | "outbox.processing_expiry"
  | "privacy.data_export_expiry";

interface RetentionPolicyBase {
  basis: RetentionBasis;
  class: RetentionClass;
  /** Tables, objects or copies the class covers. */
  data: readonly string[];
  /** What the rule says, in the words of its source. */
  rule: string;
  /** The ADRs and business rules the policy comes from. */
  sources: readonly string[];
}

/** Kept for a fixed time and then removed by its job (if the job already exists). */
interface ApprovedDuration extends RetentionPolicyBase {
  job?: RetentionPurgeJobId;
  period: { kind: "duration"; ms: number };
  status: "aprovada";
}

/** Kept while the organization exists; removed only by the purge of the organization. */
interface ApprovedUntilPurge extends RetentionPolicyBase {
  period: { kind: "until_organization_purge" };
  status: "aprovada";
}

/** Not decided: no period is enforced and no job may exist. */
interface ProposedPolicy extends RetentionPolicyBase {
  period: { kind: "undecided" };
  /** The proposed period, as written in ADR 0079 (a legal one says who confirms it). */
  proposed: string;
  status: "proposta";
}

export type RetentionPolicy =
  | ApprovedDuration
  | ApprovedUntilPurge
  | ProposedPolicy;

const HOUR_MS = 3_600_000;

const TO_CONFIRM = "a confirmar pelo responsável";

export const RETENTION_POLICIES: readonly RetentionPolicy[] = Object.freeze([
  {
    basis: "decisao",
    class: "media_staging_marker",
    data: [
      "R2 media/staging/v1/ (markers de envio)",
      "masters órfãos de envio",
    ],
    job: "media.staging_reconcile",
    period: { kind: "duration", ms: 24 * HOUR_MS },
    rule: "Marker de envio fica no mínimo 24 horas, contadas pelo timestamp real do R2; depois o reconciliador horário remove o marker e, se nenhum asset referencia a chave, o master.",
    sources: ["ADR 0014", "docs/business-rules/media.md"],
    status: "aprovada",
  },
  {
    basis: "decisao",
    class: "media_removed_image",
    data: [
      "media_assets sem vínculo",
      "R2 master e derivados 320 e 640 da imagem removida",
    ],
    job: "media.removed_cleanup",
    period: { kind: "duration", ms: HOUR_MS },
    rule: "Imagem removida de um produto sai do bucket e do banco na execução horária seguinte, desde que o asset tenha mais de uma hora contada da sua criação (não da remoção).",
    sources: ["ADR 0061"],
    status: "aprovada",
  },
  {
    basis: "decisao",
    class: "tenant_audit_events",
    data: ["tenant_audit_event"],
    period: { kind: "until_organization_purge" },
    rule: "Sem expiração automática. O Polaris é operador desses dados (LGPD) e a obrigação fiscal de guardá-los é do cliente, que tem a exportação: saem no purge ao fim do prazo de encerramento de 30 dias, salvo legal hold (decisão do responsável de 18/10/2026, ADR 0081).",
    sources: ["ADR 0006", "ADR 0081", "docs/business-rules/privacy.md"],
    status: "aprovada",
  },
  {
    basis: "decisao",
    class: "product_media",
    data: [
      "media_assets e vínculos de produtos não removidos ou com tombstone",
      "R2 masters e derivados",
    ],
    period: { kind: "until_organization_purge" },
    rule: "Enquanto o produto existir (inclusive com tombstone); um produto excluído mantém vínculos e imagens, sem prazo próprio. O Polaris é operador desses dados (LGPD) e a obrigação fiscal de guardá-los é do cliente, que tem a exportação: saem no purge ao fim do prazo de encerramento de 30 dias, salvo legal hold (decisão do responsável de 18/10/2026, ADR 0081).",
    sources: ["ADR 0061", "ADR 0081", "docs/business-rules/media.md"],
    status: "aprovada",
  },
  {
    basis: "contrato",
    class: "customers",
    data: ["customers (nome, telefone, email, observações)"],
    period: { kind: "undecided" },
    proposed:
      "Enquanto a organização existir, até a anonimização a pedido; depois, o purge da organização. Sem expiração por inatividade.",
    rule: "O revendedor é o controlador; o Polaris remove a pessoa do cadastro pela anonimização, preservando os fatos econômicos.",
    sources: ["ADR 0075", "docs/business-rules/privacy.md"],
    status: "proposta",
  },
  {
    basis: "decisao",
    class: "sales_records",
    data: [
      "sales, sale_items, sale_adjustments, sale_payments",
      "sale_cancellations, sale_returns, sale_return_items, sale_customer_links",
    ],
    period: { kind: "until_organization_purge" },
    rule: "Venda confirmada é snapshot econômico; corrige-se por cancelamento ou devolução, nunca apagando. O Polaris é operador desses dados (LGPD) e a obrigação fiscal de guardá-los é do cliente, que tem a exportação: saem no purge ao fim do prazo de encerramento de 30 dias, salvo legal hold (decisão do responsável de 18/10/2026, ADR 0081).",
    sources: [
      "ADR 0081",
      "docs/business-rules/sales.md",
      "docs/business-rules/privacy.md",
    ],
    status: "aprovada",
  },
  {
    basis: "decisao",
    class: "inventory_ledger",
    data: ["stock_movements", "inventory_balances"],
    period: { kind: "until_organization_purge" },
    rule: "Movimentos são append-only; só o papel do purge os apaga, numa organização com purge agendado (exceção aceita pelo responsável). O Polaris é operador desses dados (LGPD) e a obrigação fiscal de guardá-los é do cliente, que tem a exportação: saem no purge ao fim do prazo de encerramento de 30 dias, salvo legal hold (decisão do responsável de 18/10/2026, ADR 0081).",
    sources: [
      "ADR 0081",
      "docs/business-rules/inventory.md",
      "docs/business-rules/privacy.md",
    ],
    status: "aprovada",
  },
  {
    basis: "decisao",
    class: "expenses_and_goals",
    data: [
      "expenses, expense_categories, expense_recurring_rules",
      "goals, goal_target_changes",
    ],
    period: { kind: "until_organization_purge" },
    rule: "Despesa e meta são dados de gestão da organização, sem prazo próprio. O Polaris é operador desses dados (LGPD) e a obrigação fiscal de guardá-los é do cliente, que tem a exportação: saem no purge ao fim do prazo de encerramento de 30 dias, salvo legal hold (decisão do responsável de 18/10/2026, ADR 0081).",
    sources: ["ADR 0081", "docs/business-rules/expenses-and-results.md"],
    status: "aprovada",
  },
  {
    basis: "lei",
    class: "billing_events",
    data: [
      "billing_events (caixa de entrada e razão)",
      "organization_billing, entitlement_grants",
    ],
    period: { kind: "undecided" },
    proposed: `Registro financeiro: o prazo fiscal e contábil depois do fim da relação (${TO_CONFIRM}).`,
    rule: "O runtime nunca apaga uma linha do razão: é uma restrição de quem pode apagar, não um prazo. O purge da organização mantém os eventos e pseudonimiza o pagador: o fato fica só com valores, datas, tipos e referências opacas, e `provider_ref` e `provider_event_id` continuam e ainda localizam o pagador no provedor, pelo prazo fiscal (5 anos do 1º de janeiro seguinte); o motivo das concessões vira texto fixo (decisão do responsável de 18/10/2026, ADR 0081).",
    sources: ["ADR 0062", "ADR 0066", "ADR 0081"],
    status: "proposta",
  },
  {
    basis: "decisao",
    class: "sync_commands",
    data: [
      "sync_commands (resultado e hash do payload de cada comando offline)",
    ],
    period: { kind: "undecided" },
    proposed:
      "90 dias depois de received_at, e só depois que o servidor recusar um comando criado há mais que o prazo (sem o registro, um reenvio antigo rodaria de novo).",
    rule: "O registro é a idempotência do sync.push. O comando só precisa ter sido criado dentro do lease; o intervalo até o envio não tem limite.",
    sources: ["ADR 0033", "ADR 0044", "ADR 0075"],
    status: "proposta",
  },
  {
    basis: "decisao",
    class: "sync_change_log",
    data: ["sync_changes", "sync_cursors"],
    period: { kind: "undecided" },
    proposed:
      "Podar com um piso de cursor (cursor antigo demais refaz o bootstrap); prazo junto com o de sync_commands.",
    rule: "Não há retenção nem compactação do log antes do lançamento.",
    sources: ["ADR 0030"],
    status: "proposta",
  },
  {
    basis: "decisao",
    class: "data_exports",
    data: [
      "data_exports e data_export_files",
      "R2 exports/v1/ (arquivos da exportação)",
    ],
    job: "privacy.data_export_expiry",
    period: { kind: "duration", ms: 24 * HOUR_MS },
    rule: "A exportação pronta pode ser baixada por 24 horas; a que falhou fica 24 horas. Depois o job horário a expira e apaga os objetos no R2 antes de marcar os arquivos como apagados. Prazo provisório de produto, a rever com o jurídico no go-live.",
    sources: ["ADR 0078", "docs/business-rules/privacy.md"],
    status: "aprovada",
  },
  {
    basis: "decisao",
    class: "closed_organization",
    data: ["todos os dados de uma organização closed"],
    period: { kind: "undecided" },
    proposed: `Agendar o purge sozinho depois do fim do prazo de encerramento de 30 dias (${TO_CONFIRM}: hoje nenhum job o agenda).`,
    rule: "Nada é apagado na janela de recuperação. O purge só começa por comando administrativo explícito sobre uma organização closed, e recusa rodar antes de 30 dias do encerramento ou com legal hold vigente (decisão do responsável de 18/10/2026, ADR 0081); respeita o deletion ledger. Nenhum job o agenda.",
    sources: ["ADR 0074", "ADR 0081", "docs/business-rules/privacy.md"],
    status: "proposta",
  },
  {
    basis: "lei",
    class: "auth_sessions",
    data: ["session (IP e user-agent)"],
    period: { kind: "undecided" },
    proposed: `Apagar a sessão expirada ou revogada 30 dias depois do fim (registro de acesso: ${TO_CONFIRM}).`,
    rule: "Sessão vale no máximo 30 dias; a linha expirada continua no banco com IP e user-agent.",
    sources: [
      "docs/business-rules/authentication.md",
      "docs/business-rules/privacy.md",
    ],
    status: "proposta",
  },
  {
    basis: "decisao",
    class: "auth_verification",
    data: ["verification (tokens de verificação e recuperação)"],
    period: { kind: "undecided" },
    proposed: "Apagar o token um dia depois de expirar.",
    rule: "Token transacional não tem uso depois de expirar.",
    sources: ["docs/business-rules/authentication.md"],
    status: "proposta",
  },
  {
    basis: "lei",
    class: "auth_security_audit",
    data: ["auth_security_audit_event"],
    period: { kind: "undecided" },
    proposed: `Prazo de registro de segurança e incidentes (${TO_CONFIRM}).`,
    rule: "Prazos legais de retenção e de incidentes exigem revisão jurídica antes do go-live.",
    sources: ["docs/business-rules/privacy.md"],
    status: "proposta",
  },
  {
    basis: "decisao",
    class: "platform_audit_and_support",
    data: ["platform_audit_events", "support_cases", "tenant_access_grants"],
    period: { kind: "undecided" },
    proposed: `Sobrevive à organização, sem dado pessoal; prazo de registro de acesso privilegiado (${TO_CONFIRM}).`,
    rule: "O Admin registra cada acesso e comando; não há prazo na main. No purge da organização, o caso de suporte perde o texto livre (motivo, contexto e resolução) e fica só o registro (decisão do responsável de 18/10/2026, ADR 0081).",
    sources: ["ADR 0070", "ADR 0072", "ADR 0073"],
    status: "proposta",
  },
  {
    basis: "lei",
    class: "privacy_cases",
    data: ["privacy_cases", "privacy_case_actions"],
    period: { kind: "undecided" },
    proposed: `Sobrevive à organização como evidência do atendimento, sem dado pessoal (${TO_CONFIRM}).`,
    rule: "O caso guarda só códigos e referência opaca; sobrevive ao purge porque a linha da organização fica como tombstone (chave estrangeira restritiva preservada). O purge apaga as notas (texto livre) e mantém datas, tipo, decisão e IDs opacos (decisão do responsável de 18/10/2026, ADR 0081).",
    sources: ["ADR 0077", "ADR 0081"],
    status: "proposta",
  },
  {
    basis: "decisao",
    class: "deletion_ledger",
    data: ["deletion_ledger (tombstones de anonimização e de purge)"],
    period: { kind: "undecided" },
    proposed: `Sobrevive à organização, sem expiração automática e sem job; não expira antes da janela de restauração mais longa do provedor (${TO_CONFIRM}, junto da janela de backup).`,
    rule: "O purge da organização não apaga o ledger; enquanto um backup anterior ao tombstone puder ser restaurado, o tombstone precisa existir. Nenhum papel o apaga hoje, e uma remoção futura exige uma migration revisada.",
    sources: ["ADR 0080", "docs/business-rules/privacy.md"],
    status: "proposta",
  },
  {
    basis: "decisao",
    class: "event_outbox",
    data: ["event_outbox (eventos a despachar, só IDs opacos)"],
    period: { kind: "undecided" },
    proposed: `Apagar os eventos despachados depois de um prazo curto, definido com o despachante (${TO_CONFIRM}); os pendentes saem com o purge da organização.`,
    rule: "O corpo do evento só tem IDs opacos, inteiros e booleanos (nunca dado pessoal). Nenhum papel apaga hoje; o expurgo dos despachados não existe até o responsável aprovar o prazo (nem o despachante nem o agendador o fazem), e o purge da organização apaga os eventos dela.",
    sources: ["ADR 0082"],
    status: "proposta",
  },
  {
    basis: "decisao",
    class: "queue_processing",
    data: ["queue_processing (registro do consumidor de filas, só IDs opacos)"],
    job: "outbox.processing_expiry",
    period: { kind: "duration", ms: 7 * 24 * HOUR_MS },
    rule: "O registro de uma mensagem processada fica uma semana (mais que as 24 horas de retenção da fila e as novas tentativas) e sai na execução horária do despachante; uma tomada cujo consumidor morreu sai uma semana depois do fim do prazo dela.",
    sources: ["ADR 0084"],
    status: "aprovada",
  },
  {
    basis: "decisao",
    class: "operational_incident",
    data: [
      "operational_incidents (uma linha por causa: contagem, datas e referência opaca)",
      "queue_dead_letters (eventos mortos do outbox, só IDs opacos)",
    ],
    period: { kind: "undecided" },
    proposed: `Apagar o incidente e os itens já reenviados depois de um prazo de operação, definido com o job agendado (${TO_CONFIRM}); os itens de uma organização saem no purge dela, que os apaga explicitamente (a linha da organização fica como tombstone, então a cascata não age).`,
    rule: "O incidente guarda só código, contagem, datas e uma referência opaca; o item guarda só o ID do evento e da organização. Fora do purge nenhum papel apaga; o expurgo é do job agendado (PR112). O purge da organização apaga os itens dela explicitamente (política e DELETE do papel do purge, ADR 0081): a cascata da chave estrangeira não dispara, porque o purge mantém a linha da organização. O incidente não tem organização e não entra no purge.",
    sources: ["ADR 0085"],
    status: "proposta",
  },
  {
    basis: "contrato",
    class: "provider_backups",
    data: [
      "backups e branches do provedor de banco",
      "cópias fora do banco ativo",
    ],
    period: { kind: "undecided" },
    proposed: `A janela de restauração configurada no provedor; restore reaplica o deletion ledger (${TO_CONFIRM}).`,
    rule: "A anonimização e o purge não alcançam backups do provedor.",
    sources: ["ADR 0075", "docs/business-rules/privacy.md"],
    status: "proposta",
  },
] satisfies readonly RetentionPolicy[]);

/** The purge jobs that exist today, each tied to the class it expires. */
export const RETENTION_PURGE_JOBS: readonly {
  class: RetentionClass;
  id: RetentionPurgeJobId;
}[] = Object.freeze([
  { class: "media_staging_marker", id: "media.staging_reconcile" },
  { class: "media_removed_image", id: "media.removed_cleanup" },
  { class: "data_exports", id: "privacy.data_export_expiry" },
  { class: "queue_processing", id: "outbox.processing_expiry" },
]);

/**
 * Removals that are not jobs: nothing schedules them. Each one runs only after an explicit
 * administrative command names what to remove (the purge of a closed organization, ADR 0081), so it
 * can exist for a class that is only proposed. A job of `RETENTION_PURGE_JOBS` never can.
 */
export const ADMIN_TRIGGERED_REMOVALS: readonly {
  class: RetentionClass;
  id: "privacy.organization_purge";
}[] = Object.freeze([
  { class: "closed_organization", id: "privacy.organization_purge" },
]);

/** A period was asked for a class that has no approved period. */
export class RetentionNotApprovedError extends Error {
  readonly code = "retention_not_approved";
  readonly retentionClass: RetentionClass;

  constructor(retentionClass: RetentionClass) {
    super("retention_not_approved");
    this.retentionClass = retentionClass;
    this.name = "RetentionNotApprovedError";
  }
}

export function isRetentionClass(value: string): value is RetentionClass {
  return RETENTION_CLASSES.some((candidate) => candidate === value);
}

/** The policy of a class in a given registry (the real one, or a changed copy in a test). */
export function retentionPolicyIn(
  policies: readonly RetentionPolicy[],
  retentionClass: RetentionClass
): RetentionPolicy {
  const policy = policies.find(
    (candidate) => candidate.class === retentionClass
  );
  if (!policy) {
    throw new RetentionNotApprovedError(retentionClass);
  }
  return policy;
}

export function retentionPolicy(
  retentionClass: RetentionClass
): RetentionPolicy {
  return retentionPolicyIn(RETENTION_POLICIES, retentionClass);
}

/**
 * The approved period of a class, in milliseconds. A job asks this before
 * expiring anything, so a class that is only proposed (or kept until the purge
 * of its organization) can never be expired by accident.
 */
export function approvedRetention(retentionClass: RetentionClass): number {
  const policy = retentionPolicy(retentionClass);
  if (policy.status !== "aprovada" || policy.period.kind !== "duration") {
    throw new RetentionNotApprovedError(retentionClass);
  }
  return policy.period.ms;
}
