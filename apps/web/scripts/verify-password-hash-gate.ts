// biome-ignore-all lint/performance/noAwaitInLoops: a gate runs its probes strictly one at a time, for a clear failure
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createDatabase } from "@polaris/db/client";
import {
  disposableHostPattern,
  expectSqlState,
  gateBranchPattern,
  journalMigrationCount,
  poolerPattern,
  redactedFailure,
  requiredEnvironment,
  runtimeRole,
  sqlState,
  temporaryRuntimeUrl,
} from "../../../packages/db/scripts/sales-gate-support";
import {
  createDatabasePasswordHashStore,
  createPasswordHasher,
  PASSWORD_HASH_PREFIX,
  type PasswordHashQueryable,
  passwordKey,
} from "../src/server/auth/password-hash";

/**
 * The hash of a password in PostgreSQL (migration 0112, ADR 0100 amended), on a real PostgreSQL 18 with the Worker's
 * own hasher (`password-hash.ts`) and the authentication runtime's role:
 *   1. pgcrypto lives in `polaris_password`, which only the authentication runtime uses (the schema is the barrier: on
 *      Neon the functions of a trusted extension stay executable by PUBLIC); the two functions of the interface are SECURITY INVOKER, pin the search_path and are executed by the
 *      authentication runtime only;
 *   2. the real hasher stores `pgbf1$` and a bcrypt of cost 11, a new salt each time, checks the right password (and its
 *      decomposed NFD spelling, with accents) and refuses a wrong one;
 *   3. an old scrypt hash is a wrong password: never recomputed, only one bcrypt of `k` made and dropped, so it takes
 *      as long as an e-mail without an account;
 *   4. the functions refuse a raw password and a text that is not a bcrypt hash (22023), so a raw password is never hashed;
 *   5. the tenant and the Admin runtimes reach neither the functions nor pgcrypto (42501);
 *   6. no line of the console carries the password or `k`;
 *   7. the gate fails on a mutation: with the cost of `auth_password_hash` lowered to 4, in a transaction rolled back,
 *      the probe of the cost fails.
 */
const connectTo = (pool: ReturnType<typeof createDatabase>["pool"]) =>
  pool.connect();
type GateClient = Awaited<ReturnType<typeof connectTo>>;

const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const SCHEMA = "polaris_password";
const FUNCTIONS = {
  crypt: "public.auth_password_crypt(text,text)",
  hash: "public.auth_password_hash(text)",
};
const AUTH_ROLE = "polaris_auth_runtime";
const OTHER_ROLES = [
  "polaris_pr11_runtime",
  "polaris_billing_runtime",
  "polaris_catalog_runtime",
  "polaris_admin_runtime",
  "polaris_admin_owner",
  "polaris_privacy_runtime",
  "polaris_privacy_owner",
  "polaris_outbox_runtime",
  "polaris_outbox_owner",
  "polaris_purge_owner",
  "polaris_media_cleanup_runtime",
  "polaris_media_cleanup_owner",
  "polaris_onboarding_runtime",
  "polaris_login_lock_owner",
];
const STORED_COST_11 = /^pgbf1\$\$2a\$11\$[./A-Za-z0-9]{53}$/;
const OLD_SCRYPT_HASH = `${"ab".repeat(16)}:${"cd".repeat(64)}`;
const PASSWORD = "Ação de 2026!";
const PASSWORD_NFD = PASSWORD.normalize("NFD");
const WRONG_PASSWORD = "Acao de 2026!";

/** Counts the queries, so a check that must not reach the database is seen not to. */
function countingQueryable(client: GateClient) {
  let count = 0;
  const texts: string[] = [];
  const queryable: PasswordHashQueryable = {
    query: (config) => {
      count += 1;
      texts.push(config.text);
      return client.query(config) as unknown as ReturnType<
        PasswordHashQueryable["query"]
      >;
    },
  };
  return { count: () => count, queryable, texts };
}

function captureConsole() {
  const lines: string[] = [];
  const methods = ["debug", "error", "info", "log", "warn"] as const;
  const originals = methods.map((method) => console[method]);
  for (const method of methods) {
    console[method] = (...values: unknown[]) => {
      lines.push(values.map((value) => String(value)).join(" "));
    };
  }
  return {
    lines,
    restore: () => {
      methods.forEach((method, index) => {
        console[method] = originals[index] as (typeof console)[typeof method];
      });
    },
  };
}

/** Probe: the hash has the prefix and cost 11, and the right password (NFC or NFD) passes while a wrong one does not. */
async function probeHashAndCheck(
  hasher: ReturnType<typeof createPasswordHasher>
) {
  const stored = await hasher.hash(PASSWORD);
  assert.match(stored, STORED_COST_11, "pgbf1$ and a bcrypt of cost 11");
  assert.equal(await hasher.verify({ hash: stored, password: PASSWORD }), true);
  assert.equal(
    await hasher.verify({ hash: stored, password: PASSWORD_NFD }),
    true,
    "the decomposed spelling is the same password"
  );
  assert.equal(
    await hasher.verify({ hash: stored, password: WRONG_PASSWORD }),
    false,
    "a wrong password"
  );
  return stored;
}

