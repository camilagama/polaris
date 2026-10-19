/**
 * What a data export holds (plan PR104, ADR 0078): the tables of the organization's own business
 * data, each read in full, and a list of the tenant tables that are left out, each with its reason.
 * The gate checks that every table of the organization is in one list or the other, so a table
 * added later cannot be forgotten: whoever adds it decides.
 */

export interface ExportDataset {
  /** The name of the file in the archive. */
  name: string;
  /** Columns that are internal machinery, not the organization's data. */
  omit?: readonly string[];
  table: string;
}

/** The organization's own row is read by its ID; every other table by its organization_id. */
export const ORGANIZATION_TABLE = "organizations";

export const EXPORT_DATASETS: readonly ExportDataset[] = Object.freeze([
  { name: "organizacao", table: ORGANIZATION_TABLE },
  { name: "categorias", table: "categories" },
  { name: "produtos", table: "products" },
  { name: "opcoes", table: "product_options" },
  { name: "valores-de-opcao", table: "product_option_values" },
  { name: "variantes", table: "product_variants" },
  { name: "variantes-valores-de-opcao", table: "variant_option_values" },
  {
    name: "imagens",
    omit: ["storage_key", "input_fingerprint", "upload_command_id"],
    table: "media_assets",
  },
  { name: "produtos-imagens", table: "product_media" },
  { name: "variantes-imagens", table: "variant_media" },
  { name: "clientes", table: "customers" },
  { name: "estoque-saldos", table: "inventory_balances" },
  { name: "estoque-movimentos", table: "stock_movements" },
  { name: "vendas", table: "sales" },
  { name: "vendas-itens", table: "sale_items" },
  { name: "vendas-ajustes", table: "sale_adjustments" },
  { name: "vendas-pagamentos", table: "sale_payments" },
  { name: "vendas-cancelamentos", table: "sale_cancellations" },
  { name: "vendas-devolucoes", table: "sale_returns" },
  { name: "vendas-devolucoes-itens", table: "sale_return_items" },
  { name: "vendas-clientes", table: "sale_customer_links" },
  { name: "despesas-categorias", table: "expense_categories" },
  { name: "despesas-recorrentes", table: "expense_recurring_rules" },
  { name: "despesas", table: "expenses" },
  { name: "metas", table: "goals" },
  { name: "metas-alteracoes", table: "goal_target_changes" },
  { name: "perfis-de-pagamento", table: "payment_profiles" },
  { name: "perfis-de-pagamento-regras", table: "payment_profile_rules" },
  { name: "catalogo-publico", table: "public_catalog_profiles" },
  { name: "catalogo-publico-produtos", table: "product_publications" },
  { name: "variantes-operacionais", table: "operational_variant_selections" },
]);

/** Tables of an organization that a data export does not hold, and why. */
export const EXPORT_EXCLUDED_TABLES: Readonly<Record<string, string>> =
  Object.freeze({
    billing_events:
      "cobrança: lida só pelo papel de billing, fora do escopo do export do tenant",
    billing_trial_claims:
      "cobrança: o teste grátis da pessoa, lido só pelo papel de billing (antiabuso)",
    data_export_files: "o próprio export",
    data_exports: "o próprio export",
    deletion_ledger:
      "tombstones de exclusão, só IDs opacos: o papel do tenant só grava, não lê",
    entitlement_grants: "cobrança: lida só pelo papel de billing",
    event_outbox:
      "eventos a despachar, só IDs opacos: o papel do tenant só grava, não lê",
    memberships: "conta: o pedido sobre os dados da conta é outro",
    offline_grants: "autorização offline: mecanismo interno",
    organization_billing: "cobrança: lida só pelo papel de billing",
    organization_closures: "processo interno de encerramento",
    organization_legal_holds: "travas legais da plataforma, sem dado do tenant",
    organization_purge_cancellations:
      "histórico interno do purge, da plataforma",
    organization_purges: "processo interno do purge, da plataforma",
    platform_audit_events: "da plataforma, não do tenant",
    queue_dead_letters:
      "eventos mortos do outbox, só IDs opacos: mecanismo interno de operação",
    queue_processing:
      "registro do consumidor de filas, só IDs opacos: mecanismo interno",
    rls_poc_operations: "tabela de prova técnica",
    support_cases: "da plataforma, não do tenant",
    sync_changes: "mecanismo interno de sincronização",
    sync_commands: "mecanismo interno de sincronização",
    sync_cursors: "mecanismo interno de sincronização",
    tenant_access_grants: "da plataforma, não do tenant",
    tenant_audit_event:
      "trilha de auditoria: o papel do tenant só grava nela, não lê",
  });

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** A name that came from the catalog or from this file: checked before it is put inside a statement. */
export function quoteIdentifier(name: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new Error("export_identifier_invalid");
  }
  return `"${name}"`;
}
