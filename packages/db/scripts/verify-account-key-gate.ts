import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PoolClient } from "pg";
import { createDatabase } from "../src/client";
import {
  disposableHostPattern,
  expectSqlState,
  gateBranchPattern,
  journalMigrationCount,
  poolerPattern,
  redactedFailure,
  requiredEnvironment,
  sqlState,
} from "./sales-gate-support";

/**
 * One account per key, `(provider_id, account_id)` (0106, t435). Better Auth 1.7 finds an account by that key and
 * refuses a key held by two rows, so the table must never hold one. This gate proves, on the database after every
 * migration: the index is there, unique, valid and on exactly those two columns, in that order; a second row with the
 * key of another is refused (23505) whatever its user, while the same account ID under another provider is accepted;
 * replayed over a table that already holds a duplicate, the migration fails with its named error and changes nothing,
 * and over a table without one it builds the index (the check before the index is the proof the duplicate never gets
 * there unseen); and a sign-in that holds the table makes the migration give up within its lock_timeout instead of
 * queueing behind it. Every fixture is written in a transaction that is rolled back.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";
const INDEX = "account_provider_id_account_id_key";
const LOCK_NOT_AVAILABLE = "55P03";
const UNIQUE_VIOLATION = "23505";

const migrationStatements = readFileSync(
  new URL("../drizzle/0106_chave_unica_da_conta.sql", import.meta.url),
  "utf8"
)
  .split("--> statement-breakpoint")
  .map((statement) =>
    statement
      .split("\n")
      .filter((line) => !line.startsWith("--"))
      .join("\n")
      .trim()
  )
  .filter((statement) => statement.length > 0);

async function insertUser(client: PoolClient, label: string): Promise<string> {
  const id = `t435-${label}-${randomUUID()}`;
  await client.query(
    `INSERT INTO public."user" (id, name, email, email_verified) VALUES ($1, 'Gate', $2, true)`,
    [id, `${id}@example.invalid`]
  );
  return id;
}

function insertAccount(
  client: PoolClient,
  userId: string,
  providerId: string,
  accountId: string
) {
  return client.query(
    "INSERT INTO public.account (id, user_id, provider_id, account_id) VALUES ($1, $2, $3, $4)",
    [randomUUID(), userId, providerId, accountId]
  );
}

async function replayMigration(client: PoolClient): Promise<void> {
  for (const statement of migrationStatements) {
    // biome-ignore lint/performance/noAwaitInLoops: the statements of one migration, in their order
    await client.query(statement);
  }
}

/** Runs `body` in a transaction that is always rolled back. */
async function inRolledBackTransaction(
  owner: ReturnType<typeof createDatabase>,
  body: (client: PoolClient) => Promise<void>
): Promise<void> {
  const client = await owner.pool.connect();
  try {
    await client.query("BEGIN");
    await body(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function indexDefinition(client: Pick<PoolClient, "query">) {
  const found = await client.query<{
    columns: string[];
    is_partial: boolean;
    is_unique: boolean;
    is_valid: boolean;
  }>(
    `SELECT i.indisunique AS is_unique, i.indisvalid AS is_valid, i.indpred IS NOT NULL AS is_partial,
            ARRAY(SELECT a.attname::text
                    FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, position)
                    JOIN pg_catalog.pg_attribute AS a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
                   ORDER BY k.position) AS columns
       FROM pg_catalog.pg_index AS i
      WHERE i.indexrelid = to_regclass('public.${INDEX}')`
  );
  return found.rows;
}

async function run() {
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, gateBranchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);

  const owner = createDatabase(adminUrl, { maxConnections: 2 });
  const tests: string[] = [];
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
    tests.push(
      "disposable direct connection is PostgreSQL 18 with every migration replayed from scratch"
    );

    assert.deepEqual(await indexDefinition(owner.pool), [
      {
        columns: ["provider_id", "account_id"],
        is_partial: false,
        is_unique: true,
        is_valid: true,
      },
    ]);
    tests.push(
      "the index is unique, valid, not partial and on (provider_id, account_id), in that order"
    );

    await inRolledBackTransaction(owner, async (client) => {
      const first = await insertUser(client, "first");
      const second = await insertUser(client, "second");
      await insertAccount(client, first, "google", "subject-1");
      await insertAccount(client, first, "credential", first);
      // the same subject under another provider is another key
      await insertAccount(client, second, "other-provider", "subject-1");
      await client.query("SAVEPOINT duplicate");
      await expectSqlState(
        () => insertAccount(client, second, "google", "subject-1"),
        UNIQUE_VIOLATION,
        "a second row with the key of another, for another user, is refused",
        INDEX
      );
      await client.query("ROLLBACK TO SAVEPOINT duplicate");
      await expectSqlState(
        () => insertAccount(client, first, "google", "subject-1"),
        UNIQUE_VIOLATION,
        "a second row with the key of another, for the same user, is refused",
        INDEX
      );
    });
    tests.push(
      "a second account with the key of another is refused (23505, this index) for another user and for the same one; the same account ID under another provider is accepted"
    );

    assert.ok(
      migrationStatements[0]?.startsWith("SET LOCAL lock_timeout = '10s'"),
      "the migration sets its lock_timeout first"
    );
    await inRolledBackTransaction(owner, async (client) => {
      await client.query(`DROP INDEX public.${INDEX}`);
      const first = await insertUser(client, "replay-first");
      const second = await insertUser(client, "replay-second");
      await insertAccount(client, first, "google", "subject-duplicate");
      await insertAccount(client, second, "google", "subject-duplicate");
      await client.query("SAVEPOINT replay");
      await assert.rejects(
        () => replayMigration(client),
        (error: unknown) => {
          assert.equal(sqlState(error), UNIQUE_VIOLATION);
          assert.equal((error as Error).message, "account_key_duplicates");
          return true;
        },
        "the migration over a duplicate fails with its named error"
      );
      await client.query("ROLLBACK TO SAVEPOINT replay");
      assert.deepEqual(
        await indexDefinition(client),
        [],
        "and leaves no index behind"
      );
      const rows = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM public.account WHERE account_id = 'subject-duplicate'"
      );
      assert.equal(rows.rows[0]?.count, "2", "nor touches the rows");

      await client.query(
        "DELETE FROM public.account WHERE user_id = $1 AND account_id = 'subject-duplicate'",
        [second]
      );
      await replayMigration(client);
      assert.equal((await indexDefinition(client)).length, 1);
    });
    tests.push(
      "replayed over a table with a duplicate key, the migration fails with account_key_duplicates (23505), builds no index and touches no row; without the duplicate it builds the index"
    );

    const holder = await owner.pool.connect();
    try {
      await holder.query("BEGIN");
      // a sign-up in flight: its ROW EXCLUSIVE lock on account conflicts with the SHARE lock of the migration
      await holder.query("LOCK TABLE public.account IN ROW EXCLUSIVE MODE");
      const started = Date.now();
      // the index stays: the migration gives up at its LOCK TABLE, before it would reach the CREATE INDEX
      await inRolledBackTransaction(owner, async (client) => {
        await expectSqlState(
          () => replayMigration(client),
          LOCK_NOT_AVAILABLE,
          "the migration gives up when a write holds account"
        );
      });
      const waited = Date.now() - started;
      assert.ok(
        waited >= 9000 && waited < 30_000,
        `it gives up after its lock_timeout of 10 s (waited ${waited} ms)`
      );
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    tests.push(
      "with a write holding account, the migration gives up with 55P03 after its lock_timeout of 10 s instead of queueing sign-ins behind it"
    );

    assert.equal((await indexDefinition(owner.pool)).length, 1);
    console.log(
      JSON.stringify(
        {
          branch,
          database: serverRow.database_name,
          serverVersion: serverRow.server_version,
          status: "passed",
          tests,
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
    `Account key PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