async function definitionOf(client: GateClient, signature: string) {
  const result = await client.query<{ definition: string }>(
    "SELECT pg_get_functiondef($1::regprocedure) AS definition",
    [signature]
  );
  return String(result.rows[0]?.definition);
}

async function checkCatalog(
  owner: ReturnType<typeof createDatabase>,
  tests: string[]
) {
  const extension = await owner.pool.query<{ schema: string }>(
    `SELECT n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
      WHERE e.extname = 'pgcrypto'`
  );
  assert.deepEqual(
    extension.rows,
    [{ schema: SCHEMA }],
    "pgcrypto lives in its own schema"
  );
  const publicSchemaUse = await owner.pool.query<{ ok: boolean }>(
    `SELECT has_schema_privilege('public', $1, 'USAGE') AS ok`,
    [SCHEMA]
  );
  assert.equal(
    publicSchemaUse.rows[0]?.ok,
    false,
    "PUBLIC does not use the schema"
  );
  for (const role of [AUTH_ROLE, ...OTHER_ROLES]) {
    const uses = await owner.pool.query<{ ok: boolean }>(
      "SELECT has_schema_privilege($1, $2, 'USAGE') AS ok",
      [role, SCHEMA]
    );
    assert.equal(uses.rows[0]?.ok, role === AUTH_ROLE, `schema: ${role}`);
    for (const signature of Object.values(FUNCTIONS)) {
      const can = await owner.pool.query<{ ok: boolean }>(
        "SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS ok",
        [role, signature]
      );
      assert.equal(
        can.rows[0]?.ok,
        role === AUTH_ROLE,
        `${signature}: ${role}`
      );
    }
  }
  for (const [name, signature] of Object.entries(FUNCTIONS)) {
    const info = await owner.pool.query<{
      config: string[] | null;
      definer: boolean;
      public_execute: boolean;
    }>(
      `SELECT p.prosecdef AS definer, p.proconfig AS config,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute
         FROM pg_proc p WHERE p.oid = $1::regprocedure`,
      [signature]
    );
    const [row] = info.rows;
    assert.ok(row, name);
    assert.equal(row.definer, false, `${name} is SECURITY INVOKER`);
    assert.deepEqual(
      row.config,
      ["search_path=pg_catalog, pg_temp"],
      `${name} pins the search_path`
    );
    assert.equal(row.public_execute, false, `${name} is not open to PUBLIC`);
  }
  tests.push(
    "pgcrypto lives in polaris_password, which PUBLIC and every runtime but the authentication one cannot use; the two functions are SECURITY INVOKER with the search_path pinned, closed to PUBLIC and executed by the authentication runtime only"
  );
}

