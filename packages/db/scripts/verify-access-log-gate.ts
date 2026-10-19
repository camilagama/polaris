// biome-ignore-all lint/performance/noAwaitInLoops: a gate runs its probes strictly one at a time, for a clear failure
import assert from "node:assert/strict";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { Client } from "pg";
import { createDatabase } from "../src/client";
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
 * The record of access to the application on a real PostgreSQL 18 (POL-80, ADR 0092): the append-only table
 * `auth_access_log`, the only two functions that touch it, and who can reach what. Nobody but
 * `polaris_access_log_owner` has a privilege on the table; the authentication runtime executes
 * `record_auth_access` (it answers a result code and never raises on a bad input, so a failed write cannot break a
 * login) and nothing else; the Admin runtime executes `admin_read_auth_access_log` (one user or one IP, a case number
 * in the CNJ format, a window of at most 31 days, a page of at most 50) and nothing else, and a read leaves one
 * audit row, without the IP, in its own transaction; no role updates, deletes or truncates a row, the owner of the
 * table included. The proof that a login goes on without the function lives in `access-log-login`.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const issuer = "https://polaris-access-log-gate.cloudflareaccess.com";
const REFERENCE = "1234567-42.2026.8.26.0100";
const TABLE = "public.auth_access_log";
const RECORD = "public.record_auth_access(text,text,inet,text)";
const READ =
  "public.admin_read_auth_access_log(uuid,text,text,inet,timestamp with time zone,timestamp with time zone,integer,uuid)";
const OWNER_ROLE = "polaris_access_log_owner";
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
const HOUR_MS = 3_600_000;
const AUDIT_DETAIL =
  /^filter=(user|ip); reference=1234567-42\.2026\.8\.26\.0100; rows=\d+$/;

