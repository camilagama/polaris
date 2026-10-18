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

/** Tables with an organization that the purge keeps, and why. */
export const PURGE_SURVIVING_TABLES: Readonly<Record<string, string>> =
  Object.freeze({
    billing_events:
      "Registro financeiro da plataforma (controladora): prazo fiscal e contábil proposto, a confirmar pelo responsável (ADR 0079).",
    deletion_ledger:
      "Tombstones para o restore: sobrevivem à organização, sem expiração (ADR 0080).",
    entitlement_grants:
      "Concessões da plataforma, parte do registro de cobrança, com o motivo e o autor escritos pelo operador (ADR 0067 e 0079).",
    organization_billing:
      "Estado da assinatura e referência do cliente no provedor, registro da plataforma; o purge exige que o trial ou o acesso pago tenha terminado (ADR 0081).",
    organization_purges:
      "O registro do próprio purge (quem agendou, quando terminou e, se cancelado, o motivo curto que o operador escreveu), sem dado pessoal além desse texto livre.",
    platform_audit_events:
      "Auditoria do Admin, imutável: sobrevive à organização (ADR 0070 e 0079).",
    rls_poc_operations:
      "Tabela da prova de RLS da Fase 1, sem chave estrangeira para organizations e sem dado de tenant real.",
    support_cases:
      "Casos de suporte e de privacidade: evidência do atendimento, sobrevivem à organização (ADR 0077 e 0081).",
    tenant_access_grants:
      "Acessos temporários do Admin: registro de acesso privilegiado, sobrevive à organização (ADR 0072).",
  });
