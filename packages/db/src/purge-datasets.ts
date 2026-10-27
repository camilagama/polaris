/**
 * What the purge of an organization removes and what survives it (plan PR107, ADR 0081). Every table
 * with an `organization_id` is in exactly one of the lists below, and the purge gate reads the catalog
 * and fails when a table is in neither: whoever creates a table with an organization decides here
 * whether the purge removes it. The order of `PURGE_DELETE_ORDER` is the order of
 * `purge_organization_data` (the restrictive foreign keys between the tenant's tables decide it).
 */

/** Deleted explicitly by `purge_organization_data`, in this order. */
export const PURGE_DELETE_ORDER = Object.freeze([
  "sale_return_items",
  "sale_returns",
  "sale_payments",
  "sale_adjustments",
  "sale_cancellations",
  "sale_customer_links",
  "expenses",
  "sale_items",
  "sales",
  "stock_movements",
  "inventory_balances",
  "variant_media",
  "product_media",
  "product_publications",
  "operational_variant_selections",
  "products",
  "media_assets",
  "categories",
  "customers",
  "goal_target_changes",
  "goals",
  "expense_recurring_rules",
  "expense_categories",
  "payment_profile_rules",
  "payment_profiles",
  "sync_commands",
  "sync_changes",
  "sync_cursors",
  "offline_grants",
  "data_export_files",
  "data_exports",
  "public_catalog_profiles",
  "billing_notices",
  "event_outbox",
  "queue_processing",
  "queue_dead_letters",
  "organization_closures",
  "memberships",
] as const);

/** Removed with their product by the foreign key cascade (deleting a default variant directly is refused). */
export const PURGE_CASCADED_TABLES = Object.freeze([
  "product_variants",
  "product_options",
  "product_option_values",
  "variant_option_values",
] as const);

/**
 * Tables with an organization that the purge keeps, and why. `tenant_audit_event` is one of them since 19/10/2026
 * (ADR 0081, amended): nothing of the audit leaves in the purge. Since the decisions of 18/10/2026 (ADR 0081) the
 * purge also rewrites four of them in the same transaction: the facts of `billing_events` lose every key but
 * `PURGE_BILLING_FACT_KEYS` (a pseudonymization: the provider's references stay and still find the payer at the
 * provider), and the free text of `support_cases`, `privacy_cases` (no organization column: it hangs from the
 * support case), `organization_purge_cancellations` and `entitlement_grants` is removed.
 */
export const PURGE_SURVIVING_TABLES: Readonly<Record<string, string>> =
  Object.freeze({
    billing_events:
      "Registro financeiro da plataforma, mantido pelo prazo fiscal (5 anos do 1º de janeiro seguinte): o purge pseudonimiza o fato (fica só valores, datas, tipos e referências opacas; sai nome, documento, e-mail, telefone e endereço do pagador) e mantém a linha, com `provider_ref` e `provider_event_id`, que ainda localizam o pagador no provedor e servem à conciliação, ao estorno e à contestação (ADR 0081, decisão de 18/10/2026).",
    billing_trial_claims:
      "O teste grátis é por pessoa (ADR 0101): a reserva ou o consumo do trial de um usuário, com a organização em que foi usado e as datas, sem dado do pagador. Sobrevive ao purge da organização como antiabuso (quem apaga a loja não ganha outro trial) e sai com a conta do usuário (chave estrangeira em cascata); classe de retenção `billing_trial_claims`.",
    closure_notices:
      "Os avisos do encerramento (ADR 0102 emendado): organização, ciclo, marco, datas, a reemissão do suporte e o usuário a quem cada aviso se destina (nenhum no aviso dispensado), sem e-mail nem texto livre. Sobrevivem ao purge para o dono ainda ler quando os dados foram apagados; a chave estrangeira da organização é restritiva e a do usuário é em cascata (saem com a conta). Classe de retenção `closure_notice` (proposta: 6 meses depois do purge).",
    deletion_ledger:
      "Tombstones para o restore: sobrevivem à organização, sem expiração (ADR 0080).",
    entitlement_grants:
      "Concessões da plataforma, parte do registro de cobrança (ADR 0067 e 0079): ficam a chave, o valor, as datas e o identificador de quem concedeu, sem dado do pagador; o motivo escrito pelo operador é trocado por um texto fixo no purge (ADR 0081, decisão de 18/10/2026).",
    organization_billing:
      "Estado da assinatura, `provider_ref` e `provider_subscription_id`, as referências da assinatura no provedor: registro da plataforma sem dado do pagador na linha, mas a referência localiza o pagador no provedor (pseudonimização), mantida pelo prazo fiscal; o purge exige que o trial ou o acesso pago tenha terminado (ADR 0081).",
    organization_legal_holds:
      "Registro das travas legais (quem, sob qual caso, quando entrou e saiu), sem texto livre: é a prova de que o purge esperou a trava (ADR 0081).",
    organization_purge_cancellations:
      "Histórico append-only dos cancelamentos de purge (quem, sob qual caso, qual agendamento); o motivo escrito pelo operador é trocado por um texto fixo no purge (ADR 0081, decisão de 18/10/2026).",
    organization_purges:
      "O registro do próprio purge (quem agendou, até onde foi, quando começou a mexer no armazenamento e quando terminou), sem dado pessoal.",
    platform_audit_events:
      "Auditoria do Admin, imutável: sobrevive à organização (ADR 0070 e 0079). O detalhe é curto, um código ou um resultado; o reenvio de um evento morto (ADR 0085) deixou de gravar o motivo do operador (migration 0075), mas uma linha escrita antes dela pode trazê-lo, e o purge não reescreve a auditoria (limite no ADR 0081).",
    platform_internal_organizations:
      "Marcador da plataforma de que a loja é do próprio Polaris (QA, do dono, do time) e fica fora do funil de ativação (ADR 0071 emendado): só o ID da loja, o instante e o operador que marcou, sem dado pessoal nem texto livre. Vive com a linha da organização, que o purge mantém, e sai com ela (chave estrangeira em cascata); a loja purgada já fica fora do funil.",
    rls_poc_operations:
      "Tabela da prova de RLS da Fase 1, sem chave estrangeira para organizations e sem dado de tenant real.",
    support_cases:
      "Casos de suporte e de privacidade: o registro do caso (datas, tipo, decisão, IDs opacos) sobrevive como evidência do atendimento; o texto livre é apagado no purge (ADR 0077 e 0081, decisão de 18/10/2026).",
    tenant_access_grants:
      "Acessos temporários do Admin: registro de acesso privilegiado, sem texto livre, sobrevive à organização (ADR 0072).",
    tenant_audit_event:
      "Auditoria do tenant: sobrevive ao purge, imutável (gatilho ENABLE ALWAYS que recusa UPDATE, DELETE e TRUNCATE) e com a chave estrangeira da organização restritiva. Sai só por prazo, conforme a classe do evento (`security`: 12 meses do evento; `operational`: 6 meses depois do purge), pela função `expire_tenant_audit_events` do papel `polaris_retention_owner`, que pula a organização sob legal hold. O motivo: é o registro de quem fez o quê numa organização cujo dono pediu a exclusão, e uma apuração futura (fraude, disputa, ordem judicial) precisa dele; só IDs opacos, sem dado pessoal além do identificador do usuário (decisão de 19/10/2026, ADR 0081 emendado).",
  });

