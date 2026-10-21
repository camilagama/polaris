/**
 * Retention by data class (plan PR105, ADR 0079): how long each kind of data
 * is kept, where that rule comes from and whether it was approved. This is the
 * single place a period is declared; code that expires data reads its period
 * from here, never from a constant of its own.
 *
 * There is no single period for everything. A class is `aprovada` only when a
 * decision already on main (an ADR or a business rule) fixes it and a job or a
 * refusal in the code reads it; everything else is `proposta`, with the
 * proposed period written in the ADR and no job. Turning a `proposta` into
 * `aprovada` means turning a job or a refusal on, so it is a separate request.
 * A legal period (tax, accounting, LGPD, Marco Civil) carries the date of the
 * decision and the norms it rests on (`approvedOn`, `legalSources`).
 *
 * On 19/10/2026 the user approved every period of this registry, the legal ones
 * included ("always looking for simplicity"): the `review` of every class is
 * `decidida`. A lawyer's review of the legal periods is still recommended, but
 * it does not block anything: every class whose basis is the law keeps
 * `legalReview`, `"pending"` until that person has validated it, and a pending
 * one is a warning in the release checklist (item 10), not a block.
 *
 * `aprovada` means "in force as a technical gate" (what the jobs and the
 * refusals read), not "reviewed". The review of every class is the separate
 * `review` field.
 */
