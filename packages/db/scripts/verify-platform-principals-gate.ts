import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { createDatabase } from "../src/client";
import {
  resolvePlatformPrincipal,
  withAdminDatabase,
} from "../src/platform-principal-repository";
import {
  createTenantFixture,
  disposableHostPattern,
  expectSqlState,
  gateBranchPattern,
  journalMigrationCount,
  poolerPattern,
  redactedFailure,
  requiredEnvironment,
  runtimeRole,
  temporaryRuntimeUrl,
  withRuntimeSqlContext,
} from "./sales-gate-support";

/**
 * The people who run Polaris, on a real PostgreSQL 18 (plan PR93, ADR 0070): a
 * principal is the Access issuer and subject (the e-mail is a label), the Admin
 * role can read principals and refresh the snapshot and the last-seen time but
 * cannot create or change one, holds no privilege on any tenant table, and no
 * tenant or billing role can read the principals.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const issuer = "https://polaris-gate.cloudflareaccess.com";

async function run() {
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, gateBranchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);

  const owner = createDatabase(adminUrl, { maxConnections: 2 });
  let loginRole: string | undefined;
  let tenantLogin: string | undefined;
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
      "disposable direct Neon connection is PostgreSQL 18 with every migration replayed from scratch"
    );

    loginRole = `polaris_admin_gate_${randomUUID().replaceAll("-", "")}`;
    tenantLogin = `polaris_admin_gate_rt_${randomUUID().replaceAll("-", "")}`;
    const loginPassword = randomBytes(24).toString("hex");
    const tenantPassword = randomBytes(24).toString("hex");
    await owner.pool.query(
      `CREATE ROLE "${loginRole}" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${loginPassword}'`
    );
    await owner.pool.query(`GRANT polaris_admin_runtime TO "${loginRole}"`);
    await owner.pool.query(
      `CREATE ROLE "${tenantLogin}" WITH LOGIN INHERIT PASSWORD '${tenantPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
    );
    await owner.pool.query(`GRANT "${runtimeRole}" TO "${tenantLogin}"`);
    const adminLoginUrl = temporaryRuntimeUrl(
      adminUrl,
      loginRole,
      loginPassword
    );
    const tenantUrl = temporaryRuntimeUrl(
      adminUrl,
      tenantLogin,
      tenantPassword
    );
    const asAdmin = async <T>(operation: (client: Client) => Promise<T>) => {
      const client = new Client({
        connectionString: adminLoginUrl,
        connectionTimeoutMillis: 5000,
      });
      await client.connect();
      try {
        return await operation(client);
      } finally {
        await client.end();
      }
    };

    const subject = `sub-${randomUUID()}`;
    const insert = (
      overrides: {
        issuer?: string;
        role?: string;
        status?: string;
        subject?: string;
      } = {}
    ) =>
      owner.pool.query(
        "INSERT INTO public.platform_principals (issuer, subject, role, status, email_snapshot) VALUES ($1, $2, $3, $4, 'first@example.com') RETURNING id",
        [
          overrides.issuer ?? issuer,
          overrides.subject ?? subject,
          overrides.role ?? "platform_owner",
          overrides.status ?? "active",
        ]
      );

    // ------------------------------------------------- 1. the table itself
    await insert();
    await expectSqlState(
      () => insert(),
      "23505",
      "one principal per issuer and subject",
      "platform_principals_identity_unique"
    );
    // the same subject under another issuer is another identity
    await insert({ issuer: "https://other-gate.cloudflareaccess.com" });
    for (const [label, overrides, constraint] of [
      [
        "an unknown role",
        { role: "admin", subject: "x1" },
        "platform_principals_role_allowed",
      ],
      [
        "an unknown status",
        { status: "gone", subject: "x2" },
        "platform_principals_status_allowed",
      ],
      [
        "an issuer that is not https",
        { issuer: "http://x", subject: "x3" },
        "platform_principals_issuer_allowed",
      ],
      [
        "an empty subject",
        { subject: "" },
        "platform_principals_subject_allowed",
      ],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: Four refusals, in order.
      await expectSqlState(() => insert(overrides), "23514", label, constraint);
    }
    const flags = await owner.pool.query<{
      forced: boolean;
      rls: boolean;
    }>(
      "SELECT relrowsecurity AS rls, relforcerowsecurity AS forced FROM pg_class WHERE oid = 'public.platform_principals'::regclass"
    );
    assert.deepEqual(flags.rows, [{ forced: true, rls: true }]);
    const policies = await owner.pool.query<{ cmd: string; roles: string }>(
      "SELECT cmd, roles FROM pg_policies WHERE tablename = 'platform_principals' ORDER BY cmd, roles"
    );
    // the Admin role reads and refreshes principals; the owner of the Admin's functions only reads who is active (ADR 0072)
    assert.deepEqual(policies.rows, [
      { cmd: "SELECT", roles: "{polaris_admin_owner}" },
      { cmd: "SELECT", roles: "{polaris_admin_runtime}" },
      { cmd: "UPDATE", roles: "{polaris_admin_runtime}" },
    ]);
    tests.push(
      "a principal is the issuer and subject (one per pair, the same subject under another issuer is another identity), with a known role and status, an https issuer and a subject; the table forces row security and only the Admin role and the owner of its functions have policies"
    );

    // ------------------------------------------------- 2. who can do what
    for (const statement of [
      "INSERT INTO public.platform_principals (issuer, subject, role) VALUES ('https://x', 'y', 'platform_owner')",
      "DELETE FROM public.platform_principals",
      "UPDATE public.platform_principals SET role = 'platform_owner'",
      "UPDATE public.platform_principals SET status = 'active'",
      "UPDATE public.platform_principals SET issuer = 'https://x'",
      "UPDATE public.platform_principals SET subject = 'x'",
      "TRUNCATE public.platform_principals",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Many probes, in order.
      await expectSqlState(
        () => asAdmin((client) => client.query(statement)),
        "42501",
        `the Admin role cannot: ${statement}`
      );
    }
    for (const table of [
      "organizations",
      "memberships",
      "products",
      "product_variants",
      "sales",
      "customers",
      "inventory_balances",
      "organization_billing",
      "entitlement_grants",
      "public_catalog_profiles",
      "tenant_audit_event",
      "media_assets",
      "expenses",
      '"user"',
      "session",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Many probes, in order.
      await expectSqlState(
        () =>
          asAdmin((client) => client.query(`SELECT 1 FROM public.${table}`)),
        "42501",
        `the Admin role cannot read ${table}`
      );
    }
    for (const statement of [
      "SELECT public.public_catalog_profile('x')",
      "SELECT public.organization_public_catalog_enabled('x')",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Two probes, in order.
      await expectSqlState(
        () => asAdmin((client) => client.query(statement)),
        "42501",
        `the Admin role cannot run: ${statement}`
      );
    }
    // the whole schema, not a list: no table, view or function beyond the principals is reachable
    const reach = await owner.pool.query<{ name: string; privilege: string }>(
      `SELECT c.relname AS name, 'table' AS privilege
         FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace
          AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
          AND c.relname <> 'platform_principals'
          AND (has_table_privilege('polaris_admin_runtime', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
               OR (c.relkind <> 'S' AND has_any_column_privilege('polaris_admin_runtime', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')))
        UNION ALL
       SELECT p.proname, 'function'
         FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname NOT IN (
            'admin_close_support_case', 'admin_grant_tenant_access', 'admin_list_support_cases', 'admin_open_support_case',
            'admin_organization_diagnostics', 'admin_organizations_overview', 'admin_reveal_customer_field',
            'admin_revoke_tenant_access', 'admin_support_case_detail', 'admin_tenant_customers'
          )
          AND has_function_privilege('polaris_admin_runtime', p.oid, 'EXECUTE')`
    );
    assert.deepEqual(
      reach.rows,
      [],
      "the Admin role reaches nothing else in the schema"
    );
    const columns = await owner.pool.query<{
      column_name: string;
      update_allowed: boolean;
    }>(
      `SELECT a.attname AS column_name,
              has_column_privilege('polaris_admin_runtime', a.attrelid, a.attnum, 'UPDATE') AS update_allowed
         FROM pg_attribute a
        WHERE a.attrelid = 'public.platform_principals'::regclass AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attname`
    );
    assert.deepEqual(
      columns.rows
        .filter((row) => row.update_allowed)
        .map((row) => row.column_name),
      ["email_snapshot", "last_seen_at", "updated_at"]
    );
    for (const column of ["id", "created_at", "issuer", "subject"]) {
      // biome-ignore lint/performance/noAwaitInLoops: Four probes, in order.
      await expectSqlState(
        () =>
          asAdmin((client) =>
            client.query(
              `UPDATE public.platform_principals SET ${column} = ${column}`
            )
          ),
        "42501",
        `the Admin role cannot change ${column}`
      );
    }
    const readable = await asAdmin((client) =>
      client.query(
        "SELECT count(*)::int AS count FROM public.platform_principals"
      )
    );
    assert.ok((readable.rows[0]?.count as number) >= 2);

    // no tenant role can read who the operators are
    const tenant = await createTenantFixture(
      owner.pool,
      "admin gate",
      "America/Sao_Paulo",
      "pro"
    );
    await expectSqlState(
      () =>
        withRuntimeSqlContext(tenantUrl, tenant, (client) =>
          client.query("SELECT 1 FROM public.platform_principals")
        ),
      "42501",
      "the tenant role cannot read the principals"
    );
    await expectSqlState(
      () =>
        withRuntimeSqlContext(tenantUrl, tenant, (client) =>
          client.query(
            "UPDATE public.platform_principals SET email_snapshot = 'x'"
          )
        ),
      "42501",
      "the tenant role cannot change the principals"
    );
    tests.push(
      "the Admin role reads the principals but cannot create, delete, truncate or change one's role, status, issuer or subject, reads no tenant or auth table and runs no tenant function; no tenant role can read or change the principals"
    );

    // ------------------------------------------------- 3. finding a principal
    const resolve = (identity: {
      email: string | null;
      issuer: string;
      subject: string;
    }) =>
      withAdminDatabase(adminLoginUrl, (client) =>
        resolvePlatformPrincipal(client, identity)
      );
    const stamps = async () =>
      (
        await owner.pool.query<{
          email_snapshot: string | null;
          last_seen_at: Date | null;
          updated_at: Date;
        }>(
          "SELECT email_snapshot, last_seen_at, updated_at FROM public.platform_principals WHERE issuer = $1 AND subject = $2",
          [issuer, subject]
        )
      ).rows[0];

    assert.equal(
      await resolve({ email: null, issuer, subject: "unknown" }),
      null,
      "an unknown subject is nobody"
    );
    assert.equal(
      await resolve({
        email: "first@example.com",
        issuer: "https://elsewhere.cloudflareaccess.com",
        subject,
      }),
      null,
      "the same subject under another issuer is nobody"
    );
    const found = await resolve({
      email: "renamed@example.com",
      issuer,
      subject,
    });
    assert.deepEqual(
      found && { emailSnapshot: found.emailSnapshot, role: found.role },
      { emailSnapshot: "renamed@example.com", role: "platform_owner" }
    );
    const first = await stamps();
    assert.ok(first?.last_seen_at, "the first sight is recorded");
    assert.equal(first?.email_snapshot, "renamed@example.com");

    // seen again at once with the same e-mail: nothing is written
    await resolve({ email: "renamed@example.com", issuer, subject });
    const second = await stamps();
    assert.equal(
      second?.updated_at.getTime(),
      first?.updated_at.getTime(),
      "a busy session does not write on every request"
    );
    // a new e-mail is a change worth writing, a missing one never erases the label
    await resolve({ email: "again@example.com", issuer, subject });
    assert.equal((await stamps())?.email_snapshot, "again@example.com");
    await resolve({ email: null, issuer, subject });
    assert.equal((await stamps())?.email_snapshot, "again@example.com");
    // an old sighting is refreshed
    await owner.pool.query(
      "UPDATE public.platform_principals SET last_seen_at = now() - interval '1 hour' WHERE issuer = $1 AND subject = $2",
      [issuer, subject]
    );
    await resolve({ email: "again@example.com", issuer, subject });
    const refreshed = await owner.pool.query<{ recent: boolean }>(
      "SELECT last_seen_at > now() - interval '1 minute' AS recent FROM public.platform_principals WHERE issuer = $1 AND subject = $2",
      [issuer, subject]
    );
    assert.equal(
      refreshed.rows[0]?.recent,
      true,
      "a stale sighting is refreshed"
    );
    // the e-mail is only a label: it never finds or grants anyone
    assert.equal(
      await resolve({
        email: "again@example.com",
        issuer,
        subject: "someone-else",
      }),
      null
    );
    // a disabled principal is nobody, whatever the login says
    await owner.pool.query(
      "UPDATE public.platform_principals SET status = 'disabled' WHERE issuer = $1 AND subject = $2",
      [issuer, subject]
    );
    assert.equal(
      await resolve({ email: "again@example.com", issuer, subject }),
      null
    );
    await owner.pool.query(
      "UPDATE public.platform_principals SET status = 'active' WHERE issuer = $1 AND subject = $2",
      [issuer, subject]
    );
    assert.ok(await resolve({ email: null, issuer, subject }));
    tests.push(
      "an operator is found by issuer and subject only (an unknown subject, the same subject under another issuer and a disabled principal are nobody); the e-mail snapshot follows the login but never finds anyone and is never erased by a missing e-mail; the last-seen time is refreshed at most every five minutes"
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
  } finally {
    for (const [role, group] of [
      [loginRole, "polaris_admin_runtime"],
      [tenantLogin, runtimeRole],
    ] as const) {
      if (role) {
        // biome-ignore lint/performance/noAwaitInLoops: Two cleanups, in order.
        await owner.pool.query(`REVOKE "${group}" FROM "${role}"`);
        await owner.pool.query(`DROP ROLE IF EXISTS "${role}"`);
      }
    }
    await owner.pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    `Platform principals PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
