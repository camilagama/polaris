/**
 * The registry of the tenant's audit events (ADR 0081, amended 19/10/2026): every `event_type` written to
 * `tenant_audit_event` has a class, and the class decides how long the row is kept (`retention.ts`). `security`
 * is what answers who did something sensitive (an export, an anonymization, an offline grant, the life of the
 * organization, what the public catalog shows); `operational` is the rest of the day-to-day record.
 *
 * The database holds the same list as a CHECK on `event_type` and as the generated column `event_class`
 * (`tenantAuditEventCheckSql` and `tenantAuditEventClassSql` build both from this registry), so a type that is
 * not here fails at the INSERT instead of vanishing from a retention rule nobody sees. The audit gate proves the
 * CHECK of the database equals this registry.
 */

export const TENANT_AUDIT_EVENT_CLASSES = Object.freeze([
  "security",
  "operational",
] as const);

export type TenantAuditEventClass = (typeof TENANT_AUDIT_EVENT_CLASSES)[number];

/**
 * Every event type and its class. A type with the prefix `membership.` is `security` the day someone starts
 * auditing the members (`tenantAuditEventClassOf` and the unit test enforce it).
 */
export const TENANT_AUDIT_EVENT_TYPES = Object.freeze({
  "category.archived": "operational",
  "category.created": "operational",
  "category.deleted": "operational",
  "category.renamed": "operational",
  "category.restored": "operational",
  "customer.anonymized": "security",
  "customer.archived": "operational",
  "customer.created": "operational",
  "customer.restored": "operational",
  "customer.updated": "operational",
  "data_export.downloaded": "security",
  "data_export.failed": "security",
  "data_export.ready": "security",
  "data_export.requested": "security",
  "expense.created": "operational",
  "expense.restored": "operational",
  "expense.updated": "operational",
  "expense.voided": "operational",
  "expense_category.archived": "operational",
  "expense_category.created": "operational",
  "expense_category.renamed": "operational",
  "expense_category.restored": "operational",
  "expense_rule.archived": "operational",
  "expense_rule.created": "operational",
  "expense_rule.generated": "operational",
  "expense_rule.restored": "operational",
  "expense_rule.updated": "operational",
  "goal.cancelled": "operational",
  "goal.completed": "operational",
  "goal.created": "operational",
  "goal.missed": "operational",
  "goal.target_changed": "operational",
  "goal.updated": "operational",
  "inventory.movement_recorded": "operational",
  "offline_grant.issued": "security",
  "offline_grant.revoked": "security",
  "operational_selection.changed": "operational",
  "organization.closure_recovered": "security",
  "organization.closure_requested": "security",
  "organization.created": "security",
  "payment_profile.archived": "operational",
  "payment_profile.created": "operational",
  "payment_profile.restored": "operational",
  "payment_profile.updated": "operational",
  "product.archived": "operational",
  "product.created": "operational",
  "product.deleted": "operational",
  "product.media_removed": "operational",
  "product.media_reordered": "operational",
  "product.media_uploaded": "operational",
  "product.published_to_catalog": "security",
  "product.restored": "operational",
  "product.unpublished_from_catalog": "security",
  "product.updated": "operational",
  "product.variants_configured": "operational",
  "product_variant.list_price_changed": "operational",
  "product_variant.sku_changed": "operational",
  "public_catalog.profile_created": "security",
  "public_catalog.profile_updated": "security",
  "public_catalog.published": "security",
  "public_catalog.unpublished": "security",
  "sale.cancelled": "operational",
  "sale.confirmed": "operational",
  "sale.returned": "operational",
  "sale_customer_link.assigned": "operational",
  "sale_customer_link.reassigned": "operational",
  "sale_customer_link.unassigned": "operational",
} as const satisfies Record<string, TenantAuditEventClass>);

export type TenantAuditEventType = keyof typeof TENANT_AUDIT_EVENT_TYPES;

const SECURITY_PREFIXES = Object.freeze(["membership."] as const);

export function isTenantAuditEventType(
  value: string
): value is TenantAuditEventType {
  return Object.hasOwn(TENANT_AUDIT_EVENT_TYPES, value);
}

/** The class of an event type, or `undefined` for one the registry does not know (the database refuses it). */
export function tenantAuditEventClassOf(
  eventType: string
): TenantAuditEventClass | undefined {
  return isTenantAuditEventType(eventType)
    ? TENANT_AUDIT_EVENT_TYPES[eventType]
    : undefined;
}

/** The registered types of a class, in the registry's order. */
export function tenantAuditEventTypesOf(
  eventClass: TenantAuditEventClass
): TenantAuditEventType[] {
  return (
    Object.keys(TENANT_AUDIT_EVENT_TYPES) as TenantAuditEventType[]
  ).filter((eventType) => TENANT_AUDIT_EVENT_TYPES[eventType] === eventClass);
}

/** Whether a type belongs to a family that must be `security` as soon as it is registered. */
export function isSecurityPrefix(eventType: string): boolean {
  return SECURITY_PREFIXES.some((prefix) => eventType.startsWith(prefix));
}

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** The list of a class as SQL literals (`'a', 'b'`): the registry is the only source of the CHECK. */
function sqlList(eventClass: TenantAuditEventClass): string {
  return tenantAuditEventTypesOf(eventClass).map(quote).join(", ");
}

/** The CHECK of `tenant_audit_event.event_type`: only a registered type is accepted. */
export function tenantAuditEventCheckSql(column = "event_type"): string {
  return `${column} IN (${sqlList("security")}, ${sqlList("operational")})`;
}

/** The generated column `event_class`: the registry's class of the type (the CHECK refuses the rest). */
export function tenantAuditEventClassSql(column = "event_type"): string {
  return `CASE WHEN ${column} IN (${sqlList("security")}) THEN 'security' ELSE 'operational' END`;
}