export const RETENTION_CLASSES = Object.freeze([
  "media_staging_marker",
  "media_removed_image",
  "tenant_audit_security",
  "tenant_audit_operational",
  "product_media",
  "customers",
  "sales_records",
  "inventory_ledger",
  "expenses_and_goals",
  "billing_events",
  "billing_trial_claims",
  "sync_commands",
  "sync_change_log",
  "data_exports",
  "closed_organization",
  "closure_notice",
  "auth_sessions",
  "devices",
  "auth_verification",
  "auth_login_lock",
  "auth_unverified_user",
  "auth_security_audit",
  "auth_access_log",
  "legal_acceptance",
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

/**
 * The validation of a legal period by an accountant or a lawyer. `"pending"` until someone
 * has done it; once done, it names who and when (YYYY-MM-DD). Nothing in code marks it done.
 */
export type LegalReview =
  | "pending"
  | { reviewedAt: string; reviewedBy: string };

/**
 * Where the review of a class's period stands, apart from `status`. `status: "aprovada"` means
 * "in force": the technical gate that the jobs and the refusals already in the code read
 * (`approvedRetention`). It does not say the period was reviewed. `review` does: `"pendente_juridica"`
 * until the responsible person records a decision, and then `"decidida"`, with who (`by`) and when
 * (`at`, YYYY-MM-DD). Informative only: no code branches on it.
 */
export type RetentionReview =
  | { state: "pendente_juridica" }
  | { at: string; by: string; state: "decidida" };

/**
 * Every period was approved by the user on 19/10/2026, the legal ones included, looking for
 * simplicity. A lawyer's review is recommended (`legalReview`) and blocks nothing; no job or
 * refusal was turned on by this decision.
 */
const USER_APPROVED_REVIEW: RetentionReview = Object.freeze({
  at: "2026-10-19",
  by: "usuário (19/10/2026)",
  state: "decidida",
});

/**
 * What a class waits for before a purge job may exist for it. Each key is a thing that does not
 * exist yet; a blocker leaves `RESOLVED_RETENTION_BLOCKERS` untouched until the thing is built.
 */
export const RETENTION_BLOCKERS = Object.freeze({
  access_log_hold:
    "Guarda cautelar do registro de acesso (Marco Civil art. 15, §2º): a autoridade policial, administrativa ou o Ministério Público pode pedir a guarda por prazo maior que 6 meses, e o expurgo precisa pular o usuário ou o IP sob guarda antes de existir. Sem a guarda, nenhum job de expurgo do registro pode ser registrado (ADR 0092).",
  access_record_table:
    "Tabela própria do registro de acesso a aplicação (data, hora e IP, 6 meses, Marco Civil art. 15); tarefa t039. Resolvido: a tabela `auth_access_log` existe (ADR 0092).",
  account_deletion_event:
    "Evento de exclusão de conta que grava o `blockedUntil` do aceite legal: a data da exclusão mais 10 anos, para as linhas daquele `user_id` (ADR 0100, decisão do Arrascaeta de 19/10/2026). Sem a rotina de exclusão de conta o prazo não tem de onde partir, e `legal_acceptance` só acrescenta (gatilho): quem entregar a rotina entrega também a função de expurgo (dono de retenção, pulando legal hold) e esse `blockedUntil`. Nenhum job de expurgo do aceite pode existir antes.",
});

export type RetentionBlocker = keyof typeof RETENTION_BLOCKERS;

/** The blockers already lifted. The change that builds the thing a blocker waits for adds it here. */
export const RESOLVED_RETENTION_BLOCKERS: readonly RetentionBlocker[] =
  Object.freeze(["access_record_table"]);

/** The purge jobs that already exist; each one serves exactly one approved class. */
export type RetentionPurgeJobId =
  | "auth.login_lock_expiry"
  | "auth.unverified_user_purge"
  | "privacy.closure_purge_schedule"
  | "media.removed_cleanup"
  | "media.staging_reconcile"
  | "outbox.processing_expiry"
  | "privacy.data_export_expiry";

interface RetentionPolicyBase {
  /** The day the responsible person approved the period (YYYY-MM-DD). */
  approvedOn?: string;
  basis: RetentionBasis;
  /**
   * The period is approved but no purge job may exist while this thing is missing: the data the
   * job would delete is the only copy of something a law asks to keep.
   */
  blockedUntil?: RetentionBlocker;
  class: RetentionClass;
  /** Tables, objects or copies the class covers. */
  data: readonly string[];
  /** Who validated the legal period (required when the basis is the law). */
  legalReview?: LegalReview;
  /** The norms a legal period rests on, by name and article (never their text). */
  legalSources?: readonly string[];
  /** Where the review of the period stands (`RetentionReview`); informative, separate from `status`. */
  review: RetentionReview;
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

/**
 * Kept for a number of calendar months (a legal minimum is counted in months, not days), plus an
 * optional margin of days that only lengthens the period (never shortens the legal minimum).
 */
interface ApprovedCalendarMonths extends RetentionPolicyBase {
  period: { graceDays?: number; kind: "calendar_months"; months: number };
  status: "aprovada";
}

/** Kept for as long as the provider keeps its copies; Polaris does not expire them. */
interface ApprovedProviderRotation extends RetentionPolicyBase {
  period: { kind: "provider_rotation" };
  status: "aprovada";
}

/** Kept while the organization exists; removed only by the purge of the organization. */
interface ApprovedUntilPurge extends RetentionPolicyBase {
  period: { kind: "until_organization_purge" };
  status: "aprovada";
}

/**
 * Kept until D, the local date of the owner's closure request plus this many calendar days in the
 * organization's time zone (`closureDeadlines`), and then removed by the purge its job schedules (ADR 0102).
 */
interface ApprovedClosureCalendarDays extends RetentionPolicyBase {
  job: RetentionPurgeJobId;
  period: { days: number; kind: "closure_calendar_days" };
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
  | ApprovedCalendarMonths
  | ApprovedClosureCalendarDays
  | ApprovedDuration
  | ApprovedProviderRotation
  | ApprovedUntilPurge
  | ProposedPolicy;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const TO_CONFIRM = "a confirmar pelo responsável";

/**
 * The periods of the tenant's audit (ADR 0081, amended 19/10/2026; `security` lowered from 60 to 12 months by the
 * user's decision of 19/10/2026; a lawyer's review is recommended). The classes stay `proposta`, so no code reads them as
 * an approved period: the database function `tenant_audit_event_expired` (migration 0081) holds the same numbers, and
 * the audit gate proves its behavior at their edges.
 */
export const TENANT_AUDIT_RETENTION = Object.freeze({
  /** `operational`: counted from the purge of the organization (`organization_purges.purged_at`). */
  operational: Object.freeze({ from: "organization_purge", months: 6 }),
  /** `security`: counted from the event (`created_at`). */
  security: Object.freeze({ from: "event", months: 12 }),
} as const);

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
    review: USER_APPROVED_REVIEW,
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
    review: USER_APPROVED_REVIEW,
    rule: "Imagem removida de um produto sai do bucket e do banco na execução horária seguinte, desde que o asset tenha mais de uma hora contada da sua criação (não da remoção).",
    sources: ["ADR 0061"],
    status: "aprovada",
  },
  {
    basis: "decisao",
    class: "tenant_audit_security",
    data: ["tenant_audit_event (event_class = 'security')"],
    legalReview: "pending",
    period: { kind: "undecided" },
    proposed: `Sobrevive ao purge da organização e sai só por prazo: ${TENANT_AUDIT_RETENTION.security.months} meses contados do evento (aprovado pelo usuário em 19/10/2026, antes eram 60 meses; revisão de advogado recomendada, sem bloquear; nenhum job o aplica ainda).`,
    review: USER_APPROVED_REVIEW,
    rule: "A auditoria do tenant de classe `security` (exportações de dados, anonimização de cliente, concessões offline, vida da organização, publicação no catálogo público e, quando existirem, os eventos de membros) nunca sai no purge: a linha é imutável (gatilho ENABLE ALWAYS) e a chave estrangeira da organização é restritiva. A remoção por prazo é a função `expire_tenant_audit_events`, do papel `polaris_retention_owner`, que pula a organização sob legal hold; nenhum job a chama ainda (decisão do responsável de 19/10/2026, ADR 0081 emendado; o prazo passou de 60 para 12 meses na migration 0081, mesma data).",
    sources: ["ADR 0006", "ADR 0079", "ADR 0081"],
    status: "proposta",
  },
  {
    basis: "decisao",
    class: "tenant_audit_operational",
    data: ["tenant_audit_event (event_class = 'operational')"],
    legalReview: "pending",
    period: { kind: "undecided" },
    proposed: `Sobrevive ao purge da organização e sai por prazo: ${TENANT_AUDIT_RETENTION.operational.months} meses contados do purge dela, e nunca antes, enquanto a organização existir (aprovado pelo usuário em 19/10/2026; revisão de advogado recomendada, sem bloquear; nenhum job o aplica ainda).`,
    review: USER_APPROVED_REVIEW,
    rule: "A auditoria do tenant de classe `operational` (o resto do dia a dia: catálogo, vendas, estoque, despesas, metas) também sobrevive ao purge, imutável. Enquanto a organização não foi purgada nada dela vence; depois do purge a função `expire_tenant_audit_events` apaga as linhas quando passam 6 meses de `organization_purges.purged_at`, e pula a organização sob legal hold. Nenhum job a chama ainda (decisão do responsável de 19/10/2026, ADR 0081 emendado).",
    sources: ["ADR 0006", "ADR 0079", "ADR 0081"],
    status: "proposta",
  },
  {
    approvedOn: "2026-10-18",
    basis: "decisao",
    class: "product_media",
    data: [
      "media_assets e vínculos de produtos não removidos ou com tombstone",
      "R2 masters e derivados",
    ],
    period: { kind: "until_organization_purge" },
    review: USER_APPROVED_REVIEW,
    rule: "Enquanto o produto existir (inclusive com tombstone); um produto excluído mantém vínculos e imagens, sem prazo próprio. O Polaris é operador desses dados (LGPD) e a obrigação fiscal de guardá-los é do cliente, que tem a exportação: saem no purge ao fim do prazo de encerramento de 90 dias (decisão de 19/10/2026), salvo legal hold (decisão do responsável de 18/10/2026, ADR 0081).",
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
    review: USER_APPROVED_REVIEW,
    rule: "O revendedor é o controlador; o Polaris remove a pessoa do cadastro pela anonimização, preservando os fatos econômicos.",
    sources: ["ADR 0075", "docs/business-rules/privacy.md"],
    status: "proposta",
  },
  {
    approvedOn: "2026-10-18",
    basis: "decisao",
    class: "sales_records",
    data: [
      "sales, sale_items, sale_adjustments, sale_payments",
      "sale_cancellations, sale_returns, sale_return_items, sale_customer_links",
    ],
    period: { kind: "until_organization_purge" },
    review: USER_APPROVED_REVIEW,
    rule: "Venda confirmada é snapshot econômico; corrige-se por cancelamento ou devolução, nunca apagando. O Polaris é operador desses dados (LGPD) e a obrigação fiscal de guardá-los é do cliente, que tem a exportação: saem no purge ao fim do prazo de encerramento de 90 dias (decisão de 19/10/2026), salvo legal hold (decisão do responsável de 18/10/2026, ADR 0081).",
    sources: [
      "ADR 0081",
      "docs/business-rules/sales.md",
      "docs/business-rules/privacy.md",
    ],
    status: "aprovada",
  },
  {
    approvedOn: "2026-10-18",
    basis: "decisao",
    class: "inventory_ledger",
    data: ["stock_movements", "inventory_balances"],
    period: { kind: "until_organization_purge" },
    review: USER_APPROVED_REVIEW,
    rule: "Movimentos são append-only; só o papel do purge os apaga, numa organização com purge agendado (exceção aceita pelo responsável). O Polaris é operador desses dados (LGPD) e a obrigação fiscal de guardá-los é do cliente, que tem a exportação: saem no purge ao fim do prazo de encerramento de 90 dias (decisão de 19/10/2026), salvo legal hold (decisão do responsável de 18/10/2026, ADR 0081).",
    sources: [
      "ADR 0081",
      "docs/business-rules/inventory.md",
      "docs/business-rules/privacy.md",
    ],
    status: "aprovada",
  },
  {
    approvedOn: "2026-10-18",
    basis: "decisao",
    class: "expenses_and_goals",
    data: [
      "expenses, expense_categories, expense_recurring_rules",
      "goals, goal_target_changes",
    ],
    period: { kind: "until_organization_purge" },
    review: USER_APPROVED_REVIEW,
    rule: "Despesa e meta são dados de gestão da organização, sem prazo próprio. O Polaris é operador desses dados (LGPD) e a obrigação fiscal de guardá-los é do cliente, que tem a exportação: saem no purge ao fim do prazo de encerramento de 90 dias (decisão de 19/10/2026), salvo legal hold (decisão do responsável de 18/10/2026, ADR 0081).",
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
    legalReview: "pending",
    period: { kind: "undecided" },
    proposed: `Registro financeiro: até 31/12 do 5º ano após o fato gerador (o mesmo que 5 anos contados do 1º de janeiro do ano seguinte ao fato), decidido em 18/10/2026 e aprovado pelo usuário em 19/10/2026 (CTN, arts. 173 e 195; Código Civil, art. 1.194), com bloqueio do expurgo por fiscalização ou legal hold; os eventos técnicos de cobrança (a caixa de entrada de webhooks, sem valor fiscal próprio) ficam 12 meses (aprovado em 19/10/2026; sem prazo antes); o registro ainda não expressa "fim do 5º ano após o fato", nenhum job aplica os prazos e a revisão de advogado é recomendada, sem bloquear.`,
    review: USER_APPROVED_REVIEW,
    rule: "O runtime nunca apaga uma linha do razão: é uma restrição de quem pode apagar, não um prazo. O purge da organização mantém os eventos e pseudonimiza o pagador: o fato fica só com valores, datas, tipos e referências opacas, e `provider_ref` e `provider_event_id` continuam e ainda localizam o pagador no provedor, pelo prazo fiscal (até 31/12 do 5º ano após o fato gerador); fiscalização em curso ou legal hold bloqueiam o expurgo desse prazo, que nenhum job executa hoje; o motivo das concessões vira texto fixo (decisão do responsável de 18/10/2026, ADR 0081).",
    sources: ["ADR 0062", "ADR 0066", "ADR 0081"],
    status: "proposta",
  },
  {
    basis: "decisao",
    class: "billing_trial_claims",
    data: [
      "billing_trial_claims (o teste grátis de cada pessoa: usuário, organização em que foi reservado ou usado, quando foi reservado e quando foi consumido)",
    ],
    period: { kind: "undecided" },
    proposed:
      "Enquanto a conta do usuário existir: a linha sobrevive ao purge da organização (antiabuso: apagar a loja não devolve o trial) e sai com a exclusão da conta, pela chave estrangeira em cascata (decisão do Arrascaeta de 19/10/2026, V1 do Filipe Luís, ADR 0101). Nenhum job a apaga.",
    review: { state: "pendente_juridica" },
    rule: "O teste grátis vale uma vez por pessoa. A reserva é feita quando a pessoa opta pelo trial e é consumida quando o meio de renovação fica pronto; abandonar o checkout não a consome. A linha guarda só identificadores e datas, sem dado do pagador, e fica fora da exportação do tenant e da leitura do tenant. Quem apaga a conta e cria outra ganha outro trial (risco aceito no ADR 0101).",
    sources: ["ADR 0101", "docs/business-rules/billing-and-entitlements.md"],
    status: "proposta",
  },
  {
    approvedOn: "2026-10-18",
    basis: "decisao",
    class: "sync_commands",
    data: [
      "sync_commands (resultado e hash do payload de cada comando offline)",
    ],
    period: { kind: "duration", ms: 90 * DAY_MS },
    review: USER_APPROVED_REVIEW,
    rule: "O registro é a idempotência do sync.push e fica 90 dias (decisão do responsável de 18/10/2026). Sem o registro, um reenvio antigo rodaria de novo; por isso o servidor recusa, com command_too_old, o comando novo criado há mais de 90 dias (o reenvio de um comando que ainda tem registro continua devolvendo o resultado gravado). O job de expurgo ainda não existe: o prazo vale para a recusa, a contagem do expurgo é de received_at e o job só pode apagar depois de received_at + 90 dias + a margem de relógio do lease (5 minutos), porque o createdAt do aparelho pode estar à frente.",
    sources: ["ADR 0033", "ADR 0044", "ADR 0075", "ADR 0079"],
    status: "aprovada",
  },
  {
    basis: "decisao",
    class: "sync_change_log",
    data: ["sync_changes", "sync_cursors"],
    period: { kind: "undecided" },
    proposed:
      "Podar com um piso de cursor (cursor antigo demais refaz o bootstrap); prazo junto com o de sync_commands.",
    review: USER_APPROVED_REVIEW,
    rule: "Não há retenção nem compactação do log antes do lançamento.",
    sources: ["ADR 0030"],
    status: "proposta",
  },
  {
    approvedOn: "2026-10-18",
    basis: "decisao",
    class: "data_exports",
    data: [
      "data_exports e data_export_files",
      "R2 exports/v1/ (arquivos da exportação)",
    ],
    job: "privacy.data_export_expiry",
    period: { kind: "duration", ms: 24 * HOUR_MS },
    review: USER_APPROVED_REVIEW,
    rule: "A exportação pronta pode ser baixada por 24 horas; a que falhou fica 24 horas. Depois o job horário a expira e apaga os objetos no R2 antes de marcar os arquivos como apagados. Prazo aprovado pelo responsável em 18/10/2026.",
    sources: ["ADR 0078", "docs/business-rules/privacy.md"],
    status: "aprovada",
  },
  {
    approvedOn: "2026-10-19",
    basis: "decisao",
    class: "closed_organization",
    data: ["todos os dados de uma organização closed"],
    job: "privacy.closure_purge_schedule",
    period: { days: 90, kind: "closure_calendar_days" },
    review: USER_APPROVED_REVIEW,
    rule: "Nada é apagado na janela de recuperação. D é a data local do pedido de encerramento mais 90 dias de calendário, no fuso da organização. Em D menos 7 dias a varredura de privacidade agenda o purge sozinha (ADR 0102), sem caso de privacidade, e ele nunca roda antes do maior entre D mais 48 horas e o agendamento mais 7 dias; não agenda com legal hold vigente, acesso temporário do Admin vigente, cancelamento de purge pelo Admin depois deste encerramento ou renovação ainda viva no provedor, e uma trava solta depois do agendamento adia o purge para a soltura mais 7 dias. O agendamento automático fica atrás de CLOSURE_AUTO_PURGE_ENABLED, desligado até o go-live; o comando administrativo com caso de privacidade continua para exceções. Nos 90 dias o lojista só lê e exporta; o purge respeita o deletion ledger (decisão do responsável de 18/10/2026, prazo de 90 dias decidido e aprovado em 19/10/2026, ADR 0081).",
    sources: [
      "ADR 0074",
      "ADR 0081",
      "ADR 0102",
      "docs/business-rules/privacy.md",
    ],
    status: "aprovada",
  },
  {
    basis: "decisao",
    class: "closure_notice",
    data: [
      "closure_notices (os avisos do encerramento: organização, ciclo, marco, datas, o usuário a quem o aviso se destina, se foi enviado, pulado, falhou ou foi dispensado pelo responsável, e o número da reemissão do suporte; sem e-mail nem texto)",
    ],
    period: { kind: "undecided" },
    proposed:
      "Sobrevive ao purge da organização, para o dono ainda ler quando os dados foram apagados, e sai 6 meses depois do purge (ou do desfazer do encerramento, para os avisos daquele ciclo); sai antes com a conta do usuário, pela chave estrangeira em cascata (pergunta R2 do desenho t107, aceita na consolidação de 19/10/2026, ADR 0102 emendado). O prazo de 6 meses espera a decisão do responsável; nenhum job a apaga ainda.",
    review: { state: "pendente_juridica" },
    rule: "Cada marco do encerramento (o pedido, D menos 30 e menos 7 dias locais, D e o reagendamento depois de uma trava legal solta) vira uma linha quando a data chega, com ou sem e-mail. A linha guarda só IDs e datas: o endereço é lido da conta na hora do envio, por uma função do papel de autenticação, e nunca fica no aviso, no evento nem no log. O suporte reenvia ou dispensa um aviso gravando uma linha nova, nunca alterando a antiga; a dispensada não tem usuário. Nenhum papel de runtime a lê ou escreve diretamente; o purge não a apaga.",
    sources: ["ADR 0079", "ADR 0102", "docs/business-rules/privacy.md"],
    status: "proposta",
  },
  {
    approvedOn: "2026-10-18",
    basis: "decisao",
    blockedUntil: "access_record_table",
    class: "auth_sessions",
    data: [
      "session (IP e user-agent)",
      "device_sessions (que sessão usou que aparelho)",
    ],
    period: { kind: "duration", ms: 30 * DAY_MS },
    review: USER_APPROVED_REVIEW,
    rule: "Sessão vale no máximo 30 dias; a linha expirada fica mais 30 dias depois do fim (expires_at) e então é apagada (decisão do responsável de 18/10/2026). A linha guarda o IP da sessão (o último visto, atualizado a cada atualização diária e a cada troca de IP), mas o registro de acesso de 6 meses do Marco Civil mora na tabela própria `auth_access_log` (ADR 0092), então apagar a sessão não perde o IP. O vínculo `device_sessions` (sessão, aparelho, usuário e instante, sem organização) segue a sessão: é apagado em cascata quando a sessão é apagada (saída, expurgo, revogação do aparelho) e quando o aparelho é apagado, então não precisa de prazo próprio. O bloqueio `access_record_table` está resolvido; o job de expurgo de sessões ainda não existe.",
    sources: [
      "docs/business-rules/authentication.md",
      "docs/business-rules/privacy.md",
      "ADR 0079",
    ],
    status: "aprovada",
  },
  {
    approvedOn: "2026-10-19",
    basis: "lei",
    class: "devices",
    data: [
      "devices (aparelho revogado: rótulo, criação, último uso e revogação)",
    ],
    legalReview: "pending",
    legalSources: [
      "LGPD (Lei 13.709/2018), art. 6º, III",
      "LGPD (Lei 13.709/2018), art. 16",
    ],
    period: { kind: "duration", ms: 90 * DAY_MS },
    review: USER_APPROVED_REVIEW,
    rule: "O aparelho revogado fica 90 dias depois da revogação (revoked_at) e então é apagado; se o último uso (last_seen_at) for posterior, a contagem parte dele, então o aparelho nunca é apagado antes de 90 dias sem uso (decisão do responsável de 19/10/2026, delegada ao orquestrador com base em pesquisa, POL-80; necessidade e eliminação ao fim do tratamento, LGPD art. 6º III e art. 16; revisão de contador ou jurídico recomendada antes do go-live, sem bloquear). O aparelho é do usuário, sem organização, e não guarda impressão digital: só id aleatório, rótulo digitado, datas. O vínculo `device_sessions` segue a classe de sessões (`auth_sessions`): o aparelho apagado leva os vínculos em cascata. A auditoria `device_revoked` guarda só o identificador e segue a classe `auth_security_audit`. Nenhum job novo: o expurgo ainda não existe.",
    sources: ["ADR 0048", "ADR 0079", "docs/business-rules/privacy.md"],
    status: "aprovada",
  },
  {
    approvedOn: "2026-10-18",
    basis: "decisao",
    class: "auth_verification",
    data: ["verification (tokens de verificação e recuperação)"],
    period: { kind: "duration", ms: DAY_MS },
    review: USER_APPROVED_REVIEW,
    rule: "Token transacional não tem uso depois de expirar; é apagado um dia depois de expirar (decisão do responsável de 18/10/2026). O job de expurgo ainda não existe.",
    sources: ["docs/business-rules/authentication.md", "ADR 0079"],
    status: "aprovada",
  },
  {
    approvedOn: "2026-10-19",
    basis: "decisao",
    class: "auth_login_lock",
    data: [
      "auth_login_lock (contador de falhas de senha por e-mail digitado, só HMAC do e-mail normalizado)",
    ],
    job: "auth.login_lock_expiry",
    period: { kind: "duration", ms: DAY_MS },
    review: USER_APPROVED_REVIEW,
    rule: "O bloqueio da entrada por senha (5 falhas em 15 minutos travam por 15 minutos) guarda uma linha por e-mail digitado, exista a conta ou não, e ela não tem uso depois de 1 dia sem mudar (`updated_at`): é apagada pelo job horário `auth.login_lock_expiry` (decisão do usuário de 19/10/2026, ADR 0100). A chave é o HMAC-SHA-256 do e-mail normalizado com escopo e `BETTER_AUTH_SECRET`; a tabela não guarda o e-mail, o ID do usuário nem o IP, então não tem dado pessoal legível e não entra no purge da organização. A limpeza da própria chave na tentativa seguinte é oportunista; o prazo de 1 dia vale a todas.",
    sources: ["ADR 0100", "ADR 0079", "docs/business-rules/authentication.md"],
    status: "aprovada",
  },
  {
    approvedOn: "2026-10-19",
    basis: "decisao",
    class: "auth_unverified_user",
    data: [
      "user (cadastro por e-mail e senha cujo e-mail nunca foi verificado), com a conta `credential` que ele leva em cascata",
    ],
    job: "auth.unverified_user_purge",
    period: { kind: "duration", ms: DAY_MS },
    review: USER_APPROVED_REVIEW,
    rule: "O cadastro por senha com e-mail não verificado não tem uso depois que o link de verificação vence: é apagado 24 horas depois de criado (`created_at`) pelo job horário `auth.unverified_user_purge` (Q-D2 do desenho da tela de entrada, ADR 0100). Só se apaga o usuário que cumpre TODAS as condições juntas: e-mail não verificado, nenhuma conta além de `credential` (sem Google), nenhuma sessão, nenhum vínculo com organização e mais de 24 horas de criado; qualquer uma que falte o preserva. Isso limita a janela do risco herdado do ADR 0044: quem cria conta por senha com o e-mail de outra pessoa e nunca verifica deixa de travar a entrada por Google dela depois de 24 horas, mas pode cadastrar o e-mail de novo (o recadastro e o link de verificação reenviado, que o apagamento não invalida, ficam como risco aceito do ADR 0100). Cada apagamento grava uma linha `unverified_user_deleted` na auditoria de autenticação (classe `auth_security_audit`) com o ID do usuário apagado e o da execução, nunca o e-mail, o nome nem o IP. O usuário não tem organização e não entra no purge da organização.",
    sources: ["ADR 0100", "ADR 0079", "docs/business-rules/authentication.md"],
    status: "aprovada",
  },
  {
    approvedOn: "2026-10-18",
    basis: "decisao",
    class: "auth_security_audit",
    data: ["auth_security_audit_event"],
    legalReview: "pending",
    period: { kind: "calendar_months", months: 12 },
    review: USER_APPROVED_REVIEW,
    rule: "A auditoria de segurança da autenticação (Google, saída e revogação de aparelho que encerrou sessões) fica 12 meses, como a auditoria de segurança do tenant (decisão do usuário de 19/10/2026; antes eram 6 meses). Os 6 meses do Marco Civil são o mínimo do registro de acesso, que é outra classe (`auth_access_log`), e não o desta; a norma pede sigilo, ambiente controlado e de segurança para o registro de acesso (decisão do responsável de 18/10/2026, delegada ao orquestrador com base em pesquisa, POL-80; revisão de contador ou jurídico recomendada antes do go-live, sem bloquear). A tabela guarda data, hora, ator e identificador da requisição e, na revogação de aparelho, o aparelho revogado, quantas sessões caíram e a sessão e o aparelho de quem revogou (identificadores, nunca o token), mas não o IP: o IP de cada acesso está em `auth_access_log` (classe `auth_access_log`, ADR 0092). O prazo é contado em meses corridos e, ao somar meses, o dia que não existe no mês de destino passa ao mês seguinte (nunca encurta o prazo). O job de expurgo ainda não existe.",
    sources: ["docs/business-rules/privacy.md", "ADR 0079"],
    status: "aprovada",
  },
  {
    approvedOn: "2026-10-18",
    basis: "lei",
    blockedUntil: "access_log_hold",
    class: "auth_access_log",
    data: ["auth_access_log (data, hora e IP de cada acesso, por usuário)"],
    legalReview: "pending",
    legalSources: [
      "Marco Civil da Internet (Lei 12.965/2014), art. 15",
      "Marco Civil da Internet (Lei 12.965/2014), art. 15, §2º",
    ],
    period: { graceDays: 30, kind: "calendar_months", months: 6 },
    review: USER_APPROVED_REVIEW,
    rule: "O registro de acesso a aplicação (login, login que falhou, saída e atualização da sessão, com o IP da requisição) fica 6 meses corridos mais 30 dias de folga (o mínimo do Marco Civil são os 6 meses; a folga só alonga, decisão do usuário de 19/10/2026), em sigilo e em ambiente de segurança; só se fornece com ordem judicial (decisão do responsável de 18/10/2026, delegada ao orquestrador, POL-80; revisão de contador ou jurídico recomendada antes do go-live, sem bloquear). Não tem organização: sobrevive ao purge da organização e à exclusão do usuário, e só sai pelo prazo. O prazo está aprovado, mas nenhum job de expurgo pode existir enquanto não houver a guarda cautelar do art. 15, §2º (`blockedUntil: access_log_hold`): apagar sem ela pode descumprir um pedido de guarda por prazo maior. Nenhuma linha vence antes de 6 meses do go-live. O job futuro corta a data no banco (6 meses mais a folga de 30 dias, que também cobre o mês curto) e pula o usuário sob guarda. Não há porta lógica de origem: a Cloudflare não a entrega ao Worker (limite no ADR 0092).",
    sources: [
      "docs/business-rules/privacy.md",
      "docs/business-rules/authentication.md",
      "ADR 0079",
      "ADR 0092",
    ],
    status: "aprovada",
  },
  {
    approvedOn: "2026-10-19",
    basis: "decisao",
    blockedUntil: "account_deletion_event",
    class: "legal_acceptance",
    data: [
      "legal_acceptance (aceite dos termos de uso e da política de privacidade: documento, versão, SHA-256 do texto, hora do servidor, origem e identificador da requisição, por usuário; sem IP nem navegador)",
    ],
    legalReview: "pending",
    legalSources: [
      "LGPD (Lei 13.709/2018), art. 7º, VI",
      "LGPD (Lei 13.709/2018), art. 16",
    ],
    period: { kind: "calendar_months", months: 120 },
    review: USER_APPROVED_REVIEW,
    rule: 'O aceite legal fica 10 anos depois da exclusão da conta (decisão do usuário de 19/10/2026, ADR 0100; a validação do advogado é recomendada antes do go-live, sem bloquear). "Fim do contrato" é a data em que a conta é excluída, e quem a define é a rotina de exclusão de conta: é ela que grava o `blockedUntil` (essa data mais 10 anos) no evento de exclusão, para as linhas daquele `user_id`. Enquanto a conta existe nada vence. A linha não tem organização nem chave estrangeira para o usuário, então sobrevive ao purge da organização e à exclusão do usuário; é só de acrescentar (gatilho), por isso o expurgo é uma função própria, do dono de retenção e sem job, que entra com a rotina de exclusão de conta (`blockedUntil: account_deletion_event`). A tabela não guarda IP nem navegador.',
    sources: [
      "ADR 0100",
      "ADR 0079",
      "docs/business-rules/privacy.md",
      "docs/business-rules/authentication.md",
    ],
    status: "aprovada",
  },
  {
    basis: "decisao",
    class: "platform_audit_and_support",
    data: ["platform_audit_events", "support_cases", "tenant_access_grants"],
    legalReview: "pending",
    legalSources: [
      "Código de Defesa do Consumidor (Lei 8.078/1990), art. 27 (hipótese: aplicação a lojistas a validar)",
    ],
    period: { kind: "undecided" },
    proposed: `Sobrevive à organização, sem dado pessoal, por 5 anos (decidido em 18/10/2026; o registro ainda não expressa "ano seguinte mais 5 anos"); a revisão de advogado do CDC, art. 27, é recomendada, sem bloquear; aprovado pelo usuário em 19/10/2026.`,
    review: USER_APPROVED_REVIEW,
    rule: "O Admin registra cada acesso e comando; não há prazo na main. No purge da organização, o caso de suporte perde o texto livre (motivo, contexto e resolução) e fica só o registro (decisão do responsável de 18/10/2026, ADR 0081).",
    sources: ["ADR 0070", "ADR 0072", "ADR 0073"],
    status: "proposta",
  },
  {
    basis: "lei",
    class: "privacy_cases",
    data: ["privacy_cases", "privacy_case_actions"],
    legalReview: "pending",
    period: { kind: "undecided" },
    proposed: `Sobrevive à organização como evidência do atendimento, sem dado pessoal, por 5 anos (decidido em 18/10/2026; o registro ainda não expressa "ano seguinte mais 5 anos"); aprovado pelo usuário em 19/10/2026; revisão de advogado recomendada, sem bloquear.`,
    review: USER_APPROVED_REVIEW,
    rule: "O caso guarda só códigos e referência opaca; sobrevive ao purge porque a linha da organização fica como tombstone (chave estrangeira restritiva preservada). O purge apaga as notas (texto livre) e mantém datas, tipo, decisão e IDs opacos (decisão do responsável de 18/10/2026, ADR 0081).",
    sources: ["ADR 0077", "ADR 0081"],
    status: "proposta",
  },
  {
    basis: "decisao",
    class: "deletion_ledger",
    data: ["deletion_ledger (tombstones de anonimização e de purge)"],
    legalReview: "pending",
    period: { kind: "undecided" },
    proposed:
      "Sobrevive à organização, por 5 anos (aprovado pelo usuário em 19/10/2026), sem job; não expira antes da janela de restauração mais longa do provedor (35 dias); revisão de advogado recomendada, sem bloquear.",
    review: USER_APPROVED_REVIEW,
    rule: "O purge da organização não apaga o ledger; enquanto um backup anterior ao tombstone puder ser restaurado, o tombstone precisa existir. Um gatilho ENABLE ALWAYS recusa UPDATE, DELETE e TRUNCATE (migration 0080), e nenhum papel o apaga: a remoção por prazo exige uma migration revisada.",
    sources: ["ADR 0080", "docs/business-rules/privacy.md"],
    status: "proposta",
  },
  {
    basis: "decisao",
    class: "event_outbox",
    data: ["event_outbox (eventos a despachar, só IDs opacos)"],
    period: { kind: "undecided" },
    proposed: `Apagar os eventos despachados depois de um prazo curto, definido com o despachante (${TO_CONFIRM}); os pendentes saem com o purge da organização.`,
    review: USER_APPROVED_REVIEW,
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
    review: USER_APPROVED_REVIEW,
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
    review: USER_APPROVED_REVIEW,
    rule: "O incidente guarda só código, contagem, datas e uma referência opaca; o item guarda só o ID do evento e da organização. Fora do purge nenhum papel apaga; o expurgo é do job agendado (PR112). O purge da organização apaga os itens dela explicitamente (política e DELETE do papel do purge, ADR 0081): a cascata da chave estrangeira não dispara, porque o purge mantém a linha da organização. O incidente não tem organização e não entra no purge.",
    sources: ["ADR 0085"],
    status: "proposta",
  },
  {
    approvedOn: "2026-10-18",
    basis: "contrato",
    class: "provider_backups",
    data: [
      "backups e branches do provedor de banco",
      "cópias fora do banco ativo",
    ],
    period: { kind: "provider_rotation" },
    review: USER_APPROVED_REVIEW,
    rule: "A anonimização e o purge não alcançam backups do provedor: eles expiram pela rotação do provedor, e o dado apagado some deles ao fim dela (decisão do responsável de 18/10/2026); restore reaplica o deletion ledger. A janela de backup é de 35 dias (decisão do usuário de 19/10/2026; antes, 30 a 35 dias) e, depois de qualquer restore, as eliminações são reaplicadas pelo deletion ledger (ADR 0079). Prazo no Neon Free (ADR 0076): 6 horas de histórico de restauração, limitado a 1 GB de mudanças, pela documentação do Neon consultada em 18/10/2026; Launch e Scale seriam 7 e 30 dias, mas nenhum plano pago está contratado. O R2 não tem política de versões ou cópias de objetos apagados descrita na documentação consultada, e o Polaris não configura backup de bucket. Conferir o prazo configurado na conta antes do go-live.",
    sources: ["ADR 0075", "ADR 0076", "docs/business-rules/privacy.md"],
    status: "aprovada",
  },
] satisfies readonly RetentionPolicy[]);

/** The purge jobs that exist today, each tied to the class it expires. */
export const RETENTION_PURGE_JOBS: readonly {
  class: RetentionClass;
  id: RetentionPurgeJobId;
}[] = Object.freeze([
  { class: "auth_login_lock", id: "auth.login_lock_expiry" },
  { class: "auth_unverified_user", id: "auth.unverified_user_purge" },
  { class: "media_staging_marker", id: "media.staging_reconcile" },
  { class: "media_removed_image", id: "media.removed_cleanup" },
  { class: "data_exports", id: "privacy.data_export_expiry" },
  { class: "queue_processing", id: "outbox.processing_expiry" },
  { class: "closed_organization", id: "privacy.closure_purge_schedule" },
]);

/**
 * Removals an explicit administrative command starts, naming what to remove: the purge of a closed
 * organization under an accepted privacy case (ADR 0081), which stays for the exceptions (a purge
 * rescheduled after a legal hold, or cancelled and decided again) next to the job of the closure period
 * (ADR 0102). A removal of this list may exist for a class that is only proposed; a job of
 * `RETENTION_PURGE_JOBS` never can.
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

/**
 * When data that started to count at `from` may be removed, for a class with a
 * period counted from a moment (a duration or calendar months). A class kept
 * until the purge or until the provider rotates its copies has no such moment.
 */
export function retentionExpiry(
  retentionClass: RetentionClass,
  from: Date
): Date {
  const policy = retentionPolicy(retentionClass);
  if (policy.status !== "aprovada") {
    throw new RetentionNotApprovedError(retentionClass);
  }
  if (policy.period.kind === "duration") {
    return new Date(from.getTime() + policy.period.ms);
  }
  if (policy.period.kind === "calendar_months") {
    const expiry = new Date(from.getTime());
    expiry.setUTCMonth(expiry.getUTCMonth() + policy.period.months);
    expiry.setUTCDate(expiry.getUTCDate() + (policy.period.graceDays ?? 0));
    return expiry;
  }
  throw new RetentionNotApprovedError(retentionClass);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/** Whether a legal review is a finished one: named reviewer and a calendar date. */
export function isLegalReviewComplete(
  review: LegalReview | undefined
): boolean {
  if (typeof review !== "object" || review === null) {
    return false;
  }
  const { reviewedAt, reviewedBy } = review as Partial<
    Record<"reviewedAt" | "reviewedBy", unknown>
  >;
  return (
    typeof reviewedBy === "string" &&
    reviewedBy.trim() !== "" &&
    typeof reviewedAt === "string" &&
    isCalendarDate(reviewedAt)
  );
}

/**
 * The classes whose legal review is missing or invalid: a class whose basis is the law (or that
 * names legal sources) must say `"pending"` or who validated it and when, and a review that is
 * not `"pending"` without `reviewedBy` and `reviewedAt` is a defect.
 */
export function legalReviewDefects(
  policies: readonly RetentionPolicy[] = RETENTION_POLICIES
): RetentionClass[] {
  return policies.flatMap((policy) => {
    const legal = policy.basis === "lei" || policy.legalSources !== undefined;
    const review = policy.legalReview;
    if (review === undefined) {
      return legal ? [policy.class] : [];
    }
    return review === "pending" || isLegalReviewComplete(review)
      ? []
      : [policy.class];
  });
}

/** The legal classes still waiting for the accountant or the lawyer (a warning in the release checklist, not a block). */
export function pendingLegalReviews(
  policies: readonly RetentionPolicy[] = RETENTION_POLICIES
): RetentionClass[] {
  return policies.flatMap((policy) =>
    policy.legalReview === "pending" ? [policy.class] : []
  );
}

/** The blocker of a class that is still active, if any. */
export function activeRetentionBlocker(
  policy: RetentionPolicy,
  resolved: readonly RetentionBlocker[] = RESOLVED_RETENTION_BLOCKERS
): RetentionBlocker | undefined {
  return policy.blockedUntil && !resolved.includes(policy.blockedUntil)
    ? policy.blockedUntil
    : undefined;
}

/**
 * The classes that have a purge job registered (in the jobs list or on the policy itself) while a
 * blocker is active. Empty means no job deletes what the blocker still protects.
 */
export function blockedPurgeJobs(
  jobs: readonly { class: RetentionClass }[] = RETENTION_PURGE_JOBS,
  policies: readonly RetentionPolicy[] = RETENTION_POLICIES,
  resolved: readonly RetentionBlocker[] = RESOLVED_RETENTION_BLOCKERS
): RetentionClass[] {
  return policies.flatMap((policy) => {
    if (activeRetentionBlocker(policy, resolved) === undefined) {
      return [];
    }
    const hasJob =
      ("job" in policy && policy.job !== undefined) ||
      jobs.some((job) => job.class === policy.class);
    return hasJob ? [policy.class] : [];
  });
}
