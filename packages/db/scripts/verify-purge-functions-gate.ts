import assert from "node:assert/strict";
import { createDatabase } from "../src/client";
import {
  PURGE_FUNCTIONS,
  type PurgeFunctionName,
  purgeFunctionDifferences,
} from "../src/purge-function-definitions";
import {
  disposableHostPattern,
  gateBranchPattern,
  journalMigrationCount,
  poolerPattern,
  redactedFailure,
  requiredEnvironment,
} from "./sales-gate-support";

/**
 * The three purge functions, as the database holds them after every migration, agree with the domain (ADR 0081).
 * Two migrations that recreate the same function do not conflict in git: the later body silently wins, and a value
 * the earlier one fixed (the 90 days, the scope without the audit, the list of tables) can come back. This gate reads
 * `pg_get_functiondef` of `admin_schedule_organization_purge`, `organization_purge_blocker` and
 * `purge_organization_data` and compares: the `whole_organization` scope with `ORGANIZATION_PURGE_REQUIRED_SCOPE`, the
 * period with `ORGANIZATION_PURGE_CLOSURE_PERIOD_DAYS`, and the tables deleted (names and order) with
 * `PURGE_DELETE_ORDER`, besides the keys a billing fact keeps and the one DELETE. It is mandatory before any pull
 * request that recreates one of the three functions. The comparison is `purgeFunctionDifferences`, and its unit test
 * proves it fails on the regressions above.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

async function run() {
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, gateBranchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);

  const owner = createDatabase(adminUrl, { maxConnections: 1 });
  try {
    const server = await owner.pool.query<{
      database_name: string;
      server_version: string;
      server_version_num: string;
    }>(
      "SELECT current_database() AS database_name, current_setting('server_version') AS server_version, current_setting('server_version_num') AS server_version_num"
    );
    const [serverRow] = server.rows;
    assert.ok(serverRow);
    assert.equal(serverRow.database_name, expectedDatabase);
    assert.ok(Number(serverRow.server_version_num) >= 180_000);
    const migrations = await owner.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations"
    );
    assert.equal(Number(migrations.rows[0]?.count), journalMigrationCount());

    const definitions = new Map<PurgeFunctionName, string>();
    for (const name of PURGE_FUNCTIONS) {
      // biome-ignore lint/performance/noAwaitInLoops: three probes, one at a time, for a clear failure
      const found = await owner.pool.query<{ definition: string }>(
        `SELECT pg_catalog.pg_get_functiondef(p.oid) AS definition
           FROM pg_catalog.pg_proc AS p
          WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $1`,
        [name]
      );
      assert.equal(
        found.rows.length,
        1,
        `${name} exists exactly once (no overload that could be the one left behind)`
      );
      const definition = found.rows[0]?.definition;
      assert.ok(definition, `${name} has a definition`);
      definitions.set(name, definition);
    }
    const differences = purgeFunctionDifferences(
      Object.fromEntries(definitions) as Record<PurgeFunctionName, string>
    );
    assert.deepEqual(
      differences,
      [],
      `the purge functions differ from the domain:\n${differences.join("\n")}`
    );

    console.log(
      JSON.stringify(
        {
          branch,
          database: serverRow.database_name,
          serverVersion: serverRow.server_version,
          status: "passed",
          tests: [
            "disposable direct connection is PostgreSQL 18 with every migration replayed from scratch",
            "the whole_organization scope, the closure period, the tables deleted (names and order), the billing fact keys and the single DELETE of the three purge functions agree with the domain",
          ],
        },
        null,
        2
      )
    );
  } finally {
    await owner.pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    `Purge functions PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
