import type { Client } from "pg";
import type { RlsExemptSchema, RlsExemptTable } from "../src/rls-exempt-tables";

/**
 * The catalog reading and the verdict of the `rls-forced-catalog` gate. Only the `public` schema is read for row
 * security; any user schema besides `public` is reported unless it is on the list of exempt schemas. Pure verdict (no
 * connection), so the tests can plant each defect.
 */
export type RelationKind = "r" | "p" | "f" | "v" | "m";

export interface CatalogRelation {
  forced: boolean;
  kind: RelationKind;
  name: string;
  rowSecurity: boolean;
  securityInvoker: boolean;
}

export interface CatalogPolicy {
  name: string;
  roles: string[];
  table: string;
}

export interface CatalogSnapshot {
  policies: CatalogPolicy[];
  relations: CatalogRelation[];
  schemas: string[];
}

// a foreign table has no row security at all, so it is held to the same rule as a table: exempt with a reason or absent
const TABLE_KINDS: readonly RelationKind[] = ["r", "p", "f"];
const SECURITY_INVOKER_ON = "'^security_invoker=(true|on|1|yes)$'";

export const RELATIONS_SQL = `SELECT c.relname AS name,
       c.relkind::text AS kind,
       c.relrowsecurity AS row_security,
       c.relforcerowsecurity AS forced,
       EXISTS (SELECT 1 FROM unnest(coalesce(c.reloptions, '{}'::text[])) AS option
                WHERE option ~* ${SECURITY_INVOKER_ON}) AS security_invoker
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'f', 'v', 'm')
 ORDER BY c.relname`;

export const SCHEMAS_SQL = `SELECT nspname AS name
  FROM pg_catalog.pg_namespace
 WHERE nspname <> 'public' AND nspname <> 'information_schema' AND nspname !~ '^pg_'
 ORDER BY nspname`;

// every policy of public with its roles, so the verdict (not the query) decides what `{public}` means; the cast makes
// the driver return a text array (it does not parse the `name[]` of pg_policies.roles)
export const POLICIES_SQL = `SELECT tablename AS table_name,
       policyname AS policy_name,
       roles::text[] AS roles
  FROM pg_catalog.pg_policies
 WHERE schemaname = 'public'
 ORDER BY tablename, policyname`;

export async function readCatalog(client: Client): Promise<CatalogSnapshot> {
  const relations = await client.query<{
    forced: boolean;
    kind: RelationKind;
    name: string;
    row_security: boolean;
    security_invoker: boolean;
  }>(RELATIONS_SQL);
  const schemas = await client.query<{ name: string }>(SCHEMAS_SQL);
  const policies = await client.query<{
    policy_name: string;
    roles: string[];
    table_name: string;
  }>(POLICIES_SQL);
  return {
    policies: policies.rows.map((row) => ({
      name: row.policy_name,
      roles: row.roles,
      table: row.table_name,
    })),
    relations: relations.rows.map((row) => ({
      forced: row.forced,
      kind: row.kind,
      name: row.name,
      rowSecurity: row.row_security,
      securityInvoker: row.security_invoker,
    })),
    schemas: schemas.rows.map((row) => row.name),
  };
}

const isTable = (relation: CatalogRelation) =>
  TABLE_KINDS.includes(relation.kind);
const isProtected = (relation: CatalogRelation) =>
  relation.rowSecurity && relation.forced;

function duplicates(names: string[]): string[] {
  return names.filter((name, index) => names.indexOf(name) !== index);
}

function exemptEntryViolations(
  exemptTables: readonly RlsExemptTable[],
  exemptSchemas: readonly RlsExemptSchema[]
): string[] {
  const found: string[] = [];
  for (const name of duplicates(exemptTables.map((entry) => entry.table))) {
    found.push(`the exempt list names table ${name} more than once`);
  }
  for (const name of duplicates(exemptSchemas.map((entry) => entry.schema))) {
    found.push(`the exempt list names schema ${name} more than once`);
  }
  for (const entry of exemptTables) {
    if (entry.reason.trim() === "") {
      found.push(`exempt table ${entry.table} has no reason`);
    }
  }
  for (const entry of exemptSchemas) {
    if (entry.reason.trim() === "") {
      found.push(`exempt schema ${entry.schema} has no reason`);
    }
  }
  return found;
}