/**
 * Tables without an organization column (the access log, the sign-in lock, the record of legal acceptance, the queues, the scheduler and the link between a session
 * and a device): nothing of a tenant to remove (ADR 0081). The purge gate proves they still have none; a column of
 * an organization moves the table to one of the lists above.
 */
export const PURGE_TABLES_WITHOUT_TENANT_DATA: Readonly<
  Record<string, string>
> = Object.freeze({
  auth_access_log:
    "Registro de acesso do Marco Civil (art. 15), por usuário e sem organização: sobrevive ao purge da organização e à exclusão do usuário, e só sai pelo prazo de 6 meses, com a guarda cautelar do §2º (ADR 0092 e 0081).",
  auth_login_lock:
    "Contador do bloqueio da entrada por senha, uma linha por e-mail digitado e sem organização: a chave é o HMAC do e-mail normalizado (nem e-mail, nem usuário, nem IP), e a linha dura no máximo 1 dia (classe `auth_login_lock`, ADR 0100).",
  legal_acceptance:
    "Aceite dos termos e da política de privacidade, por usuário e sem organização: a linha só acrescenta (gatilho), sobrevive ao purge da organização e à exclusão do usuário, e fica 5 anos depois da exclusão da conta (classe `legal_acceptance`, ADR 0100; 6 meses e 30 dias depois do apagamento, para quem nunca confirmou o e-mail, classe `legal_acceptance_unverified_user`). Sem IP.",
  legal_acceptance_contract_end:
    "Fim do contrato do usuário (ID opaco, instante e motivo), de onde contam os 5 anos do aceite (6 meses e 30 dias, para o motivo `unverified_user_deleted`), sem organização: só acrescenta (gatilho), sobrevive ao purge da organização e à exclusão do usuário, e sai junto com o aceite, pela mesma função de expurgo futura (classes `legal_acceptance` e `legal_acceptance_unverified_user`, ADR 0100).",
  device_sessions:
    "Vínculo entre sessão e aparelho de um usuário, sem organização: some com a sessão ou com o aparelho (chave estrangeira em cascata), e a retenção é a da classe `auth_sessions`. A classe de retenção dos aparelhos (`devices`) ainda não foi decidida.",
  operational_incidents:
    "Uma linha por causa (contagem, datas e uma referência opaca, o ID de um evento), sem organização (ADR 0085 e 0087).",
  scheduled_job_state:
    "Estado do agendador por job (janelas, lease, falhas), sem organização nem dado pessoal (ADR 0086).",
});

/**
 * The keys a billing fact keeps after the purge (ADR 0081, decision of 18/10/2026): what the lifecycle writes
 * (`serializeBillingFact` and the ledger's commands), that is values, dates, types and opaque references, and since
 * migration 0084 the amount and currency of a money fact (the fiscal record, ADR 0101).
 * `purge_organization_data` holds the same list (`kept_fact_keys`); any other key, such as a payer's name,
 * document, e-mail, phone, address or ID, is removed from the fact. This is pseudonymization, not anonymization:
 * the columns `provider_ref` and `provider_event_id` stay outside the fact and still find the payer at the provider.
 */
export const PURGE_BILLING_FACT_KEYS = Object.freeze([
  "type",
  "occurredAt",
  "cycleMonths",
  "periodEndsAt",
  "transition",
  "grantId",
  "key",
  "startsAt",
  "expiresAt",
  "actor",
  "amount",
  "currency",
] as const);

/** What the purge writes in place of the free text it removes from the cases and the purge cancellations. */
export const PURGE_REMOVED_TEXT = "Texto removido pelo purge da organização.";
