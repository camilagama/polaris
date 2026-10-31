// biome-ignore-all lint/performance/noAwaitInLoops: a gate runs its probes strictly one at a time, for a clear failure
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { createDatabase } from "../src/client";
import { replaceFunctionAsOwner, withGateRole } from "./gate-roles";
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
} from "./sales-gate-support";

/**
 * The lock of the sign-in by password on a real PostgreSQL 18 (ADR 0100, entry screen P2): the table
 * `auth_login_lock`, its six functions, and who can reach what. It proves: the lock on the 5th failure of the window;
 * the release after 15 minutes (the clock of the test: the functions read the database clock, so the gate moves the
 * instants of the row back, as the owner of the table, instead of waiting); the count apart for each e-mail; the same
 * answers whether an account exists or not (nothing reads `user`); the reservation before the password (a parallel
 * burst gets 5 checks, not more); the one-use unlock token; that the app's role and every other runtime role reach
 * neither the table nor the functions; the expiry of the rows of more than one day; and that the gate itself fails
 * when a function is mutated (the 5th-failure and the release probes run again, in a transaction that is rolled back,
 * against a function with the threshold moved and one that never releases).
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const TABLE = "public.auth_login_lock";
const OWNER_ROLE = "polaris_login_lock_owner";
const FUNCTIONS = {
  begin: "public.auth_login_lock_begin(text)",
  clear: "public.auth_login_lock_clear(text)",
  expire: "public.expire_auth_login_lock()",
  failed: "public.auth_login_lock_failed(text)",
  issue: "public.auth_login_lock_issue_unlock(text,bytea)",
  unlock: "public.auth_login_unlock(bytea)",
};
const RUNTIME_ROLES = [
  "polaris_pr11_runtime",
  "polaris_auth_runtime",
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
];
const PRIVILEGES = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
];
const COLUMNS = [
  "attempts",
  "email_key",
  "locked_until",
  "unlock_token_expires_at",
  "unlock_token_sha256",
  "updated_at",
  "window_started_at",
];
const FORBIDDEN_TABLES = /"user"|public\.user\b|\bsession\b|\baccount\b/;
const GATE_SECRET = "gate-only-secret-of-the-login-lock";

interface Begin {
  allowed: boolean;
  newly_locked: boolean;
  retry_after_seconds: number;
}

/** The key the Worker computes: HMAC-SHA-256 of the normalized e-mail, scope `login-lock` (the hex of `limiterKey`). */
function keyOf(email: string): string {
  return createHmac("sha256", GATE_SECRET)
    .update(`login-lock\u0000${email.toLowerCase().trim().normalize("NFC")}`)
    .digest("hex");
}

const sha256 = (token: Buffer) => createHash("sha256").update(token).digest();

/** The calls of the functions, on one connection (the authentication runtime in the gate; the owner for a mutant). */
function lockCalls(client: Client) {
  return {
    async begin(key: string): Promise<Begin> {
      const result = await client.query<Begin>(
        "SELECT allowed, retry_after_seconds, newly_locked FROM public.auth_login_lock_begin($1)",
        [key]
      );
      assert.equal(result.rows.length, 1);
      return result.rows[0] as Begin;
    },
    async clear(key: string) {
      await client.query("SELECT public.auth_login_lock_clear($1)", [key]);
    },
    async expire(): Promise<number> {
      const result = await client.query<{ removed: number }>(
        "SELECT public.expire_auth_login_lock() AS removed"
      );
      return Number(result.rows[0]?.removed);
    },
    async failed(key: string): Promise<boolean> {
      const result = await client.query<{ locked: boolean }>(
        "SELECT public.auth_login_lock_failed($1) AS locked",
        [key]
      );
      return result.rows[0]?.locked === true;
    },
    async issue(key: string, hash: Buffer): Promise<boolean> {
      const result = await client.query<{ issued: boolean }>(
        "SELECT public.auth_login_lock_issue_unlock($1, $2) AS issued",
        [key, hash]
      );
      return result.rows[0]?.issued === true;
    },
    async unlock(hash: Buffer): Promise<string> {
      const result = await client.query<{ answer: string }>(
        "SELECT public.auth_login_unlock($1) AS answer",
        [hash]
      );
      return String(result.rows[0]?.answer);
    },
  };
}

