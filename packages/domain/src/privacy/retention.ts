/**
 * Retention by data class (plan PR105, ADR 0079): how long each kind of data
 * is kept, where that rule comes from and whether it was approved. This is the
 * single place a period is declared; code that expires data reads its period
 * from here, never from a constant of its own.
 *
 * There is no single period for everything. A class is `aprovada` only when a
 * decision already on main (an ADR or a business rule) fixes it; everything
 * else is `proposta`, with the proposed period written in the ADR and no job.
 * A legal period (tax, accounting, LGPD, Marco Civil) is the responsible
 * person's decision and is never approved by code: a class whose basis is the
 * law stays proposed until that decision is recorded, and an approved one
 * carries the date of the decision and the norms it rests on (`approvedOn`,
 * `legalSources`). The legal periods still need the confirmation of an
 * accountant or a lawyer before go-live: every class whose basis is the law
 * carries `legalReview`, `"pending"` until that person has validated it, and a
 * pending one blocks the promotion to production (release checklist, item 10).
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
  "auth_access_log",
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
 * What a class waits for before a purge job may exist for it. Each key is a thing that does not
 * exist yet; a blocker leaves `RESOLVED_RETENTION_BLOCKERS` untouched until the thing is built.
 */
export const RETENTION_BLOCKERS = Object.freeze({
  access_log_hold:
    "Guarda cautelar do registro de acesso (Marco Civil art. 15, §2º): a autoridade policial, administrativa ou o Ministério Público pode pedir a guarda por prazo maior que 6 meses, e o expurgo precisa pular o usuário ou o IP sob guarda antes de existir. Sem a guarda, nenhum job de expurgo do registro pode ser registrado (ADR 0092).",
  access_record_table:
    "Tabela própria do registro de acesso a aplicação (data, hora e IP, 6 meses, Marco Civil art. 15); tarefa t039. Resolvido: a tabela `auth_access_log` existe (ADR 0092).",
});

export type RetentionBlocker = keyof typeof RETENTION_BLOCKERS;

/** The blockers already lifted. The change that builds the thing a blocker waits for adds it here. */
export const RESOLVED_RETENTION_BLOCKERS: readonly RetentionBlocker[] =
  Object.freeze(["access_record_table"]);

/** The purge jobs that already exist; each one serves exactly one approved class. */
export type RetentionPurgeJobId =
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