async function run() {
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, gateBranchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);

  const owner = createDatabase(adminUrl, { maxConnections: 2 });
  const logins: [string, string][] = [];
  const tests: string[] = [];
  const closers: (() => Promise<unknown>)[] = [];
  const cleanupFailures: string[] = [];
  const pepper = randomBytes(32).toString("base64");
  let primaryFailure = false;

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

    const login = async (group: string, prefix: string) => {
      const role = `${prefix}_${randomUUID().replaceAll("-", "")}`;
      const password = randomBytes(24).toString("hex");
      await owner.pool.query(
        `CREATE ROLE "${role}" WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`
      );
      await owner.pool.query(`GRANT "${group}" TO "${role}"`);
      logins.push([role, group]);
      const database = createDatabase(
        temporaryRuntimeUrl(adminUrl, role, password),
        { maxConnections: 1 }
      );
      const client = await database.pool.connect();
      closers.push(async () => {
        client.release();
        await database.pool.end();
      });
      return client;
    };

    await checkCatalog(owner, tests);

    const authClient = await login(AUTH_ROLE, "polaris_pwhash_auth");
    const counted = countingQueryable(authClient);
    const hasher = createPasswordHasher({
      pepper,
      store: createDatabasePasswordHashStore(() => counted.queryable),
    });
    const consoleLines = captureConsole();
    let stored: string;
    let elapsedMs: number;
    try {
      const startedAt = performance.now();
      stored = await probeHashAndCheck(hasher);
      elapsedMs = performance.now() - startedAt;
    } finally {
      consoleLines.restore();
    }
    const again = await hasher.hash(PASSWORD);
    assert.notEqual(again, stored, "a new salt for each hash");
    // the Worker's own `k`: the unit tests prove it is the HMAC-SHA-256 of the NFC password with the pepper
    const key = await passwordKey(pepper, PASSWORD);
    for (const line of consoleLines.lines) {
      assert.ok(!line.includes(PASSWORD), "no log line carries the password");
      assert.ok(
        !line.includes(PASSWORD_NFD),
        "no log line carries the password (NFD)"
      );
      assert.ok(!line.includes(key), "no log line carries k");
    }
    tests.push(
      `the Worker's hasher on the authentication role: pgbf1$ and bcrypt of cost 11, a new salt each time, the right password with accents (NFC and NFD) passes and a wrong one does not, nothing of the password or k in the console (one hash and three checks: ${Math.round(elapsedMs)} ms)`
    );

    const before = counted.count();
    assert.equal(
      await hasher.verify({ hash: OLD_SCRYPT_HASH, password: PASSWORD }),
      false
    );
    assert.deepEqual(
      counted.texts.slice(before),
      ["SELECT public.auth_password_hash($1::text) AS hash"],
      "the old hash is never checked: one bcrypt of k is made and dropped, as for an e-mail without an account"
    );
    tests.push(
      "an old scrypt hash is a wrong password: never checked, one bcrypt of k made and dropped (the time of an e-mail without an account)"
    );

    await expectSqlState(
      () =>
        authClient.query("SELECT public.auth_password_hash($1)", [PASSWORD]),
      "22023",
      "a raw password is refused"
    );
    await expectSqlState(
      () =>
        authClient.query("SELECT public.auth_password_crypt($1, $2)", [
          key,
          "$1$salt$hash",
        ]),
      "22023",
      "a text that is not a bcrypt hash is refused"
    );
    await expectSqlState(
      () =>
        authClient.query("SELECT public.auth_password_crypt($1, $2)", [
          PASSWORD,
          stored.slice(PASSWORD_HASH_PREFIX.length),
        ]),
      "22023",
      "a raw password is refused by the check too"
    );
    tests.push(
      "the functions refuse a raw password and a text that is not a bcrypt hash (22023)"
    );

    for (const [group, prefix] of [
      [runtimeRole, "polaris_pwhash_tenant"],
      ["polaris_admin_runtime", "polaris_pwhash_admin"],
    ] as const) {
      const client = await login(group, prefix);
      await expectSqlState(
        () => client.query("SELECT public.auth_password_hash($1)", [key]),
        "42501",
        `${group} cannot hash`
      );
      await expectSqlState(
        () =>
          client.query(
            "SELECT polaris_password.crypt($1, polaris_password.gen_salt('bf', 4))",
            [key]
          ),
        "42501",
        `${group} cannot reach pgcrypto`
      );
    }
    tests.push(
      "the tenant and the Admin runtimes reach neither the functions nor pgcrypto (42501)"
    );

    const mutationClient = await owner.pool.connect();
    try {
      const original = await definitionOf(authClient, FUNCTIONS.hash);
      await mutationClient.query("BEGIN");
      try {
        await mutationClient.query(
          original.replace("gen_salt('bf', 11)", "gen_salt('bf', 4)")
        );
        const mutantHasher = createPasswordHasher({
          pepper,
          store: createDatabasePasswordHashStore(
            () => mutationClient as unknown as PasswordHashQueryable
          ),
        });
        await assert.rejects(
          () => probeHashAndCheck(mutantHasher),
          "the probe of the cost catches a hash of cost 4"
        );
      } finally {
        await mutationClient.query("ROLLBACK");
      }
      assert.equal(
        await definitionOf(authClient, FUNCTIONS.hash),
        original,
        "the function is back to what the migration made"
      );
      await probeHashAndCheck(hasher);
    } finally {
      mutationClient.release();
    }
    tests.push(
      "the gate fails on a mutation: with the cost of auth_password_hash lowered to 4, in a transaction rolled back, the probe fails; the real function passes it afterwards, unchanged"
    );

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
  } catch (error) {
    primaryFailure = true;
    throw error;
  } finally {
    for (const close of closers.reverse()) {
      await close().catch(() => undefined);
    }
    for (const [role, group] of logins) {
      try {
        await owner.pool.query(`REVOKE "${group}" FROM "${role}"`);
        await owner.pool.query(`DROP ROLE IF EXISTS "${role}"`);
      } catch (error) {
        cleanupFailures.push(`role (${redactedFailure(error)})`);
      }
    }
    await owner.pool.end();
    if (cleanupFailures.length > 0) {
      console.error(
        `Password hash gate cleanup failed: ${cleanupFailures.join("; ")}`
      );
      if (!primaryFailure) {
        process.exitCode = 1;
      }
    }
  }
}

run().catch((error: unknown) => {
  console.error(
    `Password hash PostgreSQL gate failed (${redactedFailure(error)}, ${sqlState(error) ?? "no sqlstate"})`
  );
  process.exitCode = 1;
});
