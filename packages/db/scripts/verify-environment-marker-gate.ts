// biome-ignore-all lint/performance/noAwaitInLoops: a gate runs its probes strictly one at a time, for a clear failure
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import {
  declaredEnvironment,
  ENVIRONMENT_MARKER_SQL,
  type EnvironmentReadings,
  markerComment,
} from "./environment-marker";
import { assertDisposableEnvironment } from "./gate-target";
import {
  disposableHostPattern,
  expectSqlState,
  gateBranchPattern,
  poolerPattern,
  redactedFailure,
  requiredEnvironment,
  temporaryRuntimeUrl,
} from "./sales-gate-support";

/**
 * The environment marker as a database comment (ADR 0097), on a real PostgreSQL 18 and without a superuser for
 * the owner: Neon gives none, and there `ALTER DATABASE … SET polaris.environment` fails with 42501. The gate
 * makes a throwaway database owned by a login that is neither superuser nor CREATEROLE and proves that:
 *   1. the old form is refused to that owner (42501), which is the premise;
 *   2. the owner writes the marker with `COMMENT ON DATABASE` and the helper reads it, from the owner's session
 *      and from a session of another login;
 *   3. a login that does not own the database cannot write or clear the comment (42501);
 *   4. every other text (`staging-x`, a space, a capital, no comment) is not the `staging` marker;
 *   5. `assertDisposableEnvironment` refuses a database whose comment says staging, production or restore-drill,
 *      and accepts one with no marker (the control).
 * Everything it creates is dropped. It never touches the database of the run, only the throwaway one.
 */
const protectedRefusal = /protected environment/;
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