/** The clock of the test: every instant of the row goes back, which is the same as the time going forward. */
async function advance(client: Client, key: string, minutes: number) {
  await client.query(
    `UPDATE ${TABLE}
        SET window_started_at = window_started_at - make_interval(mins => $2),
            locked_until = locked_until - make_interval(mins => $2),
            unlock_token_expires_at = unlock_token_expires_at - make_interval(mins => $2),
            updated_at = updated_at - make_interval(mins => $2)
      WHERE email_key = $1`,
    [key, minutes]
  );
}

async function rowOf(client: Client, key: string) {
  const result = await client.query<{
    attempts: number;
    locked_until: Date | null;
    unlock_token_sha256: Buffer | null;
  }>(
    `SELECT attempts, locked_until, unlock_token_sha256 FROM ${TABLE} WHERE email_key = $1`,
    [key]
  );
  return result.rows[0];
}

/** Probe: four failures leave the e-mail open, the 5th locks it, and a sixth attempt is refused with the time left. */
async function probeFifthFailureLocks(
  calls: ReturnType<typeof lockCalls>,
  key: string
) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    assert.equal((await calls.begin(key)).allowed, true, `attempt ${attempt}`);
    assert.equal(
      await calls.failed(key),
      false,
      `failure ${attempt} does not lock`
    );
  }
  assert.equal(
    (await calls.begin(key)).allowed,
    true,
    "the 5th attempt is still checked"
  );
  assert.equal(await calls.failed(key), true, "the 5th failure locks");
  const refused = await calls.begin(key);
  assert.equal(refused.allowed, false, "the 6th attempt is refused");
  assert.equal(
    refused.newly_locked,
    false,
    "the lock began at the 5th failure, not at the 6th attempt"
  );
  assert.ok(
    refused.retry_after_seconds >= 1 && refused.retry_after_seconds <= 900
  );
}

/** Probe: 15 minutes later the lock is gone and the e-mail starts a new window. */
async function probeReleaseAfterFifteenMinutes(
  calls: ReturnType<typeof lockCalls>,
  shifter: Client,
  key: string
) {
  await advance(shifter, key, 14);
  assert.equal(
    (await calls.begin(key)).allowed,
    false,
    "14 minutes later it is still locked"
  );
  await advance(shifter, key, 2);
  const released = await calls.begin(key);
  assert.equal(released.allowed, true, "16 minutes later it is released");
  assert.equal((await rowOf(shifter, key))?.attempts, 1);
  assert.equal((await rowOf(shifter, key))?.locked_until, null);
}

/** Probe: failures older than the 15-minute window do not count. */
async function probeWindowEnds(
  calls: ReturnType<typeof lockCalls>,
  shifter: Client,
  key: string
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await calls.begin(key);
    await calls.failed(key);
  }
  await advance(shifter, key, 16);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    assert.equal((await calls.begin(key)).allowed, true);
    assert.equal(await calls.failed(key), false);
  }
  assert.equal((await rowOf(shifter, key))?.attempts, 4);
}

/**
 * Probe: a lock that `begin` writes (the 5th attempt's failure was never recorded, as when the Worker died or the
 * answer was a 5xx) reports itself as new, so the unlock e-mail still goes out once; `failed` then reports nothing.
 */
async function probeLockOfBeginIsReported(
  calls: ReturnType<typeof lockCalls>,
  key: string
) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    assert.equal((await calls.begin(key)).allowed, true);
  }
  const locking = await calls.begin(key);
  assert.equal(locking.allowed, false);
  assert.equal(locking.newly_locked, true, "begin reports the lock it wrote");
  assert.equal(
    await calls.failed(key),
    false,
    "failed does not report it twice"
  );
  assert.equal((await calls.begin(key)).newly_locked, false);
  assert.equal(
    await calls.issue(key, sha256(randomBytes(32))),
    true,
    "the unlock token can be issued for it"
  );
}

