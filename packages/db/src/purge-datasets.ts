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
  "tenant_audit_event",
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
 * Tables with an organization that the purge keeps, and why. Since the decisions of 18/10/2026 (ADR 0081) the
 * purge also rewrites four of them in the same transaction: the facts of `billing_events` lose every key but
 * `PURGE_BILLING_FACT_KEYS` (a pseudonymization: the provider's references stay and still find the payer at the
 * provider), and the free text of `support_cases`, `privacy_cases` (no organization column: it hangs from the
 * support case), `organization_purge_cancellations` and `entitlement_grants` is removed.
 */
export const PURGE_SURVIVING_TABLES: Readonly<Record<string, string>> =
  Object.freeze({
    billing_events:
      "Registro financeiro da plataforma, mantido pelo prazo fiscal (5 anos do 1º de janeiro seguinte): o purge pseudonimiza o fato (fica só valores, datas, tipos e referências opacas; sai nome, documento, e-mail, telefone e endereço do pagador) e mantém a linha, com `provider_ref` e `provider_event_id`, que ainda localizam o pagador no provedor e servem à conciliação, ao estorno e à contestação (ADR 0081, decisão de 18/10/2026).",
    deletion_ledger:
      "Tombstones para o restore: sobrevivem à organização, sem expiração (ADR 0080).",
    entitlement_grants:
      "Concessões da plataforma, parte do registro de cobrança (ADR 0067 e 0079): ficam a chave, o valor, as datas e o identificador de quem concedeu, sem dado do pagador; o motivo escrito pelo operador é trocado por um texto fixo no purge (ADR 0081, decisão de 18/10/2026).",
    organization_billing:
      "Estado da assinatura e `provider_ref`, a referência da assinatura no provedor: registro da plataforma sem dado do pagador na linha, mas a referência localiza o pagador no provedor (pseudonimização), mantida pelo prazo fiscal; o purge exige que o trial ou o acesso pago tenha terminado (ADR 0081).",
    organization_legal_holds:
      "Registro das travas legais (quem, sob qual caso, quando entrou e saiu), sem texto livre: é a prova de que o purge esperou a trava (ADR 0081).",
    organization_purge_cancellations:
      "Histórico append-only dos cancelamentos de purge (quem, sob qual caso, qual agendamento); o motivo escrito pelo operador é trocado por um texto fixo no purge (ADR 0081, decisão de 18/10/2026).",
    organization_purges:
      "O registro do próprio purge (quem agendou, até onde foi, quando começou a mexer no armazenamento e quando terminou), sem dado pessoal.",
    platform_audit_events:
      "Auditoria do Admin, imutável: sobrevive à organização (ADR 0070 e 0079). O detalhe é curto, um código ou um resultado; o reenvio de um evento morto (ADR 0085) deixou de gravar o motivo do operador (migration 0075), mas uma linha escrita antes dela pode trazê-lo, e o purge não reescreve a auditoria (limite no ADR 0081).",
    rls_poc_operations:
      "Tabela da prova de RLS da Fase 1, sem chave estrangeira para organizations e sem dado de tenant real.",
    support_cases:
      "Casos de suporte e de privacidade: o registro do caso (datas, tipo, decisão, IDs opacos) sobrevive como evidência do atendimento; o texto livre é apagado no purge (ADR 0077 e 0081, decisão de 18/10/2026).",
    tenant_access_grants:
      "Acessos temporários do Admin: registro de acesso privilegiado, sem texto livre, sobrevive à organização (ADR 0072).",
  });

/**
 * Tables that came with the queues and the scheduler and have no organization column: nothing of a tenant to
 * remove (ADR 0081). The purge gate proves they still have none; a column of an organization moves the table
 * to one of the lists above.
 */
export const PURGE_TABLES_WITHOUT_TENANT_DATA: Readonly<
  Record<string, string>
> = Object.freeze({
  operational_incidents:
    "Uma linha por causa (contagem, datas e uma referência opaca, o ID de um evento), sem organização (ADR 0085 e 0087).",
  scheduled_job_state:
    "Estado do agendador por job (janelas, lease, falhas), sem organização nem dado pessoal (ADR 0086).",
});

/**
 * The keys a billing fact keeps after the purge (ADR 0081, decision of 18/10/2026): what the lifecycle writes
 * (`serializeBillingFact` and the ledger's commands), that is values, dates, types and opaque references.
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
] as const);

/** What the purge writes in place of the free text it removes from the cases and the purge cancellations. */
export const PURGE_REMOVED_TEXT = "Texto removido pelo purge da organização.";
