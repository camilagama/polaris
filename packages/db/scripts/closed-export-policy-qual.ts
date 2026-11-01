const SCOPE_CALL =
  "( SELECT closed_export_organization() AS closed_export_organization)";

export function closedExportPolicyQual(table: string): string {
  const column = table === "organizations" ? "id" : "organization_id";
  return `(${column} = ${SCOPE_CALL})`;
}

function normalized(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/**
 * The whole `pg_policies.qual` must be the one the migration writes, as PostgreSQL deparses it: any `OR`, `AND`,
 * other column or other function would widen what the reader sees, so nothing is matched by containment.
 */
export function isClosedExportPolicyQual(table: string, qual: string): boolean {
  return normalized(qual) === closedExportPolicyQual(table);
}