interface ReadAnswer {
  entries?: {
    event: string;
    id: string;
    ip: string;
    occurredAt: string;
    requestId: string;
    userId: string | null;
  }[];
  next?: string | null;
  result: string;
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
  const principalIds: string[] = [];
  let revoked = false;
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
      const client = new Client({
        connectionString: temporaryRuntimeUrl(adminUrl, role, password),
        connectionTimeoutMillis: 5000,
      });
      await client.connect();
      closers.push(() => client.end());
      return client;
    };
    const authClient = await login("polaris_auth_runtime", "polaris_alog_auth");
    const adminClient = await login(
      "polaris_admin_runtime",
      "polaris_alog_admin"
    );
    const tenantClient = await login(runtimeRole, "polaris_alog_tenant");
    const ownerClient = await login(OWNER_ROLE, "polaris_alog_owner");

    // an address of the documentation range, new on every run: the table is append-only, so rows of earlier runs stay
    // four hex digits, the first never zero: PostgreSQL prints the address without leading zeros
    const block = randomInt(0x10_00, 0x1_00_00).toString(16);
    const ipOf = (n: number) => `2001:db8:${block}::${n}`;
    const userA = `gate-alog-a-${suffix}`;
    const userB = `gate-alog-b-${suffix}`;
    const request = (n: number) => `gate-alog-${suffix}-${n}`;

    const principal = async (status = "active") => {
      const id = (
        await owner.pool.query<{ id: string }>(
          "INSERT INTO public.platform_principals (issuer, subject, role, status) VALUES ($1, $2, 'platform_owner', $3) RETURNING id",
          [issuer, `sub-${randomUUID()}`, status]
        )
      ).rows[0]?.id as string;
      principalIds.push(id);
      return id;
    };
    const operator = await principal();
    const disabled = await principal("disabled");

    const record = async (
      event: string,
      user: string | null,
      ip: string | null,
      requestId: string | null
    ) =>
      (
        await authClient.query<{ result: string }>(
          "SELECT public.record_auth_access($1, $2, $3, $4) AS result",
          [event, user, ip, requestId]
        )
      ).rows[0]?.result;
    const read = async (
      client: Client,
      principalId: string | null,
      options: {
        after?: string | null;
        from?: Date;
        ip?: string | null;
        limit?: number;
        reference?: string | null;
        to?: Date;
        user?: string | null;
      }
    ) => {
      const now = Date.now();
      return (
        await client.query<{ result: ReadAnswer }>(
          "SELECT public.admin_read_auth_access_log($1::uuid, $2::text, $3::text, $4::inet, $5::timestamptz, $6::timestamptz, $7::integer, $8::uuid) AS result",
          [
            principalId,
            options.reference === undefined ? REFERENCE : options.reference,
            options.user ?? null,
            options.ip ?? null,
            (options.from ?? new Date(now - HOUR_MS)).toISOString(),
            (options.to ?? new Date(now + HOUR_MS)).toISOString(),
            options.limit ?? 10,
            options.after ?? null,
          ]
        )
      ).rows[0]?.result as ReadAnswer;
    };
    const auditRows = async () =>
      (
        await owner.pool.query<{
          detail: string | null;
          entity_id: string | null;
          entity_type: string | null;
          organization_id: string | null;
          principal_id: string;
          support_case_id: string | null;
        }>(
          "SELECT detail, entity_id, entity_type, organization_id, principal_id, support_case_id FROM public.platform_audit_events WHERE event_type = 'access_log.read' AND principal_id = ANY($1::uuid[]) ORDER BY id",
          [principalIds]
        )
      ).rows;
    const countOf = async (text: string, values: unknown[] = []) =>
      Number(
        (await owner.pool.query<{ count: string }>(text, values)).rows[0]?.count
      );

    // ------------------------------------------------------------- the role, the table
    const { rows: roleRows } = await owner.pool.query<{
      bypass: boolean;
      login: boolean;
      super: boolean;
    }>(
      "SELECT rolbypassrls AS bypass, rolcanlogin AS login, rolsuper AS super FROM pg_roles WHERE rolname = $1",
      [OWNER_ROLE]
    );
    assert.deepEqual(roleRows[0], {
      bypass: false,
      login: false,
      super: false,
    });
    const { rows: forcedRows } = await owner.pool.query<{
      force: boolean;
      rls: boolean;
    }>(
      "SELECT relrowsecurity AS rls, relforcerowsecurity AS force FROM pg_class WHERE oid = $1::regclass",
      [TABLE]
    );
    assert.deepEqual(forcedRows[0], { force: true, rls: true });
    const policies = await owner.pool.query<{
      cmd: string;
      policyname: string;
      roles: string[];
    }>(
      "SELECT policyname, cmd, roles::text[] AS roles FROM pg_policies WHERE schemaname = 'public' AND tablename = 'auth_access_log' ORDER BY policyname"
    );
    assert.deepEqual(
      policies.rows.map((row) => [row.policyname, row.cmd, row.roles]),
      [
        ["auth_access_log_owner_insert", "INSERT", [OWNER_ROLE]],
        ["auth_access_log_owner_select", "SELECT", [OWNER_ROLE]],
      ],
      "two policies, both for the owner: no UPDATE or DELETE policy, nothing for any runtime role"
    );
    tests.push(
      "polaris_access_log_owner is NOLOGIN, not superuser and without BYPASSRLS; the table enables and forces RLS; its only policies are INSERT and SELECT for that owner"
    );

    for (const role of [OWNER_ROLE, ...RUNTIME_ROLES]) {
      for (const privilege of PRIVILEGES) {
        const expected =
          role === OWNER_ROLE &&
          (privilege === "SELECT" || privilege === "INSERT");
        const {
          rows: [row],
        } = await owner.pool.query<{ allowed: boolean }>(
          "SELECT has_table_privilege($1, $2::regclass, $3) OR (($3 IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')) AND has_any_column_privilege($1, $2::regclass, $3)) AS allowed",
          [role, TABLE, privilege]
        );
        assert.equal(row?.allowed, expected, `${role} ${privilege}`);
      }
    }
    const acl = await owner.pool.query<{
      grantee: string;
      privileges: string[];
    }>(
      "SELECT pg_get_userbyid(acl.grantee) AS grantee, array_agg(acl.privilege_type ORDER BY acl.privilege_type) AS privileges FROM pg_class c, LATERAL aclexplode(c.relacl) acl WHERE c.oid = $1::regclass AND acl.grantee <> c.relowner GROUP BY 1 ORDER BY 1",
      [TABLE]
    );
    assert.deepEqual(
      acl.rows.map((row) => [row.grantee, row.privileges]),
      [[OWNER_ROLE, ["INSERT", "SELECT"]]],
      "the whole ACL is the owner's INSERT and SELECT: PUBLIC and every runtime role have nothing"
    );
    assert.equal(
      await countOf(
        "SELECT count(*)::text AS count FROM pg_attribute WHERE attrelid = $1::regclass AND attacl IS NOT NULL",
        [TABLE]
      ),
      0,
      "no column privilege"
    );
    const loginRoleReach = await owner.pool.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'auth_access_log'
          AND (has_table_privilege('polaris_auth_runtime', c.oid, 'SELECT,INSERT,UPDATE,DELETE')
               OR has_table_privilege('polaris_admin_runtime', c.oid, 'SELECT,INSERT,UPDATE,DELETE')
               OR has_table_privilege('public', c.oid, 'SELECT,INSERT,UPDATE,DELETE'))`
    );
    assert.deepEqual(loginRoleReach.rows, []);
    tests.push(
      "table privileges: only polaris_access_log_owner holds SELECT and INSERT (the whole ACL, no column ACL); no runtime, owner or PUBLIC role has any of the seven privileges, and nobody anywhere has UPDATE, DELETE or TRUNCATE"
    );

    for (const statement of [
      `SELECT 1 FROM ${TABLE}`,
      `INSERT INTO ${TABLE} (event, user_id, ip, request_id) VALUES ('logout', 'x', '203.0.113.1', 'x')`,
      `UPDATE ${TABLE} SET event = 'logout'`,
      `DELETE FROM ${TABLE}`,
    ]) {
      for (const [name, client] of [
        ["authentication", authClient],
        ["Admin", adminClient],
        ["tenant", tenantClient],
      ] as const) {
        await expectSqlState(
          () => client.query(statement),
          "42501",
          `the ${name} runtime, logged in, cannot: ${statement}`
        );
      }
    }
    // the tenant runtime with a user context sees nothing either: it is refused before any row
    await tenantClient.query("BEGIN");
    await tenantClient.query("SELECT set_config('app.user_id', $1, true)", [
      userA,
    ]);
    await expectSqlState(
      () => tenantClient.query(`SELECT * FROM ${TABLE}`),
      "42501",
      "a tenant runtime with app.user_id still has no access"
    );
    await tenantClient.query("ROLLBACK");
    tests.push(
      "no runtime reaches the table: the authentication, Admin and tenant runtimes, logged in, are refused SELECT, INSERT, UPDATE and DELETE (42501), and a tenant context (app.user_id) changes nothing"
    );

    // ------------------------------------------------------------- the functions
    const functionRows = await owner.pool.query<{
      definer: boolean;
      owner: string;
      proconfig: string[] | null;
      signature: string;
    }>(
      `SELECT p.oid::regprocedure::text AS signature, pg_get_userbyid(p.proowner) AS owner,
              p.prosecdef AS definer, p.proconfig
         FROM pg_proc p WHERE p.oid = ANY($1::regprocedure[]) ORDER BY 1`,
      [[RECORD, READ]]
    );
    assert.equal(functionRows.rows.length, 2);
    for (const row of functionRows.rows) {
      assert.equal(row.owner, OWNER_ROLE, row.signature);
      assert.equal(row.definer, true, row.signature);
      assert.deepEqual(
        row.proconfig,
        ["search_path=pg_catalog, public, pg_temp"],
        `${row.signature} fixes its search_path`
      );
    }
    const triggerFunction = await owner.pool.query<{
      proconfig: string[] | null;
    }>(
      "SELECT proconfig FROM pg_proc WHERE oid = 'public.auth_access_log_immutable()'::regprocedure"
    );
    assert.deepEqual(
      triggerFunction.rows[0]?.proconfig,
      ["search_path=pg_catalog, public, pg_temp"],
      "the trigger function fixes its search_path"
    );
    const allRoles = (
      await owner.pool.query<{ rolname: string }>(
        "SELECT rolname FROM pg_roles WHERE rolname LIKE 'polaris\\_%' AND rolname NOT LIKE 'polaris\\_gate\\_runner\\_%' AND rolname NOT LIKE 'polaris\\_alog\\_%' ORDER BY 1"
      )
    ).rows.map((row) => row.rolname);
    for (const [signature, allowed] of [
      [RECORD, ["polaris_auth_runtime", OWNER_ROLE]],
      [READ, ["polaris_admin_runtime", OWNER_ROLE]],
    ] as const) {
      const executing = (
        await owner.pool.query<{ rolname: string }>(
          "SELECT rolname FROM pg_roles WHERE has_function_privilege(rolname, $1::regprocedure, 'EXECUTE') AND (rolname LIKE 'polaris\\_%' AND rolname NOT LIKE 'polaris\\_gate\\_runner\\_%' AND rolname NOT LIKE 'polaris\\_alog\\_%') ORDER BY 1",
          [signature]
        )
      ).rows.map((row) => row.rolname);
      assert.deepEqual(executing, [...allowed].sort(), signature);
      assert.ok(allRoles.length > 5);
      const publicExecute = (
        await owner.pool.query<{ allowed: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_proc p, LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl WHERE p.oid = $1::regprocedure AND acl.grantee = 0) AS allowed",
          [signature]
        )
      ).rows[0]?.allowed;
      assert.equal(publicExecute, false, `${signature} is not open to PUBLIC`);
    }
    // the owner of the log may call exactly the two audit helpers of the Admin and nothing else of it
    const ownerAdminReach = (
      await owner.pool.query<{ signature: string }>(
        `SELECT p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname LIKE 'admin\\_%' AND pg_get_userbyid(p.proowner) = 'polaris_admin_owner'
            AND has_function_privilege($1, p.oid, 'EXECUTE') ORDER BY 1`,
        [OWNER_ROLE]
      )
    ).rows.map((row) => row.signature);
    assert.deepEqual(ownerAdminReach, [
      "admin_record_audit(uuid,text,text,uuid,text,text,text)",
      "admin_require_principal(uuid)",
    ]);
    const members = (
      await owner.pool.query<{ rolname: string }>(
        `SELECT rolname FROM pg_roles
          WHERE rolname LIKE 'polaris\\_%' AND rolname NOT LIKE 'polaris\\_alog\\_%'
            AND rolname NOT IN ('polaris_access_log_owner', 'polaris_admin_owner')
            AND (pg_has_role(rolname, 'polaris_access_log_owner', 'MEMBER') OR pg_has_role(rolname, 'polaris_admin_owner', 'MEMBER'))
          ORDER BY 1`
      )
    ).rows;
    assert.deepEqual(
      members,
      [],
      "no runtime role is a member, direct or through another role, of the owner of the log or of the Admin's owner"
    );
    assert.equal(
      (
        await owner.pool.query<{ member: boolean }>(
          "SELECT pg_has_role('polaris_admin_owner', 'polaris_access_log_owner', 'MEMBER') AS member"
        )
      ).rows[0]?.member,
      false
    );
    tests.push(
      "functions: both belong to polaris_access_log_owner, are SECURITY DEFINER with a fixed search_path and are not open to PUBLIC; record_auth_access is executed by polaris_auth_runtime alone and admin_read_auth_access_log by polaris_admin_runtime alone (of every polaris_ role); the owner of the log may call only the Admin's two audit helpers"
    );
    const auditCheck = (
      await owner.pool.query<{ definition: string }>(
        "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'platform_audit_events_type_allowed'"
      )
    ).rows[0]?.definition;
    assert.ok(auditCheck?.includes("'access_log.read'"));
    for (const kept of [
      "organization.purge_completed",
      "operational_incident.retry",
      "pii.revealed",
    ]) {
      assert.ok(auditCheck?.includes(`'${kept}'`), kept);
    }
    tests.push(
      "the audit CHECK accepts access_log.read and still every event it accepted before"
    );

    // ------------------------------------------------------------- writing
    const before = Date.now();
    assert.equal(
      await record("login_succeeded", userA, ipOf(1), request(1)),
      "recorded"
    );
    assert.equal(
      await record("session_refreshed", userA, ipOf(2), request(2)),
      "recorded"
    );
    assert.equal(
      await record("logout", userA, ipOf(2), request(3)),
      "recorded"
    );
    assert.equal(
      await record("login_failed", null, ipOf(3), request(4)),
      "recorded"
    );
    assert.equal(
      await record("login_succeeded", userB, "203.0.113.200", request(5)),
      "recorded"
    );
    const { rows } = await owner.pool.query<{
      event: string;
      ip: string;
      occurred_at: Date;
      request_id: string;
      user_id: string | null;
    }>(
      "SELECT event, host(ip) AS ip, occurred_at, request_id, user_id FROM public.auth_access_log WHERE request_id LIKE $1 ORDER BY id",
      [`gate-alog-${suffix}-%`]
    );
    assert.equal(rows.length, 5);
    assert.deepEqual(
      rows.map((row) => [row.event, row.user_id, row.ip]),
      [
        ["login_succeeded", userA, ipOf(1)],
        ["session_refreshed", userA, ipOf(2)],
        ["logout", userA, ipOf(2)],
        ["login_failed", null, ipOf(3)],
        ["login_succeeded", userB, "203.0.113.200"],
      ]
    );
    for (const row of rows) {
      const drift = Math.abs(row.occurred_at.getTime() - Date.now());
      assert.ok(drift < 60_000, "occurred_at is the database clock, now");
      assert.ok(row.occurred_at.getTime() >= before - 60_000);
    }
    const columns = (
      await owner.pool.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'auth_access_log' ORDER BY column_name"
      )
    ).rows.map((row) => row.column_name);
    assert.deepEqual(columns, [
      "event",
      "id",
      "ip",
      "occurred_at",
      "request_id",
      "user_id",
    ]);
    tests.push(
      "record_auth_access appends the four events with the database clock (the function has no parameter for the time), an IPv4 and an IPv6 address stay whole, and the table holds only event, id, ip, occurred_at, request_id and user_id: no user agent, e-mail, password, token or body, no organization"
    );

    // a bad input is a code, never an exception, and it does not abort the caller's transaction
    const refusals: [
      string,
      string | null,
      string | null,
      string | null,
      string,
    ][] = [
      ["unknown_event", userA, ipOf(9), request(9), "invalid_event"],
      ["", userA, ipOf(9), request(9), "invalid_event"],
      ["logout", null, ipOf(9), request(9), "invalid_user"],
      ["login_succeeded", null, ipOf(9), request(9), "invalid_user"],
      ["logout", "", ipOf(9), request(9), "invalid_user"],
      ["logout", "x".repeat(129), ipOf(9), request(9), "invalid_user"],
      ["logout", "bad\nuser", ipOf(9), request(9), "invalid_user"],
      ["logout", userA, null, request(9), "invalid_ip"],
      ["logout", userA, "203.0.113.0/24", request(9), "invalid_ip"],
      ["logout", userA, "2001:db8::/64", request(9), "invalid_ip"],
      ["logout", userA, ipOf(9), null, "invalid_request"],
      ["logout", userA, ipOf(9), "", "invalid_request"],
      ["logout", userA, ipOf(9), "has space", "invalid_request"],
      ["logout", userA, ipOf(9), "x".repeat(65), "invalid_request"],
      ["logout", userA, ipOf(9), "line\nbreak", "invalid_request"],
    ];
    const rowsBefore = await countOf(
      "SELECT count(*)::text AS count FROM public.auth_access_log WHERE request_id LIKE $1",
      [`gate-alog-${suffix}-%`]
    );
    await authClient.query("BEGIN");
    for (const [event, user, ip, requestId, code] of refusals) {
      assert.equal(
        await record(event, user, ip, requestId),
        code,
        `${event}/${user}/${ip}/${requestId}`
      );
    }
    // the transaction is alive after fifteen refusals, and a good write in it commits
    assert.equal(
      await record("logout", userB, ipOf(10), request(10)),
      "recorded"
    );
    await authClient.query("COMMIT");
    assert.equal(
      await countOf(
        "SELECT count(*)::text AS count FROM public.auth_access_log WHERE request_id LIKE $1",
        [`gate-alog-${suffix}-%`]
      ),
      rowsBefore + 1,
      "the refusals wrote nothing, the one good write stayed"
    );
    tests.push(
      "record_auth_access answers invalid_event, invalid_user, invalid_ip (null or a network mask) or invalid_request for fifteen bad inputs without raising: the caller's transaction stays alive and its good write in the same transaction commits; a refusal writes no row"
    );

    // ------------------------------------------------------------- append-only
    for (const [name, text] of [
      ["UPDATE", `UPDATE ${TABLE} SET event = 'logout'`],
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
      () => ownerClient.query(`UPDATE ${TABLE} SET event = 'logout'`),
      "42501",
      "polaris_access_log_owner has no UPDATE privilege"
    );
    await expectSqlState(
      () => ownerClient.query(`DELETE FROM ${TABLE}`),
      "42501",
      "polaris_access_log_owner has no DELETE privilege"
    );
    assert.equal(
      await countOf(
        "SELECT count(*)::text AS count FROM public.auth_access_log WHERE request_id LIKE $1",
        [`gate-alog-${suffix}-%`]
      ),
      rowsBefore + 1
    );
    const triggers = (
      await owner.pool.query<{ tgname: string; tgtype: number }>(
        "SELECT tgname, tgtype FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal ORDER BY tgname",
        [TABLE]
      )
    ).rows;
    assert.deepEqual(
      triggers.map((row) => row.tgname),
      ["auth_access_log_no_change", "auth_access_log_no_truncate"]
    );
    assert.deepEqual(
      (
        await owner.pool.query<{ tgenabled: string }>(
          "SELECT DISTINCT tgenabled FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal",
          [TABLE]
        )
      ).rows,
      [{ tgenabled: "A" }],
      "both triggers fire ALWAYS, also under session_replication_role = replica"
    );
    // a login role that is the owner of the log, through its own function, cannot bypass the trigger either
    await expectSqlState(
      () =>
        ownerClient.query(
          `INSERT INTO ${TABLE} (event, user_id, ip, request_id) VALUES ('nothing', 'x', '203.0.113.1', 'x')`
        ),
      "23514",
      "the CHECK of the event holds for a direct insert by the owner",
      "auth_access_log_event_allowed"
    );
    await expectSqlState(
      () =>
        ownerClient.query(
          `INSERT INTO ${TABLE} (event, user_id, ip, request_id) VALUES ('logout', NULL, '203.0.113.1', 'x')`
        ),
      "23514",
      "a null user is only for a failed login",
      "auth_access_log_user_required"
    );
    await expectSqlState(
      () =>
        ownerClient.query(
          `INSERT INTO ${TABLE} (event, user_id, ip, request_id) VALUES ('logout', 'x', '203.0.113.1', 'has space')`
        ),
      "23514",
      "the request ID has a format",
      "auth_access_log_request_format"
    );
    tests.push(
      "append-only: UPDATE, DELETE and TRUNCATE are refused by the trigger even for the owner of the table (23514), the log owner has no such privilege (42501), the row count never moved; the CHECKs on event, user and request ID hold for a direct insert"
    );

    // ------------------------------------------------------------- reading
    assert.equal(
      await countOf(
        "SELECT count(*)::text AS count FROM public.platform_audit_events WHERE event_type = 'access_log.read' AND principal_id = ANY($1::uuid[])",
        [principalIds]
      ),
      0
    );
    const first = await read(adminClient, operator, { user: userA });
    assert.equal(first.result, "ok");
    assert.deepEqual(
      first.entries?.map((entry) => [entry.event, entry.ip, entry.requestId]),
      [
        ["login_succeeded", ipOf(1), request(1)],
        ["session_refreshed", ipOf(2), request(2)],
        ["logout", ipOf(2), request(3)],
      ],
      "a user's accesses, oldest first, with the whole IP and the request ID"
    );
    assert.equal(first.next, null);
    for (const entry of first.entries ?? []) {
      assert.deepEqual(Object.keys(entry).sort(), [
        "event",
        "id",
        "ip",
        "occurredAt",
        "requestId",
        "userId",
      ]);
      assert.equal(entry.userId, userA);
    }
    const byIp = await read(adminClient, operator, { ip: ipOf(2) });
    assert.equal(byIp.result, "ok");
    assert.deepEqual(
      byIp.entries?.map((entry) => entry.event),
      ["session_refreshed", "logout"],
      "an IP's accesses: exact match, not the network"
    );
    const failedOnes = await read(adminClient, operator, { ip: ipOf(3) });
    assert.deepEqual(
      failedOnes.entries?.map((entry) => [entry.event, entry.userId]),
      [["login_failed", null]]
    );
    const emptyRead = await read(adminClient, operator, {
      user: `nobody-${suffix}`,
    });
    assert.deepEqual(emptyRead, { entries: [], next: null, result: "ok" });
    tests.push(
      "admin_read_auth_access_log answers a user's accesses and an IP's accesses (exact address, oldest first, whole IP and request ID, the failed login with no user) and an empty page for nobody"
    );

    // paging
    for (let n = 0; n < 4; n += 1) {
      await record("session_refreshed", userB, ipOf(20 + n), request(20 + n));
    }
    const page1 = await read(adminClient, operator, { limit: 2, user: userB });
    assert.equal(page1.entries?.length, 2);
    assert.ok(page1.next);
    const page2 = await read(adminClient, operator, {
      after: page1.next,
      limit: 2,
      user: userB,
    });
    assert.equal(page2.entries?.length, 2);
    assert.ok(page2.next);
    const page3 = await read(adminClient, operator, {
      after: page2.next,
      limit: 2,
      user: userB,
    });
    const allIds = [page1, page2, page3].flatMap(
      (page) => page.entries?.map((entry) => entry.id) ?? []
    );
    // userB has the login of the writing test, the logout of the refusal test and four refreshes
    assert.equal(allIds.length, 6);
    assert.equal(new Set(allIds).size, 6, "no row twice across the pages");
    assert.equal(page3.next, null);
    const times = [page1, page2, page3].flatMap(
      (page) => page.entries?.map((entry) => entry.occurredAt) ?? []
    );
    assert.deepEqual([...times].sort(), times, "oldest first across pages");
    tests.push(
      "paging: a page of 2 over 6 rows gives three pages with a cursor, no row twice, oldest first, the last page has no cursor"
    );

    // refusals: a code, nothing audited
    const auditBeforeRefusals = (await auditRows()).length;
    const t0 = Date.now();
    const window = (from: number, to: number) => ({
      from: new Date(t0 + from),
      to: new Date(t0 + to),
    });
    const refused: [string, () => Promise<ReadAnswer>][] = [
      [
        "invalid_reference",
        () => read(adminClient, operator, { reference: null, user: userA }),
      ],
      [
        "invalid_reference",
        () =>
          read(adminClient, operator, {
            reference: "ordem do juiz",
            user: userA,
          }),
      ],
      [
        "invalid_reference",
        () =>
          read(adminClient, operator, {
            reference: "1234567-42.2026.8.26.010",
            user: userA,
          }),
      ],
      [
        "invalid_reference",
        () =>
          read(adminClient, operator, {
            reference: `${REFERENCE}\n`,
            user: userA,
          }),
      ],
      [
        "invalid_reference",
        () =>
          read(adminClient, operator, {
            reference: ` ${REFERENCE}`,
            user: userA,
          }),
      ],
      ["invalid_filter", () => read(adminClient, operator, {})],
      [
        "invalid_filter",
        () => read(adminClient, operator, { ip: ipOf(1), user: userA }),
      ],
      ["invalid_filter", () => read(adminClient, operator, { user: "" })],
      // the user ID reaches the audit as the entity: only the shape of a Better Auth ID, never an IP, e-mail or document
      [
        "invalid_filter",
        () => read(adminClient, operator, { user: "203.0.113.5" }),
      ],
      [
        "invalid_filter",
        () => read(adminClient, operator, { user: "ana@example.invalid" }),
      ],
      [
        "invalid_filter",
        () => read(adminClient, operator, { user: "123.456.789-09" }),
      ],
      [
        "invalid_reference",
        () =>
          read(adminClient, operator, {
            reference: "1234567-89.2026.8.26.0100",
            user: userA,
          }),
      ],
      [
        "invalid_filter",
        () => read(adminClient, operator, { user: "x".repeat(129) }),
      ],
      [
        "invalid_filter",
        () => read(adminClient, operator, { ip: "2001:db8::/32" }),
      ],
      [
        "invalid_window",
        () =>
          read(adminClient, operator, {
            ...window(HOUR_MS, -HOUR_MS),
            user: userA,
          }),
      ],
      [
        "invalid_window",
        () => read(adminClient, operator, { ...window(0, 0), user: userA }),
      ],
      [
        "invalid_window",
        () =>
          read(adminClient, operator, {
            ...window(-32 * 24 * HOUR_MS, 0),
            user: userA,
          }),
      ],
      [
        "invalid_page",
        () => read(adminClient, operator, { limit: 0, user: userA }),
      ],
      [
        "invalid_page",
        () => read(adminClient, operator, { limit: 51, user: userA }),
      ],
      [
        "invalid_cursor",
        () => read(adminClient, operator, { after: randomUUID(), user: userA }),
      ],
    ];
    for (const [code, attempt] of refused) {
      assert.equal((await attempt()).result, code);
    }
    assert.equal(
      (await auditRows()).length,
      auditBeforeRefusals,
      "a refused read writes nothing to the audit"
    );
    // one clock reading: two readings a millisecond apart would make the window 31 days and 1 ms
    const edgeNow = Date.now();
    const edge = await read(adminClient, operator, {
      from: new Date(edgeNow - 31 * 24 * HOUR_MS + 60_000),
      limit: 50,
      to: new Date(edgeNow + 60_000),
      user: userA,
    });
    assert.equal(edge.result, "ok", "31 days and a page of 50 are allowed");
    tests.push(
      "refusals by result code with nothing audited: no case number, free text, a number one digit short, a trailing line break or space, wrong check digits; a user that is not the shape of an ID (an IP, an e-mail, a document number); no filter, two filters, an empty or over-long user, a network mask; a window backwards, empty or over 31 days; a page of 0 or 51; a cursor that is no row; the edges (31 days, 50 rows) pass"
    );

    // the operator
    for (const who of [disabled, randomUUID(), null]) {
      await expectSqlState(
        () => read(adminClient, who, { user: userA }),
        "42501",
        "an inactive, unknown or missing principal is refused"
      );
    }
    // the audit
    const audit = await auditRows();
    assert.equal(
      audit.length,
      auditBeforeRefusals + 1,
      "the one more successful read (the 31-day edge)"
    );
    const allAudit = audit;
    // user read, IP read, empty read, three pages, the edge
    assert.equal(allAudit.length, 8);
    for (const row of allAudit) {
      assert.equal(row.principal_id, operator);
      assert.equal(row.entity_type, "auth_access_log");
      assert.equal(row.organization_id, null);
      assert.equal(row.support_case_id, null);
      assert.match(row.detail ?? "", AUDIT_DETAIL);
      assert.equal(
        (row.detail ?? "").includes(`2001:db8:${block}`),
        false,
        "no IP in the audit"
      );
      assert.equal((row.detail ?? "").includes("203.0.113"), false);
    }
    const ipAudit = allAudit.filter((row) =>
      row.detail?.startsWith("filter=ip")
    );
    assert.equal(ipAudit.length, 2);
    for (const row of ipAudit) {
      assert.equal(
        row.entity_id,
        null,
        "an IP read has no entity: the IP never reaches the audit"
      );
    }
    const userAudit = allAudit.filter((row) =>
      row.detail?.startsWith("filter=user")
    );
    assert.ok(userAudit.some((row) => row.entity_id === userA));
    assert.ok(userAudit.some((row) => row.entity_id === userB));
    assert.ok(userAudit.some((row) => row.detail?.endsWith("rows=0")));
    assert.equal(
      (
        await owner.pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM public.platform_audit_events WHERE detail LIKE $1 OR entity_id LIKE $1",
          [`%2001:db8:${block}%`]
        )
      ).rows[0]?.count,
      "0",
      "the IP of the gate appears nowhere in the platform audit"
    );
    tests.push(
      "the operator must be an active principal (inactive, unknown and missing are refused with 42501); every successful read, the empty one and each page too, leaves one access_log.read audit row with the filter kind, the case number and the row count, the user ID as entity for a user filter, no entity for an IP filter, and no IP anywhere in the audit"
    );

    // same transaction: no audit, no read
    await owner.pool.query(`
      CREATE FUNCTION public.gate_alog_block_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_type = 'access_log.read' THEN
          RAISE EXCEPTION 'gate: audit blocked' USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END;
      $$`);
    await owner.pool.query(
      "CREATE TRIGGER gate_alog_block_audit BEFORE INSERT ON public.platform_audit_events FOR EACH ROW EXECUTE FUNCTION public.gate_alog_block_audit()"
    );
    try {
      await expectSqlState(
        () => read(adminClient, operator, { user: userA }),
        "P0001",
        "a failing audit fails the read: no answer without its record"
      );
    } finally {
      await owner.pool.query(
        "DROP TRIGGER IF EXISTS gate_alog_block_audit ON public.platform_audit_events"
      );
      await owner.pool.query(
        "DROP FUNCTION IF EXISTS public.gate_alog_block_audit()"
      );
    }
    // and a rolled-back read leaves no audit behind
    const auditBeforeRollback = (await auditRows()).length;
    await adminClient.query("BEGIN");
    assert.equal(
      (await read(adminClient, operator, { user: userA })).result,
      "ok"
    );
    await adminClient.query("ROLLBACK");
    assert.equal(
      (await auditRows()).length,
      auditBeforeRollback,
      "the audit rides the transaction of the read"
    );
    tests.push(
      "the audit is written in the transaction of the read: a trigger that refuses the audit row makes the read fail, and a read rolled back leaves no audit row"
    );

    // ------------------------------------------------------------- no cross use
    for (const [client, text, values] of [
      [
        adminClient,
        "SELECT public.record_auth_access('logout', 'x', '203.0.113.1', 'x')",
        [],
      ],
      [
        tenantClient,
        "SELECT public.record_auth_access('logout', 'x', '203.0.113.1', 'x')",
        [],
      ],
      [
        authClient,
        "SELECT public.admin_read_auth_access_log($1, $2, 'x', NULL, now() - interval '1 hour', now(), 1, NULL)",
        [operator, REFERENCE],
      ],
      [
        tenantClient,
        "SELECT public.admin_read_auth_access_log($1, $2, 'x', NULL, now() - interval '1 hour', now(), 1, NULL)",
        [operator, REFERENCE],
      ],
    ] as [Client, string, unknown[]][]) {
      await expectSqlState(
        () => client.query(text, values),
        "42501",
        `a role without the grant cannot call: ${text.slice(0, 48)}`
      );
    }
    tests.push(
      "no cross use: the Admin and tenant runtimes cannot execute record_auth_access, the authentication and tenant runtimes cannot execute admin_read_auth_access_log (42501)"
    );

    // ------------------------------------------------------------- a session seen from many IPs is bounded
    const userC = `gate-alog-c-${suffix}`;
    assert.equal(
      await record("session_refreshed", userC, ipOf(40), request(40)),
      "recorded"
    );
    assert.equal(
      await record("session_refreshed", userC, ipOf(40), request(41)),
      "duplicate",
      "the same user and IP within 10 minutes is one record"
    );
    for (let n = 1; n < 12; n += 1) {
      assert.equal(
        await record("session_refreshed", userC, ipOf(40 + n), request(40 + n)),
        "recorded"
      );
    }
    assert.equal(
      await record("session_refreshed", userC, ipOf(60), request(60)),
      "rate_limited",
      "the 13th change within the hour is counted, not written"
    );
    assert.equal(
      await record("session_refreshed", userC, ipOf(40), request(61)),
      "duplicate"
    );
    // a login is not throttled by it, and neither is another user
    assert.equal(
      await record("login_succeeded", userC, ipOf(61), request(62)),
      "recorded"
    );
    assert.equal(
      await record("session_refreshed", userA, ipOf(62), request(63)),
      "recorded"
    );
    assert.equal(
      await countOf(
        "SELECT count(*)::text AS count FROM public.auth_access_log WHERE user_id = $1 AND event = 'session_refreshed'",
        [userC]
      ),
      12,
      "twelve rows, however many requests came"
    );
    // the same request from several connections at once is one record: the lock serializes them
    const racers = [
      authClient,
      ...(await Promise.all(
        [1, 2, 3, 4].map((n) =>
          login("polaris_auth_runtime", `polaris_alog_r${n}`)
        )
      )),
    ];
    const userD = `gate-alog-d-${suffix}`;
    const raced = await Promise.all(
      racers.map(
        async (client, n) =>
          (
            await client.query<{ result: string }>(
              "SELECT public.record_auth_access('session_refreshed', $1, $2, $3) AS result",
              [userD, ipOf(70), request(70 + n)]
            )
          ).rows[0]?.result
      )
    );
    assert.equal(raced.filter((result) => result === "recorded").length, 1);
    assert.equal(raced.filter((result) => result === "duplicate").length, 4);
    tests.push(
      "a session seen from many IPs is bounded: the same user and IP within 10 minutes is one record (duplicate), a user has at most 12 session_refreshed an hour (the 13th is rate_limited and writes nothing), a login and another user are not throttled, and five connections racing on one user and IP leave exactly one row"
    );

    // ------------------------------------------------------------- the grant revoked
    await owner.pool.query(
      `REVOKE EXECUTE ON FUNCTION ${RECORD} FROM polaris_auth_runtime`
    );
    revoked = true;
    const rowsWhileRevoked = await countOf(
      "SELECT count(*)::text AS count FROM public.auth_access_log"
    );
    await expectSqlState(
      () => record("login_succeeded", userA, ipOf(30), request(30)),
      "42501",
      "with EXECUTE revoked the write fails with 42501, as a plain error the caller can catch"
    );
    // the caller's own work is untouched: a statement of the same connection still runs, and a transaction
    // that catches the failure under a savepoint goes on
    await authClient.query("BEGIN");
    await authClient.query("SAVEPOINT access_log_write");
    await expectSqlState(
      () => record("login_succeeded", userA, ipOf(31), request(31)),
      "42501",
      "the refusal inside a transaction"
    );
    await authClient.query("ROLLBACK TO SAVEPOINT access_log_write");
    assert.equal(
      (await authClient.query("SELECT 1 AS alive")).rows[0]?.alive,
      1
    );
    await authClient.query("COMMIT");
    assert.equal(
      await countOf(
        "SELECT count(*)::text AS count FROM public.auth_access_log"
      ),
      rowsWhileRevoked
    );
    await owner.pool.query(
      `GRANT EXECUTE ON FUNCTION ${RECORD} TO polaris_auth_runtime`
    );
    revoked = false;
    assert.equal(
      await record("login_succeeded", userA, ipOf(32), request(32)),
      "recorded"
    );
    tests.push(
      "with EXECUTE revoked on record_auth_access the write fails with 42501 and writes no row, the connection and a transaction (under a savepoint) stay alive; granting it back restores the write (the login that goes on without the function is proved by access-log-login)"
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
    if (revoked) {
      await cleanup(
        "restore execute",
        `GRANT EXECUTE ON FUNCTION ${RECORD} TO polaris_auth_runtime`
      );
    }
    await cleanup(
      "audit trigger",
      "DROP TRIGGER IF EXISTS gate_alog_block_audit ON public.platform_audit_events"
    );
    await cleanup(
      "audit trigger function",
      "DROP FUNCTION IF EXISTS public.gate_alog_block_audit()"
    );
    // the access log rows stay: the table is append-only for every role (a disposable database goes away whole)
    for (const [role, group] of logins) {
      await cleanup("revoke", `REVOKE "${group}" FROM "${role}"`);
      await cleanup("role", `DROP ROLE IF EXISTS "${role}"`);
    }
    await owner.pool.end();
    if (cleanupFailures.length > 0) {
      console.error(
        `Access log gate cleanup failed: ${cleanupFailures.join("; ")}`
      );
      if (!primaryFailure) {
        process.exitCode = 1;
      }
    }
  }
}

run().catch((error: unknown) => {
  console.error(
    `Access log PostgreSQL gate failed (${redactedFailure(error)}, ${sqlState(error) ?? "no sqlstate"})`
  );
  process.exitCode = 1;
});