function inDatabase(url: string, database: string) {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function readings(client: Client): Promise<EnvironmentReadings> {
  const { rows } = await client.query<EnvironmentReadings>(
    ENVIRONMENT_MARKER_SQL
  );
  assert.ok(rows[0]);
  return rows[0];
}

async function run() {
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, gateBranchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);

  const suffix = randomBytes(5).toString("hex");
  const database = `polaris_marker_${suffix}`;
  const owner = `polaris_marker_owner_${suffix}`;
  const other = `polaris_marker_other_${suffix}`;
  const ownerPassword = randomBytes(18).toString("hex");
  const otherPassword = randomBytes(18).toString("hex");
  const tests: string[] = [];
  const cleanupFailures: string[] = [];
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  const clients: Client[] = [];
  let databaseCreated = false;
  let ownerCreated = false;
  let otherCreated = false;
  let primaryFailure = false;

  try {
    const superuser = await admin.query<{ rolsuper: boolean }>(
      "SELECT rolsuper FROM pg_roles WHERE rolname = current_user"
    );
    assert.equal(
      superuser.rows[0]?.rolsuper,
      true,
      "the gate runner must be able to create the throwaway database and logins"
    );
    await admin.query(
      `CREATE ROLE "${owner}" WITH LOGIN PASSWORD '${ownerPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
    );
    ownerCreated = true;
    await admin.query(
      `CREATE ROLE "${other}" WITH LOGIN PASSWORD '${otherPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
    );
    otherCreated = true;
    await admin.query(`CREATE DATABASE "${database}" OWNER "${owner}"`);
    databaseCreated = true;
    await admin.query(`GRANT CONNECT ON DATABASE "${database}" TO "${other}"`);

    const connect = async (role: string, password: string) => {
      const client = new Client({
        connectionString: temporaryRuntimeUrl(
          inDatabase(adminUrl, database),
          role,
          password
        ),
      });
      await client.connect();
      clients.push(client);
      return client;
    };
    const ownerSession = await connect(owner, ownerPassword);
    const otherSession = await connect(other, otherPassword);
    const owns = await ownerSession.query<{ owned: boolean; super: boolean }>(
      `SELECT d.datdba = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owned,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS super
         FROM pg_database d WHERE d.datname = current_database()`
    );
    assert.deepEqual(owns.rows[0], { owned: true, super: false });
    tests.push("the throwaway owner owns the database and is not a superuser");

    // 1. the premise: the old form is not available without a superuser
    await expectSqlState(
      () =>
        ownerSession.query(
          `ALTER DATABASE "${database}" SET polaris.environment = 'staging'`
        ),
      "42501",
      "the old form needs a superuser"
    );
    tests.push(
      "ALTER DATABASE … SET polaris.environment fails for that owner (42501)"
    );

    // control: nothing written yet is no marker
    assert.equal(declaredEnvironment(await readings(ownerSession)), null);
    tests.push("a database with no comment has no marker");

    // 2. the owner writes the marker without being a superuser
    await ownerSession.query(
      `COMMENT ON DATABASE "${database}" IS '${markerComment("staging")}'`
    );
    assert.equal(declaredEnvironment(await readings(ownerSession)), "staging");
    assert.equal(declaredEnvironment(await readings(otherSession)), "staging");
    tests.push(
      "COMMENT ON DATABASE by the non-superuser owner is read as staging, by the owner and by another login"
    );

    // the session cannot fake or hide it
    for (const [options, expected] of [
      ["-c polaris.environment=production", null],
      ["-c polaris.environment=staging", "staging"],
    ] as const) {
      const tagged = new Client({
        connectionString: temporaryRuntimeUrl(
          inDatabase(adminUrl, database),
          other,
          otherPassword
        ),
        options,
      });
      await tagged.connect();
      clients.push(tagged);
      assert.equal(declaredEnvironment(await readings(tagged)), expected);
    }
    tests.push(
      "a session option that contradicts the comment makes it no marker; one that agrees changes nothing"
    );

    // 3. only the owner changes the comment
    await expectSqlState(
      () =>
        otherSession.query(
          `COMMENT ON DATABASE "${database}" IS '${markerComment("production")}'`
        ),
      "42501",
      "another login rewrites the comment"
    );
    await expectSqlState(
      () => otherSession.query(`COMMENT ON DATABASE "${database}" IS NULL`),
      "42501",
      "another login clears the comment"
    );
    assert.equal(declaredEnvironment(await readings(ownerSession)), "staging");
    tests.push(
      "a login that is not the owner cannot rewrite or clear the comment (42501)"
    );

    // 4. other texts are not the marker (control: the exact one above is)
    for (const text of [
      "polaris.environment=staging ",
      " polaris.environment=staging",
      "polaris.environment=Staging",
      "polaris.environment = staging",
      "polaris.environment=staging\nnotes",
      "staging",
    ]) {
      await ownerSession.query(
        `COMMENT ON DATABASE "${database}" IS '${text}'`
      );
      assert.equal(
        declaredEnvironment(await readings(ownerSession)),
        null,
        `'${text}' must not be a marker`
      );
    }
    await ownerSession.query(
      `COMMENT ON DATABASE "${database}" IS 'polaris.environment=staging-x'`
    );
    assert.equal(
      declaredEnvironment(await readings(ownerSession)),
      "staging-x"
    );
    tests.push(
      "spaces, a capital, a second line and a bare name are no marker; staging-x declares another environment"
    );

    // the old form (a superuser's ALTER DATABASE) is still read, and may not contradict the comment
    await ownerSession.query(
      `COMMENT ON DATABASE "${database}" IS '${markerComment("staging")}'`
    );
    await admin.query(
      `ALTER DATABASE "${database}" SET polaris.environment = 'staging'`
    );
    assert.equal(declaredEnvironment(await readings(ownerSession)), "staging");
    await ownerSession.query(`COMMENT ON DATABASE "${database}" IS NULL`);
    assert.equal(declaredEnvironment(await readings(otherSession)), "staging");
    await admin.query(
      `ALTER DATABASE "${database}" SET polaris.environment = 'production'`
    );
    await ownerSession.query(
      `COMMENT ON DATABASE "${database}" IS '${markerComment("staging")}'`
    );
    assert.equal(declaredEnvironment(await readings(ownerSession)), null);
    await admin.query(`ALTER DATABASE "${database}" RESET polaris.environment`);
    tests.push(
      "the old stored form is read as the marker, alone or with the same comment, and a stored value that contradicts the comment is no marker"
    );

    // 5. the gate runner refuses a protected database and accepts one with no marker
    for (const environment of ["staging", "production", "restore-drill"]) {
      await ownerSession.query(
        `COMMENT ON DATABASE "${database}" IS '${markerComment(environment)}'`
      );
      await assert.rejects(
        assertDisposableEnvironment(ownerSession),
        protectedRefusal
      );
    }
    // a protected environment written loosely still refuses
    for (const text of [
      "polaris.environment = production",
      "polaris.environment: staging",
      "polaris.environment=restore-drill extra",
      "notes polaris.environment=production",
    ]) {
      await ownerSession.query(
        `COMMENT ON DATABASE "${database}" IS '${text}'`
      );
      await assert.rejects(
        assertDisposableEnvironment(ownerSession),
        protectedRefusal
      );
    }
    for (const text of ["NULL", "'polaris.environment=staging-x'"]) {
      await ownerSession.query(`COMMENT ON DATABASE "${database}" IS ${text}`);
      await assertDisposableEnvironment(ownerSession);
    }
    tests.push(
      "assertDisposableEnvironment refuses a comment of staging, production or restore-drill (also written loosely), and accepts none or another exact name"
    );
  } catch (error) {
    primaryFailure = true;
    throw error;
  } finally {
    const cleanup = async (label: string, sql: string) => {
      try {
        await admin.query(sql);
      } catch (error) {
        cleanupFailures.push(
          `${label}: ${redactedFailure(error).split("\n")[0]}`
        );
      }
    };
    await Promise.all(
      clients.map((client) => client.end().catch(() => undefined))
    );
    if (databaseCreated) {
      await cleanup(
        "database",
        `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`
      );
    }
    if (otherCreated) {
      await cleanup("other login", `DROP ROLE IF EXISTS "${other}"`);
    }
    if (ownerCreated) {
      await cleanup("owner login", `DROP ROLE IF EXISTS "${owner}"`);
    }
    await admin.end();
    if (cleanupFailures.length > 0) {
      console.error(
        `Environment marker gate cleanup failed: ${cleanupFailures.join("; ")}`
      );
      if (!primaryFailure) {
        process.exitCode = 1;
      }
    }
  }

  console.log(
    JSON.stringify({ branch, database: expectedDatabase, tests }, null, 2)
  );
}

run().catch((error: unknown) => {
  console.error(
    `Environment marker PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