/** Kept for a number of calendar months (a legal minimum is counted in months, not days). */
interface ApprovedCalendarMonths extends RetentionPolicyBase {
  period: { kind: "calendar_months"; months: number };
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

/** Not decided: no period is enforced and no job may exist. */
interface ProposedPolicy extends RetentionPolicyBase {
  period: { kind: "undecided" };
  /** The proposed period, as written in ADR 0079 (a legal one says who confirms it). */
  proposed: string;
  status: "proposta";
}

export type RetentionPolicy =
  | ApprovedCalendarMonths
  | ApprovedDuration
  | ApprovedProviderRotation
  | ApprovedUntilPurge
  | ProposedPolicy;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

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
    approvedOn: "2026-10-18",
    basis: "decisao",
    class: "tenant_audit_events",
    data: ["tenant_audit_event"],
    period: { kind: "until_organization_purge" },
    rule: "Sem expiração automática. O Polaris é operador desses dados (LGPD) e a obrigação fiscal de guardá-los é do cliente, que tem a exportação: saem no purge ao fim do prazo de encerramento de 30 dias, salvo legal hold (decisão do responsável de 18/10/2026, ADR 0081).",
    sources: ["ADR 0006", "ADR 0081", "docs/business-rules/privacy.md"],
    status: "aprovada",
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
    approvedOn: "2026-10-18",
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
    approvedOn: "2026-10-18",
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
    approvedOn: "2026-10-18",
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
    legalReview: "pending",
    period: { kind: "undecided" },
    proposed: `Registro financeiro: 5 anos contados do 1º de janeiro do ano seguinte ao fato, decididos em 18/10/2026 (CTN, arts. 173 e 195; Código Civil, art. 1.194); o registro ainda não expressa "ano seguinte mais 5 anos" e a validação é ${TO_CONFIRM}.`,
    rule: "O runtime nunca apaga uma linha do razão: é uma restrição de quem pode apagar, não um prazo. O purge da organização mantém os eventos e pseudonimiza o pagador: o fato fica só com valores, datas, tipos e referências opacas, e `provider_ref` e `provider_event_id` continuam e ainda localizam o pagador no provedor, pelo prazo fiscal (5 anos do 1º de janeiro seguinte); o motivo das concessões vira texto fixo (decisão do responsável de 18/10/2026, ADR 0081).",
    sources: ["ADR 0062", "ADR 0066", "ADR 0081"],
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
    rule: "A exportação pronta pode ser baixada por 24 horas; a que falhou fica 24 horas. Depois o job horário a expira e apaga os objetos no R2 antes de marcar os arquivos como apagados. Prazo aprovado pelo responsável em 18/10/2026.",
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
    approvedOn: "2026-10-18",
    basis: "decisao",
    blockedUntil: "access_record_table",
    class: "auth_sessions",
    data: [
      "session (IP e user-agent)",
      "device_sessions (que sessão usou que aparelho)",
    ],
    period: { kind: "duration", ms: 30 * DAY_MS },
    rule: "Sessão vale no máximo 30 dias; a linha expirada fica mais 30 dias depois do fim (expires_at) e então é apagada (decisão do responsável de 18/10/2026). A linha guarda o IP da sessão (o último visto, atualizado a cada atualização diária e a cada troca de IP), mas o registro de acesso de 6 meses do Marco Civil mora na tabela própria `auth_access_log` (ADR 0092), então apagar a sessão não perde o IP. O vínculo `device_sessions` (sessão, aparelho, usuário e instante, sem organização) segue a sessão: é apagado em cascata quando a sessão é apagada (saída, expurgo, revogação do aparelho) e quando o aparelho é apagado, então não precisa de prazo próprio. O bloqueio `access_record_table` está resolvido; o job de expurgo de sessões ainda não existe.",
    sources: [
      "docs/business-rules/authentication.md",
      "docs/business-rules/privacy.md",
      "ADR 0079",
    ],
    status: "aprovada",
  },
  {
    approvedOn: "2026-10-18",
    basis: "decisao",
    class: "auth_verification",
    data: ["verification (tokens de verificação e recuperação)"],
    period: { kind: "duration", ms: DAY_MS },
    rule: "Token transacional não tem uso depois de expirar; é apagado um dia depois de expirar (decisão do responsável de 18/10/2026). O job de expurgo ainda não existe.",
    sources: ["docs/business-rules/authentication.md", "ADR 0079"],
    status: "aprovada",
  },
  {
    approvedOn: "2026-10-18",
    basis: "lei",
    class: "auth_security_audit",
    data: ["auth_security_audit_event"],
    legalReview: "pending",
    legalSources: ["Marco Civil da Internet (Lei 12.965/2014), art. 15"],
    period: { kind: "calendar_months", months: 6 },
    rule: "A auditoria de segurança da autenticação (Google, saída e revogação de aparelho que encerrou sessões) fica 6 meses, o mínimo do Marco Civil, junto do registro de acesso; a norma pede ainda sigilo, ambiente controlado e de segurança (decisão do responsável de 18/10/2026, delegada ao orquestrador com base em pesquisa, POL-80; validar com contador ou jurídico antes do go-live). A tabela guarda data, hora, ator e identificador da requisição e, na revogação de aparelho, o aparelho revogado, quantas sessões caíram e a sessão e o aparelho de quem revogou (identificadores, nunca o token), mas não o IP: o IP de cada acesso está em `auth_access_log` (classe `auth_access_log`, ADR 0092). O prazo é contado em meses corridos e, ao somar meses, o dia que não existe no mês de destino passa ao mês seguinte (nunca encurta o mínimo). O job de expurgo ainda não existe.",
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
    period: { kind: "calendar_months", months: 6 },
    rule: "O registro de acesso a aplicação (login, login que falhou, saída e atualização da sessão, com o IP da requisição) fica 6 meses corridos, o mínimo do Marco Civil, em sigilo e em ambiente de segurança; só se fornece com ordem judicial (decisão do responsável de 18/10/2026, delegada ao orquestrador, POL-80; validar com contador ou jurídico antes do go-live). Não tem organização: sobrevive ao purge da organização e à exclusão do usuário, e só sai pelo prazo. O prazo está aprovado, mas nenhum job de expurgo pode existir enquanto não houver a guarda cautelar do art. 15, §2º (`blockedUntil: access_log_hold`): apagar sem ela pode descumprir um pedido de guarda por prazo maior. Nenhuma linha vence antes de 6 meses do go-live. O job futuro corta a data no banco, com margem para o mês curto, e pula o usuário sob guarda. Não há porta lógica de origem: a Cloudflare não a entrega ao Worker (limite no ADR 0092).",
    sources: [
      "docs/business-rules/privacy.md",
      "docs/business-rules/authentication.md",
      "ADR 0079",
      "ADR 0092",
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
    proposed: `Sobrevive à organização, sem dado pessoal, por 5 anos (decidido em 18/10/2026; o registro ainda não expressa "ano seguinte mais 5 anos"); ${TO_CONFIRM} a validação jurídica do CDC, art. 27.`,
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
    proposed: `Sobrevive à organização como evidência do atendimento, sem dado pessoal, por 5 anos (decidido em 18/10/2026; o registro ainda não expressa "ano seguinte mais 5 anos"); ${TO_CONFIRM} a validação jurídica.`,
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
    approvedOn: "2026-10-18",
    basis: "contrato",
    class: "provider_backups",
    data: [
      "backups e branches do provedor de banco",
      "cópias fora do banco ativo",
    ],
    period: { kind: "provider_rotation" },
    rule: "A anonimização e o purge não alcançam backups do provedor: eles expiram pela rotação do provedor, e o dado apagado some deles ao fim dela (decisão do responsável de 18/10/2026); restore reaplica o deletion ledger. Prazo no Neon Free (ADR 0076): 6 horas de histórico de restauração, limitado a 1 GB de mudanças, pela documentação do Neon consultada em 18/10/2026; Launch e Scale seriam 7 e 30 dias, mas nenhum plano pago está contratado. O R2 não tem política de versões ou cópias de objetos apagados descrita na documentação consultada, e o Polaris não configura backup de bucket. Conferir o prazo configurado na conta antes do go-live.",
    sources: ["ADR 0075", "ADR 0076", "docs/business-rules/privacy.md"],
    status: "aprovada",
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

/** The legal classes still waiting for the accountant or the lawyer (they block the release). */
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