async function definitionOf(client: Client, signature: string) {
  const result = await client.query<{ definition: string }>(
    "SELECT pg_get_functiondef($1::regprocedure) AS definition",
    [signature]
  );
  return String(result.rows[0]?.definition);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one linear gate script, section by section
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
  const suffix = randomUUID().slice(0, 8);
  const keys: string[] = [];
  const userIds: string[] = [];
  let primaryFailure = false;
  // a key of this run, remembered so the cleanup removes its row
  const freshKey = (label: string) => {
    const key = keyOf(`gate-${label}-${suffix}@example.com`);
    keys.push(key);
    return key;
  };

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
      const url = temporaryRuntimeUrl(adminUrl, role, password);
      const connect = async () => {
        const client = new Client({
          connectionString: url,
          connectionTimeoutMillis: 5000,
        });
        await client.connect();
        closers.push(() => client.end());
        return client;
      };
      return connect;
    };
    const connectAuth = await login(
      "polaris_auth_runtime",
      "polaris_llock_auth"
    );
    const authClient = await connectAuth();
    const auth = lockCalls(authClient);
    const adminClient = await (
      await login("polaris_admin_runtime", "polaris_llock_admin")
    )();
    const tenantClient = await (
      await login(runtimeRole, "polaris_llock_tenant")
    )();
    const ownerClient = await (
      await login(OWNER_ROLE, "polaris_llock_owner")
    )();

    // ---- the shape: what the table holds, who owns what, who can reach it
    const columns = await owner.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'auth_login_lock' ORDER BY column_name`
    );
    assert.deepEqual(
      columns.rows.map((row) => row.column_name),
      COLUMNS,
      "no e-mail, user ID or IP column"
    );
    const table = await owner.pool.query<{
      forced: boolean;
      rls: boolean;
    }>(
      `SELECT relrowsecurity AS rls, relforcerowsecurity AS forced FROM pg_class
        WHERE oid = '${TABLE}'::regclass`
    );
    assert.deepEqual(table.rows[0], { forced: true, rls: true });
    const policies = await owner.pool.query<{ roles: string[] }>(
      `SELECT roles::text[] AS roles FROM pg_policies WHERE schemaname = 'public' AND tablename = 'auth_login_lock'`
    );
    assert.deepEqual(
      policies.rows.map((row) => row.roles),
      [[OWNER_ROLE]],
      "one policy, for the owner role only"
    );
    const ownerAttributes = await owner.pool.query<{
      rolbypassrls: boolean;
      rolcanlogin: boolean;
      rolinherit: boolean;
      rolsuper: boolean;
    }>(
      `SELECT rolcanlogin, rolsuper, rolbypassrls, rolinherit FROM pg_roles WHERE rolname = '${OWNER_ROLE}'`
    );
    assert.deepEqual(ownerAttributes.rows[0], {
      rolbypassrls: false,
      rolcanlogin: false,
      rolinherit: false,
      rolsuper: false,
    });
    for (const [name, signature] of Object.entries(FUNCTIONS)) {
      const info = await owner.pool.query<{
        config: string[] | null;
        definer: boolean;
        owner: string;
        public_execute: boolean;
      }>(
        `SELECT p.prosecdef AS definer, p.proconfig AS config, r.rolname AS owner,
                has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute
           FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE p.oid = '${signature}'::regprocedure`
      );
      const [row] = info.rows;
      assert.ok(row, name);
      assert.equal(row.definer, true, `${name} is SECURITY DEFINER`);
      assert.deepEqual(
        row.config,
        ["search_path=pg_catalog, pg_temp"],
        `${name} pins the search_path`
      );
      assert.equal(row.owner, OWNER_ROLE, `${name} belongs to the owner role`);
      assert.equal(row.public_execute, false, `${name} is not open to PUBLIC`);
      for (const role of RUNTIME_ROLES) {
        const can = await owner.pool.query<{ ok: boolean }>(
          "SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS ok",
          [role, signature]
        );
        assert.equal(
          can.rows[0]?.ok,
          role === "polaris_auth_runtime",
          `${name}: ${role}`
        );
      }
    }
    for (const role of RUNTIME_ROLES) {
      for (const privilege of PRIVILEGES) {
        const can = await owner.pool.query<{ ok: boolean }>(
          "SELECT has_table_privilege($1, $2::regclass, $3) AS ok",
          [role, TABLE, privilege]
        );
        assert.equal(can.rows[0]?.ok, false, `${role} has ${privilege}`);
      }
    }
    // the whole ACL, not a list of roles: PUBLIC and roles created later are covered, and no column has a grant of its own
    const tableAcl = await owner.pool.query<{
      grantee: string;
      privilege: string;
    }>(
      `SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee, a.privilege_type AS privilege
         FROM pg_class c, LATERAL aclexplode(c.relacl) a WHERE c.oid = '${TABLE}'::regclass AND a.grantee <> c.relowner`
    );
    assert.deepEqual(
      [...new Set(tableAcl.rows.map((row) => row.grantee))],
      [OWNER_ROLE],
      "besides the role that owns the table, only the owner role of the functions holds a privilege on it"
    );
    assert.deepEqual(
      tableAcl.rows.map((row) => row.privilege).sort(),
      ["DELETE", "INSERT", "SELECT", "UPDATE"],
      "the owner role can read and write, never truncate"
    );
    const columnAcl = await owner.pool.query(
      `SELECT 1 FROM pg_attribute WHERE attrelid = '${TABLE}'::regclass AND attacl IS NOT NULL`
    );
    assert.equal(columnAcl.rows.length, 0, "no column has an ACL of its own");
    for (const signature of Object.values(FUNCTIONS)) {
      const functionAcl = await owner.pool.query<{ grantee: string }>(
        `SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee
           FROM pg_proc p, LATERAL aclexplode(p.proacl) a WHERE p.oid = '${signature}'::regprocedure ORDER BY 1`
      );
      assert.deepEqual(
        functionAcl.rows.map((row) => row.grantee),
        ["polaris_auth_runtime", OWNER_ROLE],
        `${signature}: the ACL is the owner and the authentication runtime`
      );
    }
    tests.push(
      "the table has no e-mail, user or IP column, RLS is enabled and forced with one policy for the owner role; the six functions are SECURITY DEFINER, pin search_path = pg_catalog, pg_temp, belong to the NOLOGIN owner and are executable by polaris_auth_runtime only (not PUBLIC); no role besides the owner has any privilege on the table (the whole ACL, PUBLIC included, and no column ACL)"
    );

    // ---- the lock on the 5th failure, and the release after 15 minutes
    const keyA = freshKey("a");
    await probeFifthFailureLocks(auth, keyA);
    tests.push(
      "4 failures leave the e-mail open, the 5th locks it, and the 6th attempt is refused with 1 to 900 seconds left"
    );
    await probeReleaseAfterFifteenMinutes(auth, ownerClient, keyA);
    tests.push(
      "14 minutes later the e-mail is still locked, 16 minutes later it is released with a count of 1 (the clock of the test)"
    );

    // a window that ended zeroes the count: 3 failures, 16 minutes and 4 more failures do not lock
    await probeWindowEnds(auth, ownerClient, freshKey("window"));
    tests.push(
      "failures older than the 15-minute window do not count: 3 failures, 16 minutes and 4 more do not lock"
    );

    // ---- the count is apart for each e-mail
    const keyB = freshKey("b");
    const other = await auth.begin(keyB);
    assert.deepEqual(other, {
      allowed: true,
      newly_locked: false,
      retry_after_seconds: 0,
    });
    assert.equal((await rowOf(ownerClient, keyB))?.attempts, 1);
    const keyLocked = freshKey("locked");
    await probeFifthFailureLocks(auth, keyLocked);
    assert.equal(
      (await auth.begin(keyB)).allowed,
      true,
      "B is not locked by A"
    );
    tests.push(
      "the count is apart for each e-mail: locking one leaves the other with its own count"
    );

    // ---- the same answers whether an account exists or not
    const existing = `gate-exists-${suffix}@example.com`;
    userIds.push(`gate-llock-${suffix}`);
    await owner.pool.query(
      `INSERT INTO public."user" (id, name, email, email_verified) VALUES ($1, 'Gate', $2, true)`,
      [userIds[0], existing]
    );
    const transcript = async (email: string) => {
      const key = keyOf(email);
      keys.push(key);
      const seen: (boolean | number)[] = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const answer = await auth.begin(key);
        seen.push(answer.allowed, answer.retry_after_seconds > 0);
        if (answer.allowed) {
          seen.push(await auth.failed(key));
        }
      }
      return seen;
    };
    assert.deepEqual(
      await transcript(existing),
      await transcript(`gate-missing-${suffix}@example.com`)
    );
    const bodies = await owner.pool.query<{ body: string }>(
      `SELECT pg_get_functiondef(p.oid) AS body FROM pg_proc p
        WHERE p.oid = ANY ($1::regprocedure[])`,
      [Object.values(FUNCTIONS)]
    );
    for (const row of bodies.rows) {
      assert.doesNotMatch(row.body, FORBIDDEN_TABLES);
    }
    tests.push(
      "an e-mail with an account and one without get the same answers to the same attempts, and no function mentions the user, session or account tables"
    );

    // ---- the reservation before the password: a parallel burst gets 5 checks
    const connections = [authClient];
    for (let index = 1; index < 12; index += 1) {
      connections.push(await connectAuth());
    }
    const keyBurst = freshKey("burst");
    const burst = await Promise.all(
      connections.map((connection) => lockCalls(connection).begin(keyBurst))
    );
    assert.equal(burst.filter((answer) => answer.allowed).length, 5);
    assert.equal(burst.filter((answer) => !answer.allowed).length, 7);
    // the failures of the 5 checks arrive after the lock the burst wrote: one lock, reported once (by `begin`)
    let reported = burst.filter((answer) => answer.newly_locked).length;
    for (let index = 0; index < 5; index += 1) {
      if (await auth.failed(keyBurst)) {
        reported += 1;
      }
    }
    assert.equal(reported, 1, "one lock, one report");
    tests.push(
      "12 parallel attempts on one e-mail, with no failure recorded yet, get exactly 5 checks (the attempt is reserved before the password), and the one lock they cause is reported once"
    );
    await probeLockOfBeginIsReported(auth, freshKey("begin-lock"));
    tests.push(
      "a lock written by begin (a 5th attempt whose failure was never recorded) is reported as new by begin and not again by failed, and an unlock token can be issued for it"
    );

    // ---- a success, a 403 EMAIL_NOT_VERIFIED and a reset clear the e-mail
    const keyClear = freshKey("clear");
    await auth.begin(keyClear);
    await auth.failed(keyClear);
    await auth.clear(keyClear);
    assert.equal(await rowOf(ownerClient, keyClear), undefined);
    await auth.clear(keyClear);
    tests.push(
      "clear forgets the e-mail, and clearing an unknown one is a no-op"
    );

    // ---- bad input
    await expectSqlState(() => auth.begin("not-a-key"), "22023", "begin key");
    await expectSqlState(
      () => auth.begin(keyOf("X@example.com").toUpperCase()),
      "22023",
      "begin uppercase key"
    );
    await expectSqlState(() => auth.failed("x"), "22023", "failed key");
    await expectSqlState(() => auth.clear("x"), "22023", "clear key");
    await expectSqlState(
      () => auth.issue(keyA, Buffer.alloc(31)),
      "22023",
      "issue hash length"
    );
    assert.equal(await auth.unlock(Buffer.alloc(31)), "invalid");
    tests.push(
      "a key that is not 64 lowercase hex digits raises 22023 (the sign-in fails closed); a token hash of the wrong length is `invalid` to the unlock and 22023 to the issue"
    );

    // ---- the unlock token: one per lock, one hour, idempotent, never zeroing a later count
    const keyUnlock = freshKey("unlock");
    const token = randomBytes(32);
    assert.equal(await auth.issue(keyUnlock, sha256(token)), false);
    await probeFifthFailureLocks(auth, keyUnlock);
    assert.equal(await auth.issue(keyUnlock, sha256(token)), true);
    assert.equal(
      await auth.issue(keyUnlock, sha256(randomBytes(32))),
      false,
      "one token per lock"
    );
    assert.equal(await auth.unlock(sha256(randomBytes(32))), "invalid");
    const stored = await rowOf(ownerClient, keyUnlock);
    assert.deepEqual(stored?.unlock_token_sha256, sha256(token));
    assert.equal(await auth.unlock(sha256(token)), "unlocked");
    assert.equal((await auth.begin(keyUnlock)).allowed, true);
    assert.equal((await rowOf(ownerClient, keyUnlock))?.attempts, 1);
    // the same token again, within the hour: `unlocked`, and the count that grew is left alone
    await auth.failed(keyUnlock);
    assert.equal(await auth.unlock(sha256(token)), "unlocked");
    assert.equal((await rowOf(ownerClient, keyUnlock))?.attempts, 1);
    // a later lock drops the token: the old one is `invalid` and the new lock can have its own e-mail
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await auth.begin(keyUnlock);
      await auth.failed(keyUnlock);
    }
    assert.equal((await auth.begin(keyUnlock)).allowed, false);
    assert.equal(await auth.unlock(sha256(token)), "invalid");
    assert.equal(await auth.issue(keyUnlock, sha256(randomBytes(32))), true);
    tests.push(
      "the unlock token is issued only while locked and once per lock; the unlock lifts the lock and zeroes the count, the same token again changes nothing, an unknown one is invalid, and a later lock drops the old token"
    );
    const keyExpired = freshKey("token-expired");
    const lateToken = randomBytes(32);
    await probeFifthFailureLocks(auth, keyExpired);
    assert.equal(await auth.issue(keyExpired, sha256(lateToken)), true);
    await advance(ownerClient, keyExpired, 61);
    assert.equal(await auth.unlock(sha256(lateToken)), "invalid");
    assert.equal(await auth.issue(keyExpired, sha256(randomBytes(32))), false);
    tests.push(
      "an unlock token is `invalid` after its hour, and a lock that ended takes no new token"
    );

    // ---- the app's role and the other runtimes reach nothing
    const attempts: [string, Client][] = [
      ["tenant", tenantClient],
      ["admin", adminClient],
    ];
    for (const [label, client] of attempts) {
      for (const statement of [
        `SELECT 1 FROM ${TABLE}`,
        `INSERT INTO ${TABLE} (email_key) VALUES ('${keyOf("direct@example.com")}')`,
        `UPDATE ${TABLE} SET attempts = 0`,
        `DELETE FROM ${TABLE}`,
        `TRUNCATE ${TABLE}`,
        `SELECT public.auth_login_lock_begin('${keyA}')`,
        "SELECT public.expire_auth_login_lock()",
      ]) {
        await expectSqlState(
          () => client.query(statement),
          "42501",
          `${label}: ${statement}`
        );
      }
    }
    // the authentication runtime itself reads nothing: the functions are its whole interface
    for (const statement of [
      `SELECT 1 FROM ${TABLE}`,
      `DELETE FROM ${TABLE}`,
      `UPDATE ${TABLE} SET attempts = 0`,
    ]) {
      await expectSqlState(
        () => authClient.query(statement),
        "42501",
        `auth: ${statement}`
      );
    }
    tests.push(
      "the app's tenant role and the Admin runtime are refused (42501) on every statement on the table and on the functions; the authentication runtime cannot read or change the table either, only call the functions"
    );

    // ---- the expiry of the rows of more than one day
    const keyOld = freshKey("old");
    const keyNew = freshKey("new");
    await auth.begin(keyOld);
    await auth.begin(keyNew);
    await advance(ownerClient, keyOld, 25 * 60);
    await advance(ownerClient, keyNew, 23 * 60);
    const removed = await auth.expire();
    assert.ok(removed >= 1);
    assert.equal(await rowOf(ownerClient, keyOld), undefined);
    assert.ok(await rowOf(ownerClient, keyNew));
    assert.equal(await auth.expire(), 0, "nothing else is old");
    await expectSqlState(
      () => lockCalls(adminClient).expire(),
      "42501",
      "the Admin does not expire"
    );
    tests.push(
      "the expiry removes the rows untouched for more than a day, keeps the one of 23 hours and answers how many it removed; only the authentication runtime executes it"
    );

    // ---- the gate fails on a mutation of a function
    const mutants: [string, string, string, string][] = [
      [
        "the 5th failure locks at the 6th",
        FUNCTIONS.failed,
        "current_row.attempts < 5",
        "current_row.attempts < 6",
      ],
      [
        "the lock never ends",
        FUNCTIONS.begin,
        "IF current_row.locked_until > now_at THEN",
        "IF current_row.locked_until > now_at - interval '1 year' THEN",
      ],
      [
        "the window never ends",
        FUNCTIONS.begin,
        "window_started_at + interval '15 minutes' <= now_at",
        "window_started_at + interval '15 years' <= now_at",
      ],
      [
        "begin does not report the lock it wrote",
        FUNCTIONS.begin,
        "newly_locked := true;",
        "newly_locked := false;",
      ],
    ];
    // `shifter` moves the clock of a row: the owner role, which alone reaches the table
    const probes = [
      (calls: ReturnType<typeof lockCalls>, _shifter: Client, key: string) =>
        probeFifthFailureLocks(calls, key),
      async (
        calls: ReturnType<typeof lockCalls>,
        shifter: Client,
        key: string
      ) => {
        await probeFifthFailureLocks(calls, key);
        await probeReleaseAfterFifteenMinutes(calls, shifter, key);
      },
      (calls: ReturnType<typeof lockCalls>, shifter: Client, key: string) =>
        probeWindowEnds(calls, shifter, key),
      (calls: ReturnType<typeof lockCalls>, _shifter: Client, key: string) =>
        probeLockOfBeginIsReported(calls, key),
    ];
    const mutationClient = await owner.pool.connect();
    try {
      for (const [index, [label, signature, from, to]] of mutants.entries()) {
        const original = await definitionOf(mutationClient, signature);
        assert.ok(
          original.includes(from),
          `${label}: the text to mutate exists`
        );
        const mutated = original.replace(from, to);
        assert.notEqual(mutated, original);
        await mutationClient.query("BEGIN");
        try {
          // the mutant is written by the functions' owner role and probed as it, the role that alone reaches the table
          await replaceFunctionAsOwner(mutationClient, signature, mutated);
          const probe = probes[index];
          assert.ok(probe);
          await withGateRole(mutationClient, OWNER_ROLE, async () => {
            await assert.rejects(
              () =>
                probe(
                  lockCalls(mutationClient),
                  mutationClient,
                  freshKey(`mutant-${index}`)
                ),
              // an assertion of the probe failed, not a database error of its own
              (error: unknown) => error instanceof assert.AssertionError,
              `the probes catch the mutation: ${label}`
            );
          });
        } finally {
          await mutationClient.query("ROLLBACK");
        }
        assert.equal(
          await definitionOf(mutationClient, signature),
          original,
          `${label}: the function is back to what the migration made`
        );
        // and the real function still passes the same probe, on a fresh e-mail
        await probes[index]?.(auth, ownerClient, freshKey(`real-${index}`));
      }
    } finally {
      mutationClient.release();
    }
    tests.push(
      "the gate fails on a mutation: with the threshold of the 5th failure moved to 6, a lock that never ends, a window that never ends, or a begin that does not report its lock, the probes fail inside a transaction that is rolled back; the real functions pass the same probes afterwards, unchanged"
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
    const cleanup = async (
      label: string,
      text: string,
      values: unknown[] = []
    ) => {
      try {
        await owner.pool.query(text, values);
      } catch (error) {
        cleanupFailures.push(`${label} (${redactedFailure(error)})`);
      }
    };
    await cleanup("rows", `DELETE FROM ${TABLE} WHERE email_key = ANY ($1)`, [
      keys,
    ]);
    await cleanup("user", `DELETE FROM public."user" WHERE id = ANY ($1)`, [
      userIds,
    ]);
    for (const [role, group] of logins) {
      await cleanup("revoke", `REVOKE "${group}" FROM "${role}"`);
      await cleanup("role", `DROP ROLE IF EXISTS "${role}"`);
    }
    await owner.pool.end();
    if (cleanupFailures.length > 0) {
      console.error(
        `Login lock gate cleanup failed: ${cleanupFailures.join("; ")}`
      );
      if (!primaryFailure) {
        process.exitCode = 1;
      }
    }
  }
}

run().catch((error: unknown) => {
  console.error(
    `Login lock PostgreSQL gate failed (${redactedFailure(error)}, ${sqlState(error) ?? "no sqlstate"})`
  );
  process.exitCode = 1;
});
