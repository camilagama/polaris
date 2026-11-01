import assert from "node:assert/strict";
import { Client } from "pg";
import {
  RLS_EXEMPT_SCHEMAS,
  RLS_EXEMPT_TABLES,
} from "../src/rls-exempt-tables";
import { catalogViolations, readCatalog } from "./rls-forced-catalog-checks";
import {
  disposableHostPattern,
  gateBranchPattern,
  journalMigrationCount,
  poolerPattern,
  redactedFailure,
  requiredEnvironment,
} from "./sales-gate-support";

/**
 * Row security across the whole catalog of the `public` schema on a real PostgreSQL 18: every ordinary (`r`),
 * partitioned (`p`) and foreign (`f`) table has row security enabled AND forced, unless `RLS_EXEMPT_TABLES` names it with a reason; a
 * view or materialized view (`v`, `m`) of `public` has `security_invoker`; and the database has no user schema besides
 * `public` other than the ones `RLS_EXEMPT_SCHEMAS` names; and no permissive policy of `public` has PUBLIC among its
 * roles (`TO PUBLIC` or no `TO` clause; a permissive policy for PUBLIC applies to every role with a privilege on the
 * table, and the gates of one subject see only their tables). A restrictive policy for PUBLIC only narrows access and passes.
 * The other gates each check the tables of their own subject:
 * this is the one that sees a table no gate names. A stale list also fails (a table that is gone or now forced).
 *
 * Scope: only the `public` schema is read for row security. Any other user schema fails the gate until the queries of
 * the restore runbook (docs/runbooks/deletion-ledger-restore.md, step 5) and this gate are extended to cover it
 * (`pg_*` and `information_schema` are the server's own and are left out).
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

// fewer tables than the migrations create means the database is not the migrated one, and an empty catalog would pass
const MIN_PUBLIC_TABLES = 70;

const PROBE_PREFIX = "zz_gate_probe_";

/**
 * The reading and the verdict, proved on this database before the real verdict: inside one transaction that is always
 * rolled back, it plants a table with no row security, a table that lost FORCE, a view and a materialized view with no
 * security_invoker (and a view that has it), a schema and a permissive policy TO PUBLIC, and the verdict must name each of them and nothing else.
 */
async function proveDetection(client: Client, existingTable: string) {
  const planted = `${PROBE_PREFIX}table`;
  await client.query("BEGIN");
  try {
    await client.query(`CREATE TABLE public.${planted} (id integer)`);
    await client.query(
      `ALTER TABLE public.${client.escapeIdentifier(existingTable)} NO FORCE ROW LEVEL SECURITY`
    );
    await client.query(
      `CREATE VIEW public.${PROBE_PREFIX}view AS SELECT 1 AS probe`
    );
    await client.query(
      `CREATE VIEW public.${PROBE_PREFIX}safe_view WITH (security_invoker = true) AS SELECT 1 AS probe`
    );
    await client.query(
      `CREATE MATERIALIZED VIEW public.${PROBE_PREFIX}matview AS SELECT 1 AS probe`
    );
    await client.query(`CREATE SCHEMA ${PROBE_PREFIX}schema`);
    await client.query(
      `CREATE POLICY ${PROBE_PREFIX}policy ON public.${client.escapeIdentifier(existingTable)} AS PERMISSIVE FOR SELECT TO PUBLIC USING (true)`
    );
    const found = catalogViolations(
      await readCatalog(client),
      RLS_EXEMPT_TABLES,
      RLS_EXEMPT_SCHEMAS
    );
    const expected = [
      `table public.${planted} `,
      `table public.${existingTable} `,
      `view public.${PROBE_PREFIX}view `,
      `materialized view public.${PROBE_PREFIX}matview `,
      `schema ${PROBE_PREFIX}schema `,
      `policy ${PROBE_PREFIX}policy on public.${existingTable} `,
    ];
    assert.equal(found.length, expected.length, found.join("\n"));
    for (const start of expected) {
      assert.ok(
        found.some((line) => line.startsWith(start)),
        `the verdict did not name ${start}`
      );
    }
    assert.ok(
      !found.some((line) => line.includes(`${PROBE_PREFIX}safe_view`)),
      "the view with security_invoker was reported"
    );
  } finally {
    await client.query("ROLLBACK");
  }
}

async function run() {
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, gateBranchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);

  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const server = await client.query<{
      database_name: string;
      server_version_num: string;
    }>(
      "SELECT current_database() AS database_name, current_setting('server_version_num') AS server_version_num"
    );
    const [serverRow] = server.rows;
    assert.ok(serverRow);
    assert.equal(serverRow.database_name, expectedDatabase);
    assert.ok(Number(serverRow.server_version_num) >= 180_000);
    const migrations = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations"
    );
    assert.equal(Number(migrations.rows[0]?.count), journalMigrationCount());

    const snapshot = await readCatalog(client);
    const tables = snapshot.relations.filter(
      (relation) =>
        relation.kind === "r" || relation.kind === "p" || relation.kind === "f"
    );
    assert.ok(
      tables.length >= MIN_PUBLIC_TABLES,
      `public has ${tables.length} tables, fewer than the ${MIN_PUBLIC_TABLES} the migrations create`
    );
    const violations = catalogViolations(
      snapshot,
      RLS_EXEMPT_TABLES,
      RLS_EXEMPT_SCHEMAS
    );
    assert.deepEqual(violations, [], violations.join("\n"));
    assert.ok(tables[0]);
    await proveDetection(client, tables[0].name);
    assert.deepEqual(await readCatalog(client), snapshot);
    console.log(
      JSON.stringify(
        {
          branch,
          database: serverRow.database_name,
          exemptSchemas: RLS_EXEMPT_SCHEMAS.map((entry) => entry.schema),
          exemptTables: RLS_EXEMPT_TABLES.map((entry) => entry.table),
          forcedTables: tables.length - RLS_EXEMPT_TABLES.length,
          status: "passed",
          views: snapshot.relations.length - tables.length,
        },
        null,
        2
      )
    );
  } finally {
    await client.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    `RLS forced catalog PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
