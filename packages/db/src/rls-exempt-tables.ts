export interface RlsExemptTable {
  reason: string;
  table: string;
}

export interface RlsExemptSchema {
  reason: string;
  schema: string;
}

/**
 * Tables of the `public` schema that are allowed to lack `ENABLE` + `FORCE ROW LEVEL SECURITY`. Empty today: every
 * table of `public` forces row security. The gate `rls-forced-catalog` fails on a table missing from this list and on an
 * entry that no longer matches (the table is gone, or now forces row security). An entry needs a security review and a
 * `reason` that points at the migration or the ADR that explains it.
 */
export const RLS_EXEMPT_TABLES: readonly RlsExemptTable[] = [];

/**
 * User schemas other than `public` that exist in a migrated database. The gate reads only `public` for row security, so
 * any other schema must be named here with the reason it is outside that reading; a new one fails the gate until the
 * restore runbook queries and the gate are extended to cover it.
 */
export const RLS_EXEMPT_SCHEMAS: readonly RlsExemptSchema[] = [
  {
    reason:
      "drizzle-kit's migration journal (drizzle.__drizzle_migrations: hash and timestamp per migration); no store data, and no runtime role has USAGE on the schema",
    schema: "drizzle",
  },
];
