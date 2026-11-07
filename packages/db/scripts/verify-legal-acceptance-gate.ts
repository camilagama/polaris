// biome-ignore-all lint/performance/noAwaitInLoops: a gate runs its probes strictly one at a time, for a clear failure
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
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
 * The record of legal acceptance on a real PostgreSQL 18 (ADR 0100, entry screen P4): the table `legal_acceptance`,
 * its two functions, and who can reach what. It proves: the table only grows (UPDATE, DELETE and TRUNCATE are refused
 * by the triggers for every role, the table's owner included, and the triggers fire ALWAYS); the isolation by user (a
 * user's versions never include another's, and no runtime role reads or writes the table, only calls the functions);
 * the minimum version (the function answers the highest version of each document, so a version below the minimum is
 * pending and a newer one never lowers it); that no IP, browser or timestamp of the client is recorded (the columns,
 * the arguments and the format of every text field leave no room for one); the idempotence, also for 8 requests at
 * once; and that the gate itself fails when a function or the trigger is mutated (the probes run again, in a
 * transaction that is rolled back, against a function that takes the minimum instead of the maximum, one that forgets
 * the user, one that does not recognize a repeat or a changed text, and a trigger that lets a row go).
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const TABLE = "public.legal_acceptance";
const OWNER_ROLE = "polaris_legal_acceptance_owner";
const FUNCTIONS = {
  record: "public.record_legal_acceptance(text,text,integer,text,text,text)",
  versions: "public.legal_acceptance_versions(text)",
};
const TRIGGER_FUNCTION = "public.legal_acceptance_immutable()";
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
  "accepted_at",
  "document",
  "id",
  "origin",
  "request_id",
  "text_sha256",
  "user_id",
  "version",
];
const ARGUMENTS = [
  "p_document",
  "p_origin",
  "p_request",
  "p_sha256",
  "p_user",
  "p_version",
];
const FORBIDDEN_TABLES = /"user"|public\.user\b|\bsession\b|\baccount\b/;
const NO_IP_OR_INSTANT = /inet|timestamp/;
const INVALID_RESULT = /^invalid_/;
const IP_IN_TEXT = /\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]*:[0-9a-f]*:/i;

interface Version {
  document: string;
  version: number;
}

const sha256Of = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
const TERMS_V1 = sha256Of("termos v1");
const TERMS_V2 = sha256Of("termos v2");
const PRIVACY_V1 = sha256Of("privacidade v1");

/**
 * The calls of the two functions, on one connection: a login of the authentication runtime, or (for a mutant) the gate's
 * connection with each call made as that runtime through `as`.
 */
function acceptanceCalls(
  client: Client,
  as: <T>(work: () => Promise<T>) => Promise<T> = (work) => work()
) {
  return {
    async record(
      user: string,
      document: string,
      version: number,
      sha256: string,
      origin: string,
      request: string
    ): Promise<string> {
      const result = await as(() =>
        client.query<{ result: string }>(
          "SELECT public.record_legal_acceptance($1, $2, $3, $4, $5, $6) AS result",
          [user, document, version, sha256, origin, request]
        )
      );
      return String(result.rows[0]?.result);
    },
    async versions(user: string): Promise<Version[]> {
      const result = await as(() =>
        client.query<Version>(
          "SELECT document, version FROM public.legal_acceptance_versions($1)",
          [user]
        )
      );
      return result.rows;
    },
  };
}

type Calls = ReturnType<typeof acceptanceCalls>;

/** What the code does with the answer: the documents whose accepted version is below the minimum (or never accepted). */
function pendingDocuments(
  minimums: Record<string, number>,
  accepted: Version[]
): string[] {
  return Object.entries(minimums)
    .filter(
      ([document, minimum]) =>
        (accepted.find((row) => row.document === document)?.version ?? 0) <
        minimum
    )
    .map(([document]) => document);
}

