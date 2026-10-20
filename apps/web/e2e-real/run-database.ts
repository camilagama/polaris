import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createDatabase } from "@polaris/db/client";
import {
  HYPERDRIVE_BINDINGS,
  HYPERDRIVE_ROLES,
  type RunEnvironment,
  runDatabaseName,
  runLoginName,
  runLoginPattern,
} from "./run-environment";

/**
 * The database of one run (ADR 0025, "a new database per gate"): created and migrated from zero by the global
 * setup, dropped by the global teardown with the seven logins. Nothing deletes an organization: every journey and
 * every attempt has its own, so the append-only tables and the immutable audit never conflict.
 */

const dbPackage = fileURLToPath(
  new URL("../../../packages/db", import.meta.url)
);
const databasePattern = /^e2e_[a-f0-9]{12}$/;
// lives outside the migrations (the CI job of the gates creates it); the run creates it only when it is missing
const RUNTIME_ROLE = "polaris_pr11_runtime";

type Pool = ReturnType<typeof createDatabase>["pool"];

export function databaseUrl(owner: URL, database: string): string {
  const url = new URL(owner.toString());
  url.pathname = `/${database}`;
  return url.toString();
}

async function withOwner<T>(
  owner: URL,
  database: string,
  work: (pool: Pool) => Promise<T>
): Promise<T> {
  const { pool } = createDatabase(databaseUrl(owner, database), {
    maxConnections: 1,
  });
  try {
    return await work(pool);
  } finally {
    await pool.end();
  }
}

function quoted(identifier: string, pattern: RegExp): string {
  if (!pattern.test(identifier)) {
    throw new Error(`Refused identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

/** The login must create databases and roles; said in words, not as a driver error. */
export async function assertOwnerCanCreate(owner: URL): Promise<void> {
  const row = await withOwner(owner, "postgres", async (pool) => {
    const result = await pool.query<{
      createdb: boolean;
      createrole: boolean;
      superuser: boolean;
    }>(
      "SELECT rolcreatedb AS createdb, rolcreaterole AS createrole, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user"
    );
    return result.rows[0];
  });
  if (!(row?.superuser || row?.createdb)) {
    throw new Error(
      "The login of POLARIS_E2E_DATABASE_URL has no CREATEDB: the e2e run creates its own database (e2e_<run>). Use the owner of the local PostgreSQL (in CI, the service user)."
    );
  }
  if (!(row.superuser || row.createrole)) {
    throw new Error(
      "The login of POLARIS_E2E_DATABASE_URL has no CREATEROLE: the e2e run creates one login per Hyperdrive binding."
    );
  }
}

function migrate(url: string): void {
  const result = spawnSync("bun", ["run", "db:migrate"], {
    cwd: dbPackage,
    encoding: "utf8",
    env: { HOME: process.env.HOME, PATH: process.env.PATH, DATABASE_URL: url },
  });
  if (result.status !== 0) {
    const tail = `${result.stdout}\n${result.stderr}`
      .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted]")
      .slice(-2000);
    throw new Error(`The migrations of the run database failed: ${tail}`);
  }
}

/** Returns whether this run created the runtime role (then the teardown drops it). */
export async function createRunDatabase(
  owner: URL,
  run: RunEnvironment
): Promise<{ createdRuntimeRole: boolean }> {
  const database = runDatabaseName(run.runId);
  await assertOwnerCanCreate(owner);
  const createdRuntimeRole = await withOwner(
    owner,
    "postgres",
    async (pool) => {
      await pool.query(`CREATE DATABASE ${quoted(database, databasePattern)}`);
      const existing = await pool.query(
        "SELECT 1 FROM pg_roles WHERE rolname = $1",
        [RUNTIME_ROLE]
      );
      if (existing.rows.length > 0) {
        return false;
      }
      await pool.query(
        `CREATE ROLE ${RUNTIME_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS`
      );
      return true;
    }
  );
  migrate(databaseUrl(owner, database));
  await withOwner(owner, database, async (pool) => {
    for (const binding of HYPERDRIVE_BINDINGS) {
      const login = quoted(runLoginName(run.runId, binding), runLoginPattern);
      // biome-ignore lint/performance/noAwaitInLoops: one role at a time on one connection
      await pool.query(
        `CREATE ROLE ${login} WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${run.passwords[binding]}'`
      );
      await pool.query(`GRANT ${HYPERDRIVE_ROLES[binding]} TO ${login}`);
    }
  });
  return { createdRuntimeRole };
}

/**
 * Drops the run database and its logins (and the runtime role when the run created it), and fails if anything of
 * the run is left.
 */
export async function dropRunDatabase(
  owner: URL,
  run: RunEnvironment,
  dropRuntimeRole = false
): Promise<void> {
  const database = runDatabaseName(run.runId);
  await withOwner(owner, "postgres", async (pool) => {
    await pool.query(
      `DROP DATABASE IF EXISTS ${quoted(database, databasePattern)} WITH (FORCE)`
    );
    for (const binding of HYPERDRIVE_BINDINGS) {
      const login = quoted(runLoginName(run.runId, binding), runLoginPattern);
      // biome-ignore lint/performance/noAwaitInLoops: one role at a time on one connection
      await pool.query(`DROP ROLE IF EXISTS ${login}`);
    }
    if (dropRuntimeRole) {
      await pool.query(`DROP ROLE IF EXISTS ${RUNTIME_ROLE}`);
    }
    const left = await pool.query<{ name: string }>(
      "SELECT datname AS name FROM pg_database WHERE datname = $1 UNION ALL SELECT rolname FROM pg_roles WHERE rolname LIKE $2 OR ($3 AND rolname = $4)",
      [database, `polaris_e2e_${run.runId}_%`, dropRuntimeRole, RUNTIME_ROLE]
    );
    if (left.rows.length > 0) {
      throw new Error(
        `The e2e teardown left ${left.rows.map((row) => row.name).join(", ")}.`
      );
    }
  });
}

/** The owner connection to the run database: the oracle reads with it (it ignores RLS, so it never proves isolation). */
export function runDatabase(owner: URL, run: RunEnvironment) {
  return createDatabase(databaseUrl(owner, runDatabaseName(run.runId)), {
    maxConnections: 2,
  });
}