function tableViolations(
  tables: CatalogRelation[],
  exemptTables: readonly RlsExemptTable[]
): string[] {
  const found: string[] = [];
  const exempt = new Set(exemptTables.map((entry) => entry.table));
  for (const table of tables) {
    if (!(isProtected(table) || exempt.has(table.name))) {
      found.push(
        `${table.kind === "f" ? "foreign table" : "table"} public.${table.name} does not have row security enabled and forced (enabled: ${table.rowSecurity}, forced: ${table.forced}): force it in the migration (ENABLE and FORCE ROW LEVEL SECURITY, with its policies), or add it to RLS_EXEMPT_TABLES in packages/db/src/rls-exempt-tables.ts with the reason and a security review`
      );
    }
  }
  const byName = new Map(tables.map((table) => [table.name, table]));
  for (const name of exempt) {
    const table = byName.get(name);
    if (!table) {
      found.push(
        `RLS_EXEMPT_TABLES lists ${name}, which is not a table of public any more: remove the entry`
      );
    } else if (isProtected(table)) {
      found.push(
        `RLS_EXEMPT_TABLES lists ${name}, which already has row security enabled and forced: remove the entry`
      );
    }
  }
  return found;
}

function viewViolation(view: CatalogRelation): string {
  const extend =
    "extend the row security queries of the restore runbook (docs/runbooks/deletion-ledger-restore.md, step 5) and this gate to cover views";
  if (view.kind === "m") {
    return `materialized view public.${view.name} skips row security (a materialized view cannot have security_invoker and stores its rows once, for every reader): do not create one in public; if one is needed, ${extend}`;
  }
  return `view public.${view.name} has no security_invoker: it reads its tables as its owner and skips row security; create it WITH (security_invoker = true), and ${extend}`;
}

function viewViolations(views: CatalogRelation[]): string[] {
  return views.filter((view) => !view.securityInvoker).map(viewViolation);
}

function schemaViolations(
  schemas: string[],
  exemptSchemas: readonly RlsExemptSchema[]
): string[] {
  const found: string[] = [];
  const exempt = new Set(exemptSchemas.map((entry) => entry.schema));
  for (const schema of schemas) {
    if (!exempt.has(schema)) {
      found.push(
        `schema ${schema} is a user schema besides public, and this gate reads only public: extend the row security queries of the restore runbook (docs/runbooks/deletion-ledger-restore.md, step 5) and this gate to cover it, then add it to RLS_EXEMPT_SCHEMAS in packages/db/src/rls-exempt-tables.ts with the reason`
      );
    }
  }
  for (const schema of exempt) {
    if (!schemas.includes(schema)) {
      found.push(
        `RLS_EXEMPT_SCHEMAS lists ${schema}, which does not exist: remove the entry`
      );
    }
  }
  return found;
}

// a policy with no TO clause is stored as {public} too; a permissive one for PUBLIC applies to every role with a privilege on the table
function publicPolicyViolations(policies: CatalogPolicy[]): string[] {
  return policies
    .filter((policy) => policy.roles.includes("public"))
    .map(
      (policy) =>
        `policy ${policy.name} on public.${policy.table} is TO PUBLIC (roles: {${policy.roles.join(",")}}): name the roles it is for in the migration (TO <role>); a policy for PUBLIC applies to every role that has a privilege on the table`
    );
}

export function catalogViolations(
  snapshot: CatalogSnapshot,
  exemptTables: readonly RlsExemptTable[],
  exemptSchemas: readonly RlsExemptSchema[]
): string[] {
  return [
    ...exemptEntryViolations(exemptTables, exemptSchemas),
    ...tableViolations(snapshot.relations.filter(isTable), exemptTables),
    ...viewViolations(
      snapshot.relations.filter((relation) => !isTable(relation))
    ),
    ...schemaViolations(snapshot.schemas, exemptSchemas),
    ...publicPolicyViolations(snapshot.policies),
  ];
}
