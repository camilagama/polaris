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

export const CLOSED_EXPORT_POLICIES_SQL =
  "SELECT tablename, qual, cmd FROM pg_policies WHERE $1 = ANY (roles) ORDER BY tablename";

export const POLICY_READ_SEARCH_PATH_SQL =
  "SET LOCAL search_path = pg_catalog, public";

export interface ClosedExportPolicyRow {
  cmd: string;
  qual: string;
  tablename: string;
}

interface PolicyReadClient {
  query: <T>(text: string, values?: unknown[]) => Promise<{ rows: T[] }>;
  release: (error?: Error) => void;
}

export interface PolicyReadPool {
  connect: () => Promise<PolicyReadClient>;
}

/**
 * `pg_policies.qual` is deparsed against the session's search_path: without `public` on it the function comes back as
 * `public.closed_export_organization()`. The read pins the path inside a read-only transaction so the exact comparison
 * always sees the same text. A connection whose ROLLBACK failed goes back to the pool as broken.
 */
export async function readClosedExportPolicies(
  pool: PolicyReadPool,
  role: string
): Promise<ClosedExportPolicyRow[]> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(POLICY_READ_SEARCH_PATH_SQL);
    const { rows } = await client.query<ClosedExportPolicyRow>(
      CLOSED_EXPORT_POLICIES_SQL,
      [role]
    );
    return rows;
  } finally {
    try {
      await client.query("ROLLBACK");
    } catch (error) {
      broken = error instanceof Error ? error : new Error(String(error));
    }
    client.release(broken);
  }
}