async function countOf(client: Client, user: string): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${TABLE} WHERE user_id = $1`,
    [user]
  );
  return Number(result.rows[0]?.count);
}

/** Probe: a repeat is `already_accepted` and writes nothing; the same version with another text is refused and changes nothing. */
async function probeIdempotent(
  calls: Calls,
  reader: Client,
  user: string,
  request: string
) {
  assert.equal(
    await calls.record(user, "terms", 1, TERMS_V1, "signup", request),
    "recorded"
  );
  assert.equal(
    await calls.record(user, "terms", 1, TERMS_V1, "reaceite", `${request}b`),
    "already_accepted",
    "a repeat is not written again"
  );
  assert.equal(await countOf(reader, user), 1);
  assert.equal(
    await calls.record(user, "terms", 1, TERMS_V2, "signup", `${request}c`),
    "invalid_hash",
    "another text under the same version is not confirmed"
  );
  const stored = await reader.query<{ origin: string; text_sha256: string }>(
    `SELECT origin, text_sha256 FROM ${TABLE} WHERE user_id = $1`,
    [user]
  );
  assert.deepEqual(stored.rows, [{ origin: "signup", text_sha256: TERMS_V1 }]);
}

/** Probe: the answer is the highest version of each document, whatever order they were accepted in, and only this user's. */
async function probeHighestVersion(
  calls: Calls,
  user: string,
  other: string,
  request: string
) {
  assert.deepEqual(await calls.versions(user), []);
  assert.equal(
    await calls.record(user, "terms", 1, TERMS_V1, "signup", `${request}1`),
    "recorded"
  );
  assert.equal(
    await calls.record(user, "privacy", 1, PRIVACY_V1, "signup", `${request}2`),
    "recorded"
  );
  assert.deepEqual(await calls.versions(user), [
    { document: "privacy", version: 1 },
    { document: "terms", version: 1 },
  ]);
  assert.equal(
    await calls.record(user, "terms", 3, TERMS_V2, "reaceite", `${request}3`),
    "recorded"
  );
  assert.equal(
    await calls.record(user, "terms", 2, TERMS_V2, "reaceite", `${request}4`),
    "recorded",
    "an older version accepted later is history"
  );
  assert.deepEqual(await calls.versions(user), [
    { document: "privacy", version: 1 },
    { document: "terms", version: 3 },
  ]);
  assert.deepEqual(
    await calls.versions(other),
    [],
    "another user's acceptance is not this user's"
  );
}

/** Probe: the trigger refuses to let a row go, for the table's owner (it bypasses RLS here, as the migration user does). */
async function probeRowsStay(admin: Client, user: string) {
  await expectSqlState(
    () => admin.query(`DELETE FROM ${TABLE} WHERE user_id = $1`, [user]),
    "23514",
    "the trigger refuses the DELETE"
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
  let primaryFailure = false;
  let counter = 0;
  // the rows of a gate stay (the table only grows): every user and request of a run is unique to it
  const freshUser = (label: string) => `gate-legal-${label}-${suffix}`;
  const freshRequest = () => {
    counter += 1;
    return `gate-legal-${suffix}-${counter}`;
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
      "polaris_lacc_auth"
    );
    const authClient = await connectAuth();
    const auth = acceptanceCalls(authClient);
    const adminClient = await (
      await login("polaris_admin_runtime", "polaris_lacc_admin")
    )();
    const tenantClient = await (
      await login(runtimeRole, "polaris_lacc_tenant")
    )();
    // a login that is a member of the owner role: it reads the rows the gate checks (nothing else can)
    const ownerClient = await (await login(OWNER_ROLE, "polaris_lacc_owner"))();

    // ---- the shape: what the table holds, who owns what, who can reach it
    const columns = await owner.pool.query<{
      column_name: string;
      data_type: string;
    }>(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'legal_acceptance' ORDER BY column_name`
    );
    assert.deepEqual(
      columns.rows.map((column) => column.column_name),
      COLUMNS,
      "no IP, browser or user agent column"
    );
    assert.equal(
      columns.rows.some((column) => column.data_type === "inet"),
      false,
      "no column of the type of an IP"
    );
    const table = await owner.pool.query<{ forced: boolean; rls: boolean }>(
      `SELECT relrowsecurity AS rls, relforcerowsecurity AS forced FROM pg_class
        WHERE oid = '${TABLE}'::regclass`
    );
    assert.deepEqual(table.rows[0], { forced: true, rls: true });
    const policies = await owner.pool.query<{
      cmd: string;
      roles: string[];
    }>(
      `SELECT cmd, roles::text[] AS roles FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'legal_acceptance' ORDER BY cmd`
    );
    assert.deepEqual(
      policies.rows,
      [
        { cmd: "INSERT", roles: [OWNER_ROLE] },
        { cmd: "SELECT", roles: [OWNER_ROLE] },
      ],
      "an INSERT and a SELECT policy, for the owner role only: none for UPDATE or DELETE"
    );
    const ownerAttributes = await owner.pool.query<{
      rolbypassrls: boolean;
      rolcanlogin: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolinherit: boolean;
      rolreplication: boolean;
      rolsuper: boolean;
    }>(
      `SELECT rolcanlogin, rolsuper, rolbypassrls, rolinherit, rolcreaterole, rolcreatedb, rolreplication FROM pg_roles WHERE rolname = '${OWNER_ROLE}'`
    );
    assert.deepEqual(ownerAttributes.rows[0], {
      rolbypassrls: false,
      rolcanlogin: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolinherit: false,
      rolreplication: false,
      rolsuper: false,
    });
    for (const [name, signature] of Object.entries(FUNCTIONS)) {
      const info = await owner.pool.query<{
        arguments: string[] | null;
        argument_types: string;
        config: string[] | null;
        definer: boolean;
        owner: string;
        public_execute: boolean;
      }>(
        `SELECT p.prosecdef AS definer, p.proconfig AS config, r.rolname AS owner, p.proargnames AS arguments,
                pg_get_function_arguments(p.oid) AS argument_types,
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
      assert.doesNotMatch(
        row.argument_types,
        NO_IP_OR_INSTANT,
        `${name} takes no IP and no instant`
      );
      if (name === "record") {
        assert.deepEqual(
          [...(row.arguments ?? [])].sort(),
          ARGUMENTS,
          "record takes the user, document, version, text hash, origin and request ID, nothing else"
        );
      }
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
      [...new Set(tableAcl.rows.map((entry) => entry.grantee))],
      [OWNER_ROLE],
      "besides the role that owns the table, only the owner role of the functions holds a privilege on it"
    );
    assert.deepEqual(
      tableAcl.rows.map((entry) => entry.privilege).sort(),
      ["INSERT", "SELECT"],
      "the owner role can read and append, never change, delete or truncate"
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
        functionAcl.rows.map((entry) => entry.grantee),
        ["polaris_auth_runtime", OWNER_ROLE],
        `${signature}: the ACL is the owner and the authentication runtime`
      );
    }
    const bodies = await owner.pool.query<{ body: string }>(
      "SELECT pg_get_functiondef(p.oid) AS body FROM pg_proc p WHERE p.oid = ANY ($1::regprocedure[])",
      [Object.values(FUNCTIONS)]
    );
    for (const row of bodies.rows) {
      assert.doesNotMatch(row.body, FORBIDDEN_TABLES);
    }
    tests.push(
      "the table has no IP, browser or user agent column (nor one of the type inet), RLS is enabled and forced with an INSERT and a SELECT policy for the owner role only (none for UPDATE or DELETE); the two functions are SECURITY DEFINER, pin search_path = pg_catalog, pg_temp, take no IP and no instant, belong to the NOLOGIN owner and are executable by polaris_auth_runtime only (not PUBLIC); no role besides the owner has any privilege on the table (the whole ACL, PUBLIC included, and no column ACL) and the owner has only SELECT and INSERT"
    );

    // ---- recording: the first time, the repeat, the changed text and the bad input
    const readerBefore = await owner.pool.query<{ now: Date }>(
      "SELECT clock_timestamp() AS now"
    );
    const userA = freshUser("a");
    const userB = freshUser("b");
    const requestA = freshRequest();
    await probeIdempotent(auth, ownerClient, userA, requestA);
    const readerAfter = await owner.pool.query<{ now: Date }>(
      "SELECT clock_timestamp() AS now"
    );
    const firstAcceptance = await ownerClient.query<{
      accepted_at: Date;
      request_id: string;
      version: number;
    }>(
      `SELECT accepted_at, request_id, version FROM ${TABLE} WHERE user_id = $1`,
      [userA]
    );
    assert.equal(firstAcceptance.rows[0]?.request_id, requestA);
    const acceptedAt = firstAcceptance.rows[0]?.accepted_at.getTime() ?? 0;
    assert.ok(
      acceptedAt >= (readerBefore.rows[0]?.now.getTime() ?? 0) - 1 &&
        acceptedAt <= (readerAfter.rows[0]?.now.getTime() ?? 0) + 1,
      "the instant is the database clock"
    );
    tests.push(
      "the first acceptance is recorded with the request ID and the database clock; the same acceptance again is `already_accepted` and writes nothing (with another origin or request ID too); the same version with another text hash is `invalid_hash`, and the stored proof stays as it was"
    );

    const rowsBefore = await countOf(ownerClient, userB);
    const bad: [string, string, string, number, string, string, string][] = [
      ["invalid_user", "", "terms", 1, TERMS_V1, "signup", "x"],
      ["invalid_user", "has space", "terms", 1, TERMS_V1, "signup", "x"],
      ["invalid_user", "203.0.113.9", "terms", 1, TERMS_V1, "signup", "x"],
      ["invalid_user", "a".repeat(65), "terms", 1, TERMS_V1, "signup", "x"],
      ["invalid_document", userB, "cookies", 1, TERMS_V1, "signup", "x"],
      ["invalid_document", userB, "TERMS", 1, TERMS_V1, "signup", "x"],
      ["invalid_version", userB, "terms", 0, TERMS_V1, "signup", "x"],
      ["invalid_version", userB, "terms", -1, TERMS_V1, "signup", "x"],
      ["invalid_version", userB, "terms", 1001, TERMS_V1, "signup", "x"],
      [
        "invalid_version",
        userB,
        "terms",
        2_147_483_647,
        TERMS_V1,
        "signup",
        "x",
      ],
      ["invalid_hash", userB, "terms", 1, "abc", "signup", "x"],
      [
        "invalid_hash",
        userB,
        "terms",
        1,
        TERMS_V1.toUpperCase(),
        "signup",
        "x",
      ],
      ["invalid_origin", userB, "terms", 1, TERMS_V1, "google", "x"],
      ["invalid_request", userB, "terms", 1, TERMS_V1, "signup", ""],
      ["invalid_request", userB, "terms", 1, TERMS_V1, "signup", "203.0.113.9"],
      ["invalid_request", userB, "terms", 1, TERMS_V1, "signup", "2001:db8::1"],
      ["invalid_request", userB, "terms", 1, TERMS_V1, "signup", "has space"],
    ];
    await authClient.query("BEGIN");
    for (const [
      expected,
      user,
      document,
      version,
      hash,
      origin,
      request,
    ] of bad) {
      assert.equal(
        await auth.record(user, document, version, hash, origin, request),
        expected,
        `${expected}: ${user.slice(0, 20)} ${document} ${version} ${origin} ${request}`
      );
    }
    for (const [user, document, version, hash, origin, request] of [
      [null, "terms", 1, TERMS_V1, "signup", "x"],
      [userB, null, 1, TERMS_V1, "signup", "x"],
      [userB, "terms", null, TERMS_V1, "signup", "x"],
      [userB, "terms", 1, null, "signup", "x"],
      [userB, "terms", 1, TERMS_V1, null, "x"],
      [userB, "terms", 1, TERMS_V1, "signup", null],
    ] as const) {
      const result = await authClient.query<{ result: string }>(
        "SELECT public.record_legal_acceptance($1, $2, $3, $4, $5, $6) AS result",
        [user, document, version, hash, origin, request]
      );
      assert.match(String(result.rows[0]?.result), INVALID_RESULT);
    }
    // the transaction is alive after twenty-three refusals, and a good write in it commits
    assert.equal(
      await auth.record(userB, "terms", 1, TERMS_V1, "signup", freshRequest()),
      "recorded"
    );
    await authClient.query("COMMIT");
    assert.equal(
      await countOf(ownerClient, userB),
      rowsBefore + 1,
      "the refusals wrote nothing, the one good write stayed"
    );
    tests.push(
      "record_legal_acceptance answers invalid_user, invalid_document, invalid_version, invalid_hash, invalid_origin or invalid_request for twenty-three bad inputs (nulls, an uppercase hash, a version above the cap of 1000, a request ID or user that is an IPv4 or IPv6 address) without raising: the caller's transaction stays alive and its good write in the same transaction commits; a refusal writes no row"
    );

    // ---- 8 requests at once for the same acceptance: one row
    const connections = [authClient];
    for (let index = 1; index < 8; index += 1) {
      connections.push(await connectAuth());
    }
    const userBurst = freshUser("burst");
    const burst = await Promise.all(
      connections.map((connection, index) =>
        acceptanceCalls(connection).record(
          userBurst,
          "privacy",
          1,
          PRIVACY_V1,
          "reaceite",
          `${freshRequest()}-${index}`
        )
      )
    );
    assert.equal(burst.filter((answer) => answer === "recorded").length, 1);
    assert.equal(
      burst.filter((answer) => answer === "already_accepted").length,
      7
    );
    assert.equal(await countOf(ownerClient, userBurst), 1);
    tests.push(
      "8 parallel requests for the same acceptance write exactly one row: one `recorded`, seven `already_accepted`"
    );

    // ---- the minimum version
    const userVersions = freshUser("versions");
    const userSilent = freshUser("silent");
    await probeHighestVersion(auth, userVersions, userSilent, freshRequest());
    const accepted = await auth.versions(userVersions);
    assert.deepEqual(
      pendingDocuments({ privacy: 1, terms: 3 }, accepted),
      [],
      "the highest versions meet the minimums"
    );
    assert.deepEqual(
      pendingDocuments({ privacy: 2, terms: 3 }, accepted),
      ["privacy"],
      "raising the minimum of one document makes only that one pending"
    );
    assert.deepEqual(pendingDocuments({ privacy: 1, terms: 4 }, accepted), [
      "terms",
    ]);
    assert.deepEqual(
      pendingDocuments(
        { privacy: 1, terms: 1 },
        await auth.versions(userSilent)
      ),
      ["privacy", "terms"],
      "a user who accepted nothing has everything pending"
    );
    assert.equal(
      await auth.record(
        userVersions,
        "privacy",
        2,
        sha256Of("privacidade v2"),
        "reaceite",
        freshRequest()
      ),
      "recorded"
    );
    assert.deepEqual(
      pendingDocuments(
        { privacy: 2, terms: 3 },
        await auth.versions(userVersions)
      ),
      [],
      "accepting the new version meets the raised minimum"
    );
    const history = await ownerClient.query<{ version: number }>(
      `SELECT version FROM ${TABLE} WHERE user_id = $1 AND document = 'terms' ORDER BY version`,
      [userVersions]
    );
    assert.deepEqual(
      history.rows.map((entry) => entry.version),
      [1, 2, 3],
      "every version accepted stays as a row"
    );
    tests.push(
      "legal_acceptance_versions answers the highest version of each document (an older one accepted later never lowers it, and every version stays as a row); a version below the minimum is pending, raising the minimum of one document makes only that one pending, a user with no acceptance has everything pending, and accepting the new version meets the raised minimum"
    );

    // ---- the isolation by user
    assert.deepEqual(await auth.versions(userA), [
      { document: "terms", version: 1 },
    ]);
    assert.deepEqual(await auth.versions(userB), [
      { document: "terms", version: 1 },
    ]);
    assert.deepEqual(await auth.versions(userBurst), [
      { document: "privacy", version: 1 },
    ]);
    assert.deepEqual(await auth.versions(freshUser("nobody")), []);
    for (const invalid of ["", "x y", "203.0.113.9", "a".repeat(65)]) {
      await expectSqlState(
        () => auth.versions(invalid),
        "22023",
        `versions refuses ${invalid.slice(0, 12)}`
      );
    }
    await expectSqlState(
      () =>
        authClient.query("SELECT public.legal_acceptance_versions(NULL::text)"),
      "22023",
      "versions refuses NULL"
    );
    const attempts: [string, Client][] = [
      ["auth", authClient],
      ["tenant", tenantClient],
      ["admin", adminClient],
    ];
    for (const [label, client] of attempts) {
      for (const statement of [
        `SELECT 1 FROM ${TABLE}`,
        `INSERT INTO ${TABLE} (user_id, document, version, text_sha256, origin, request_id) VALUES ('${userA}', 'terms', 9, '${TERMS_V1}', 'signup', 'x')`,
        `UPDATE ${TABLE} SET origin = 'signup'`,
        `DELETE FROM ${TABLE}`,
        `TRUNCATE ${TABLE}`,
      ]) {
        await expectSqlState(
          () => client.query(statement),
          "42501",
          `${label}: ${statement.slice(0, 40)}`
        );
      }
    }
    for (const [label, client] of attempts.slice(1)) {
      await expectSqlState(
        () => acceptanceCalls(client).versions(userA),
        "42501",
        `${label} cannot call versions`
      );
      await expectSqlState(
        () =>
          acceptanceCalls(client).record(
            userA,
            "terms",
            1,
            TERMS_V1,
            "signup",
            "x"
          ),
        "42501",
        `${label} cannot call record`
      );
    }
    // a user context in the session (what the tenant runtime sets) changes nothing for the authentication runtime
    await authClient.query("SELECT set_config('app.user_id', $1, false)", [
      userA,
    ]);
    assert.deepEqual(await auth.versions(userB), [
      { document: "terms", version: 1 },
    ]);
    await expectSqlState(
      () => authClient.query(`SELECT 1 FROM ${TABLE}`),
      "42501",
      "a user context does not open the table"
    );
    await authClient.query("RESET app.user_id");
    tests.push(
      "isolation by user: each user's versions are only their own (another user, a stranger and a user with nothing see nobody else's rows), a user ID that is not of the Better Auth shape raises 22023, and the authentication, tenant and Admin runtimes are refused (42501) on every statement on the table, and the tenant and Admin runtimes also on both functions; a user context in the session changes nothing"
    );

    // ---- append-only
    const rowsStay = await ownerClient.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${TABLE}`
    );
    for (const [name, text] of [
      ["UPDATE", `UPDATE ${TABLE} SET origin = 'reaceite'`],
      ["DELETE", `DELETE FROM ${TABLE}`],
      ["TRUNCATE", `TRUNCATE ${TABLE}`],
    ] as const) {
      await expectSqlState(
        () => owner.pool.query(text),
        "23514",
        `the owner of the table cannot ${name}: the trigger refuses it`
      );
    }
    await expectSqlState(
      () =>
        owner.pool.query(
          `UPDATE ${TABLE} SET accepted_at = now() - interval '1 year' WHERE user_id = $1`,
          [userA]
        ),
      "23514",
      "the instant cannot be moved"
    );
    for (const [name, text] of [
      ["UPDATE", `UPDATE ${TABLE} SET origin = 'reaceite'`],
      ["DELETE", `DELETE FROM ${TABLE}`],
      ["TRUNCATE", `TRUNCATE ${TABLE}`],
    ] as const) {
      await expectSqlState(
        () => ownerClient.query(text),
        "42501",
        `polaris_legal_acceptance_owner has no ${name} privilege`
      );
    }
    assert.equal(
      (
        await ownerClient.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${TABLE}`
        )
      ).rows[0]?.count,
      rowsStay.rows[0]?.count,
      "the row count never moved"
    );
    const triggers = (
      await owner.pool.query<{ tgenabled: string; tgname: string }>(
        "SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal ORDER BY tgname",
        [TABLE]
      )
    ).rows;
    assert.deepEqual(triggers, [
      { tgenabled: "A", tgname: "legal_acceptance_no_change" },
      { tgenabled: "A", tgname: "legal_acceptance_no_truncate" },
    ]);
    // the constraints hold for a direct insert too (by the owner role, the only one that can insert)
    type DirectInsert = [string, string, number, string, string, string];
    const direct = (values: DirectInsert) =>
      ownerClient.query(
        `INSERT INTO ${TABLE} (user_id, document, version, text_sha256, origin, request_id) VALUES ($1, $2, $3, $4, $5, $6)`,
        values
      );
    const checks: [string, DirectInsert][] = [
      [
        "legal_acceptance_user_format",
        ["has space", "terms", 1, TERMS_V1, "signup", "x"],
      ],
      [
        "legal_acceptance_document_allowed",
        [userA, "cookies", 1, TERMS_V1, "signup", "x"],
      ],
      [
        "legal_acceptance_version_range",
        [userA, "terms", 0, TERMS_V1, "signup", "x"],
      ],
      [
        "legal_acceptance_version_range",
        [userA, "terms", 1001, TERMS_V1, "signup", "x"],
      ],
      [
        "legal_acceptance_sha256_format",
        [userA, "terms", 5, "not-a-hash", "signup", "x"],
      ],
      [
        "legal_acceptance_origin_allowed",
        [userA, "terms", 5, TERMS_V1, "other", "x"],
      ],
      [
        "legal_acceptance_request_format",
        [userA, "terms", 5, TERMS_V1, "signup", "203.0.113.9"],
      ],
    ];
    for (const [constraint, args] of checks) {
      await expectSqlState(
        () => direct(args),
        "23514",
        `the CHECK ${constraint} holds for a direct insert`,
        constraint
      );
    }
    await expectSqlState(
      () => direct([userA, "terms", 1, TERMS_V1, "signup", "x"]),
      "23505",
      "one row for each user, document and version",
      "legal_acceptance_user_document_version_key"
    );
    tests.push(
      "append-only: UPDATE, DELETE and TRUNCATE are refused by the trigger even for the owner of the table (23514, the instant cannot be moved either), the owner role has no such privilege (42501), the row count never moved, both triggers are enabled ALWAYS (`tgenabled = 'A'`, so they also fire under session_replication_role = replica); the CHECKs on user, document, version (1 to 1000), hash, origin and request ID and the UNIQUE of user, document and version hold for a direct insert"
    );

    // ---- no IP anywhere in what is stored
    const dump = await ownerClient.query<{ text: string }>(
      `SELECT to_jsonb(accepted)::text AS text FROM ${TABLE} AS accepted WHERE accepted.user_id LIKE $1`,
      [`gate-legal-%-${suffix}`]
    );
    assert.ok(dump.rows.length >= 8);
    for (const entry of dump.rows) {
      const stored = JSON.parse(entry.text) as Record<string, unknown>;
      assert.deepEqual(Object.keys(stored).sort(), COLUMNS);
      assert.doesNotMatch(
        String(stored.request_id) + String(stored.user_id),
        IP_IN_TEXT,
        "no IP in a stored identifier"
      );
    }
    tests.push(
      "no IP is recorded by the database: there is no column, argument or type for one, and an address written the usual way (with dots or colons) is refused in the user and request ID, the only free-form fields; keeping the request ID opaque is the caller's part (P7)"
    );

    // ---- the gate fails on a mutation of a function or of the trigger
    const mutationClient = await owner.pool.connect();
    const mutants: [string, string, string, string][] = [
      [
        "versions takes the lowest version",
        FUNCTIONS.versions,
        "pg_catalog.max(accepted.version)",
        "pg_catalog.min(accepted.version)",
      ],
      [
        "versions forgets the user",
        FUNCTIONS.versions,
        "WHERE accepted.user_id = p_user",
        "WHERE accepted.user_id IS NOT NULL",
      ],
      [
        "record does not recognize a repeat",
        FUNCTIONS.record,
        "RETURN 'already_accepted';",
        "RETURN 'recorded';",
      ],
      [
        "record confirms another text under the same version",
        FUNCTIONS.record,
        "IF stored_sha256 IS DISTINCT FROM p_sha256 THEN",
        "IF false THEN",
      ],
      [
        "record accepts any request ID, an IP among them",
        FUNCTIONS.record,
        "p_request !~ '^[A-Za-z0-9_-]{1,64}$'",
        "false",
      ],
      [
        "the trigger lets a row go",
        TRIGGER_FUNCTION,
        "RAISE EXCEPTION 'the record of legal acceptance is append-only'\n    USING ERRCODE = '23514';",
        "RETURN OLD;",
      ],
    ];
    const probes: ((calls: Calls, user: string) => Promise<void>)[] = [
      (calls, user) =>
        probeHighestVersion(calls, user, `${user}-x`, freshRequest()),
      async (calls, user) => {
        const other = `${user}-o`;
        await calls.record(
          other,
          "terms",
          1,
          TERMS_V1,
          "signup",
          freshRequest()
        );
        assert.deepEqual(await calls.versions(user), []);
        await calls.record(
          user,
          "terms",
          1,
          TERMS_V1,
          "signup",
          freshRequest()
        );
        assert.deepEqual(await calls.versions(`${user}-z`), []);
      },
      (calls, user) =>
        probeIdempotent(calls, mutationClient, user, freshRequest()),
      (calls, user) =>
        probeIdempotent(calls, mutationClient, user, freshRequest()),
      async (calls, user) => {
        assert.equal(
          await calls.record(
            user,
            "terms",
            1,
            TERMS_V1,
            "signup",
            "203.0.113.9"
          ),
          "invalid_request"
        );
      },
      async (_calls, user) => {
        await mutationClient.query(
          `INSERT INTO ${TABLE} (user_id, document, version, text_sha256, origin, request_id) VALUES ($1, 'terms', 1, $2, 'signup', 'x')`,
          [user, TERMS_V1]
        );
        await probeRowsStay(mutationClient, user);
      },
    ];
    try {
      for (const [index, [label, signature, from, to]] of mutants.entries()) {
        const original = await definitionOf(mutationClient, signature);
        assert.ok(
          original.includes(from),
          `${label}: the text to mutate exists`
        );
        const mutated = original.replace(from, to);
        assert.notEqual(mutated, original);
        const probe = probes[index];
        assert.ok(probe);
        await mutationClient.query("BEGIN");
        try {
          await replaceFunctionAsOwner(mutationClient, signature, mutated);
          // the mutant is called by the authentication runtime, as in production; the probe reads and writes the table
          // on the gate's own connection, which owns it and bypasses RLS, so the rows are visible
          await assert.rejects(
            () =>
              probe(
                acceptanceCalls(mutationClient, (work) =>
                  withGateRole(mutationClient, "polaris_auth_runtime", work)
                ),
                freshUser(`mutant-${index}`)
              ),
            // an assertion of the probe failed, or the table's own check refused the row (the request ID that is an IP);
            // never a refusal of the setup (withGateRole's errors carry no SQLSTATE) or of a privilege
            (error: unknown) =>
              error instanceof assert.AssertionError ||
              sqlState(error) === "23514",
            `the probes catch the mutation: ${label}`
          );
        } finally {
          await mutationClient.query("ROLLBACK");
        }
        assert.equal(
          await definitionOf(mutationClient, signature),
          original,
          `${label}: the function is back to what the migration made`
        );
        if (signature !== TRIGGER_FUNCTION) {
          // and the real function still passes the same probe, on a fresh user, through the real runtime
          await probe(auth, freshUser(`real-${index}`));
        }
      }
    } finally {
      mutationClient.release();
    }
    tests.push(
      "the gate fails on a mutation: a versions that takes the lowest version or forgets the user, a record that does not recognize a repeat, confirms another text under the same version or accepts an IP as a request ID, and a trigger that lets a row go, each make the probes fail inside a transaction that is rolled back; the real functions pass the same probes afterwards, unchanged"
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
    // the rows of the run stay: the table only grows, and the database is disposable
    for (const [role, group] of logins) {
      for (const [label, text] of [
        ["revoke", `REVOKE "${group}" FROM "${role}"`],
        ["role", `DROP ROLE IF EXISTS "${role}"`],
      ] as const) {
        try {
          await owner.pool.query(text);
        } catch (error) {
          cleanupFailures.push(`${label} (${redactedFailure(error)})`);
        }
      }
    }
    await owner.pool.end();
    if (cleanupFailures.length > 0) {
      console.error(
        `Legal acceptance gate cleanup failed: ${cleanupFailures.join("; ")}`
      );
      if (!primaryFailure) {
        process.exitCode = 1;
      }
    }
  }
}

run().catch((error: unknown) => {
  console.error(
    `Legal acceptance PostgreSQL gate failed (${redactedFailure(error)}, ${sqlState(error) ?? "no sqlstate"})`
  );
  process.exitCode = 1;
});
