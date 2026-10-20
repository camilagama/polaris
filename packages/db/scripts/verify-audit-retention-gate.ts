// biome-ignore-all lint/performance/noAwaitInLoops: a gate runs its probes strictly one at a time, for a clear failure
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { ORGANIZATION_PURGE_REQUIRED_SCOPE } from "@polaris/domain/privacy/organization-purge";
import { TENANT_AUDIT_RETENTION } from "@polaris/domain/privacy/retention";
import {
  TENANT_AUDIT_EVENT_TYPES,
  tenantAuditEventTypesOf,
} from "@polaris/domain/privacy/tenant-audit-events";
import type { PoolClient } from "pg";
import {
  closeSupportCase,
  openPrivacyCase,
  openSupportCase,
  placeOrganizationLegalHold,
  recordPrivacyDecision,
  recordPrivacyIdentity,
  recordPrivacyRole,
  recordPrivacyScope,
  releaseOrganizationLegalHold,
  scheduleOrganizationPurge,
} from "../src/admin-support-repository";
import { createDatabase } from "../src/client";
import { createCustomer } from "../src/customer-repository";
import { requestOrganizationClosure } from "../src/organization-closure-repository";
import { createPrivacyMaintenanceClient } from "../src/privacy-maintenance";
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
  type TenantFixture,
  temporaryRuntimeUrl,
  withTenantAs,
} from "./sales-gate-support";

/**
 * The audit of the tenant survives the purge, is immutable and leaves only by a period, on a real PostgreSQL 18
 * (ADR 0081, amended 19/10/2026). It proves: the foreign key to the organization restricts; the triggers of the three
 * audit tables (and the platform audit's) are ENABLE ALWAYS and refuse UPDATE, DELETE and TRUNCATE even under
 * `session_replication_role = replica`; the CHECK and the class of `event_type` are the domain's registry, and a type
 * outside it fails at the INSERT; the purge of an organization keeps every row of its audit; and the expiry removes only
 * the expired rows of each class, counted from the right moment, skips an organization under a legal hold, and is
 * reachable only through the function of the retention owner (which no role can execute until the job exists).
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const AUDIT = "public.tenant_audit_event";
const APPEND_ONLY = /append-only/;
const QUOTED = /'([^']+)'/g;
// the margin around the edge of a period: month arithmetic can move a day or two at the end of a month
const MARGIN = "3 days";
const SECURITY_MONTHS = TENANT_AUDIT_RETENTION.security.months;
const OPERATIONAL_MONTHS = TENANT_AUDIT_RETENTION.operational.months;

const quotedLiterals = (text: string) =>
  [...text.matchAll(QUOTED)].map((match) => match[1] ?? "");

const sameSet = (left: readonly string[], right: readonly string[]) =>
  assert.deepEqual([...left].sort(), [...right].sort());

interface Seeded {
  id: string;
  label: string;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one linear script of fixtures, probes and teardown, as the other gates
async function run() {
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, gateBranchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);

  const owner = createDatabase(adminUrl, { maxConnections: 4 });
  const logins: [string, string][] = [];
  const memberships: string[] = [];
  const tests: string[] = [];
  let runtime: ReturnType<typeof createDatabase> | undefined;
  let adminRuntime: ReturnType<typeof createDatabase> | undefined;
  let privacy: ReturnType<typeof createPrivacyMaintenanceClient> | undefined;
  let probeRole: string | undefined;

  const scalar = async <T>(text: string, values: unknown[] = []) =>
    (await owner.pool.query<{ value: T }>(text, values)).rows[0]?.value;

  /** One transaction as another role (the gate lets the owner `SET ROLE` to the NOLOGIN owners it tests). */
  async function asRole<T>(
    role: string,
    work: (client: PoolClient) => Promise<T>,
    options: { commit?: boolean } = {}
  ): Promise<T> {
    const client = await owner.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${role}`);
      const result = await work(client);
      await client.query(options.commit === false ? "ROLLBACK" : "COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** The statement runs in a transaction that always rolls back; the work returns what it saw. */
  async function rolledBack<T>(
    work: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await owner.pool.connect();
    try {
      await client.query("BEGIN");
      return await work(client);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  }

  try {
    const server = await owner.pool.query<{
      database_name: string;
      is_superuser: string;
      server_version: string;
      server_version_num: string;
    }>(
      "SELECT current_database() AS database_name, current_setting('server_version') AS server_version, current_setting('server_version_num') AS server_version_num, current_setting('is_superuser') AS is_superuser"
    );
    const [serverRow] = server.rows;
    assert.ok(serverRow);
    assert.equal(serverRow.database_name, expectedDatabase);
    assert.ok(Number(serverRow.server_version_num) >= 180_000);
    const isSuperuser = serverRow.is_superuser === "on";
    const migrations = await owner.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations"
    );
    assert.equal(Number(migrations.rows[0]?.count), journalMigrationCount());
    tests.push(
      "disposable direct connection is PostgreSQL 18 with every migration replayed from scratch"
    );

    // ---------------------------------------------------------------- catalog
    const fk = await owner.pool.query<{ confdeltype: string }>(
      `SELECT c.confdeltype FROM pg_catalog.pg_constraint AS c
        WHERE c.conrelid = 'public.tenant_audit_event'::regclass AND c.contype = 'f'
          AND c.confrelid = 'public.organizations'::regclass`
    );
    assert.deepEqual(
      fk.rows.map((row) => row.confdeltype),
      ["r"],
      "the foreign key of the audit to the organization is RESTRICT (confdeltype 'r')"
    );
    tests.push(
      "the foreign key of tenant_audit_event to the organization has confdeltype 'r' (RESTRICT)"
    );

    const immutableTables = [
      "tenant_audit_event",
      "auth_security_audit_event",
      "deletion_ledger",
      "platform_audit_events",
    ];
    const triggers = await owner.pool.query<{
      enabled: string;
      function_config: string[] | null;
      table_name: string;
      trigger_name: string;
      is_before_row_change: boolean;
      is_before_truncate: boolean;
    }>(
      `SELECT c.relname AS table_name, t.tgname AS trigger_name, t.tgenabled AS enabled,
              ((t.tgtype::int & 1) <> 0 AND (t.tgtype::int & 2) <> 0 AND (t.tgtype::int & 8) <> 0 AND (t.tgtype::int & 16) <> 0) AS is_before_row_change,
              ((t.tgtype::int & 1) = 0 AND (t.tgtype::int & 2) <> 0 AND (t.tgtype::int & 32) <> 0) AS is_before_truncate,
              p.proconfig AS function_config
         FROM pg_catalog.pg_trigger AS t
         JOIN pg_catalog.pg_class AS c ON c.oid = t.tgrelid
         JOIN pg_catalog.pg_proc AS p ON p.oid = t.tgfoid
        WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1::text[])
        ORDER BY 1, 2`,
      [immutableTables]
    );
    for (const table of immutableTables) {
      const own = triggers.rows.filter((row) => row.table_name === table);
      const change = own.filter(
        (row) => row.trigger_name === `${table}_no_change`
      );
      const truncate = own.filter(
        (row) => row.trigger_name === `${table}_no_truncate`
      );
      assert.equal(change.length, 1, `${table}: one trigger for UPDATE/DELETE`);
      assert.equal(truncate.length, 1, `${table}: one trigger for TRUNCATE`);
      const [changeRow] = change;
      const [truncateRow] = truncate;
      assert.ok(changeRow && truncateRow);
      // tgtype bits: 1 row, 2 before, 8 delete, 16 update, 32 truncate
      assert.equal(
        changeRow.is_before_row_change,
        true,
        `${table}: BEFORE UPDATE OR DELETE, per row`
      );
      assert.equal(
        truncateRow.is_before_truncate,
        true,
        `${table}: BEFORE TRUNCATE, per statement`
      );
      for (const row of own) {
        assert.equal(
          row.enabled,
          "A",
          `${table}: ${row.trigger_name} is ENABLE ALWAYS (tgenabled = 'A')`
        );
        const config = (row.function_config ?? []).find((entry) =>
          entry.startsWith("search_path=")
        );
        assert.ok(
          config?.endsWith("pg_temp"),
          `${table}: search_path has pg_temp`
        );
      }
    }
    tests.push(
      "the triggers of tenant_audit_event, auth_security_audit_event, deletion_ledger and platform_audit_events (UPDATE/DELETE and TRUNCATE) have tgenabled = 'A', and their functions fix a search_path that ends in pg_temp"
    );

    const functions = await owner.pool.query<{
      config: string[] | null;
      name: string;
      owner: string;
      secdef: boolean;
    }>(
      `SELECT p.proname AS name, p.prosecdef AS secdef, p.proconfig AS config, r.rolname AS owner
         FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_roles AS r ON r.oid = p.proowner
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname = ANY($1::text[])`,
      [
        [
          "audit_record_is_immutable",
          "tenant_audit_event_guard",
          "tenant_audit_event_expired",
          "expire_tenant_audit_events",
          "platform_audit_events_immutable",
          "purge_organization_data",
          "admin_schedule_organization_purge",
        ],
      ]
    );
    assert.equal(functions.rows.length, 7);
    for (const fn of functions.rows) {
      const path = (fn.config ?? []).find((entry) =>
        entry.startsWith("search_path=")
      );
      assert.ok(
        path?.endsWith("pg_temp"),
        `${fn.name}: pg_temp in search_path`
      );
    }
    const expire = functions.rows.find(
      (fn) => fn.name === "expire_tenant_audit_events"
    );
    assert.equal(expire?.owner, "polaris_retention_owner");
    assert.equal(expire?.secdef, true);
    tests.push(
      "every function of the audit triggers, the expiry and the two purge functions fixes a search_path with pg_temp; the expiry is SECURITY DEFINER, owned by polaris_retention_owner"
    );

    // the periods in the predicate are the proposed ones of the domain (`TENANT_AUDIT_RETENTION`)
    const predicate = await scalar<string>(
      "SELECT pg_get_functiondef('public.tenant_audit_event_expired(text, text, timestamp with time zone)'::regprocedure) AS value"
    );
    assert.ok(
      (predicate ?? "").includes(`interval '${SECURITY_MONTHS} months'`) &&
        (predicate ?? "").includes(`interval '${OPERATIONAL_MONTHS} months'`),
      "the periods of the predicate are those of TENANT_AUDIT_RETENTION"
    );

    // the role: never a login, no power, no member and no membership
    const role = await owner.pool.query<Record<string, unknown>>(
      `SELECT rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication, rolinherit
         FROM pg_catalog.pg_roles WHERE rolname = 'polaris_retention_owner'`
    );
    assert.deepEqual(role.rows[0], {
      rolbypassrls: false,
      rolcanlogin: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolinherit: false,
      rolreplication: false,
      rolsuper: false,
    });
    const links = await scalar<string>(
      `SELECT count(*)::text AS value FROM pg_catalog.pg_auth_members AS m
        WHERE m.member = 'polaris_retention_owner'::regrole
           OR (m.roleid = 'polaris_retention_owner'::regrole AND (m.set_option OR m.inherit_option))`
    );
    assert.equal(
      links,
      "0",
      "nobody is a member of the retention owner, and it is a member of nothing"
    );
    tests.push(
      "polaris_retention_owner is NOLOGIN without superuser, CREATEDB, CREATEROLE, REPLICATION, BYPASSRLS or INHERIT, with no member and no membership"
    );

    // EXECUTE: nobody (PUBLIC and every runtime) until the job exists
    const executors = await owner.pool.query<{ grantee: string }>(
      `SELECT r.rolname AS grantee FROM pg_catalog.pg_roles AS r
        WHERE r.rolname NOT LIKE 'pg\\_%' AND r.rolname <> 'polaris_retention_owner'
          AND r.rolname NOT IN (SELECT rolname FROM pg_catalog.pg_roles WHERE rolsuper)
          AND has_function_privilege(r.oid, 'public.expire_tenant_audit_events(integer)', 'EXECUTE')
        ORDER BY 1`
    );
    assert.deepEqual(
      executors.rows.map((row) => row.grantee),
      [],
      "no role but the owner executes the expiry"
    );
    const publicExecute = await scalar<boolean>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_catalog.pg_proc AS p, LATERAL pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS a
          WHERE p.proname = ANY($1::text[]) AND p.pronamespace = 'public'::regnamespace AND a.grantee = 0
       ) AS value`,
      [["expire_tenant_audit_events", "tenant_audit_event_expired"]]
    );
    assert.equal(
      publicExecute,
      false,
      "PUBLIC has no EXECUTE on the expiry or its predicate"
    );
    tests.push(
      "no role (PUBLIC included) can execute expire_tenant_audit_events: the job that will, gets it in its own migration"
    );

    // privileges: the purge owner has nothing on the audit; the retention owner reads four columns, deletes, and does nothing else
    for (const privilege of [
      "SELECT",
      "INSERT",
      "UPDATE",
      "DELETE",
      "TRUNCATE",
    ]) {
      assert.equal(
        await scalar<boolean>(
          "SELECT has_table_privilege('polaris_purge_owner', $1, $2) OR (CASE WHEN $2::text IN ('SELECT', 'INSERT', 'UPDATE') THEN has_any_column_privilege('polaris_purge_owner', $1, $2) ELSE false END) AS value",
          [AUDIT, privilege]
        ),
        false,
        `the purge owner has no ${privilege} on the audit`
      );
    }
    const purgePolicies = await scalar<string>(
      `SELECT count(*)::text AS value FROM pg_catalog.pg_policies
        WHERE schemaname = 'public' AND tablename = 'tenant_audit_event' AND 'polaris_purge_owner' = ANY(roles)`
    );
    assert.equal(
      purgePolicies,
      "0",
      "the purge owner has no policy on the audit"
    );
    const purgeDefinition = await scalar<string>(
      "SELECT pg_get_functiondef('public.purge_organization_data(text)'::regprocedure) AS value"
    );
    assert.ok(
      !(purgeDefinition ?? "").includes("tenant_audit_event"),
      "purge_organization_data does not mention the audit"
    );
    for (const [privilege, expected] of [
      ["DELETE", true],
      ["INSERT", false],
      ["UPDATE", false],
      ["TRUNCATE", false],
    ] as const) {
      assert.equal(
        await scalar<boolean>(
          "SELECT has_table_privilege('polaris_retention_owner', $1, $2) OR (CASE WHEN $2::text IN ('SELECT', 'INSERT', 'UPDATE') THEN has_any_column_privilege('polaris_retention_owner', $1, $2) ELSE false END) AS value",
          [AUDIT, privilege]
        ),
        expected,
        `the retention owner ${expected ? "has" : "has no"} ${privilege} on the audit`
      );
    }
    const readable = await owner.pool.query<{ attname: string }>(
      `SELECT a.attname FROM pg_catalog.pg_attribute AS a
        WHERE a.attrelid = 'public.tenant_audit_event'::regclass AND a.attnum > 0 AND NOT a.attisdropped
          AND has_column_privilege('polaris_retention_owner', a.attrelid, a.attnum, 'SELECT')
        ORDER BY 1`
    );
    sameSet(
      readable.rows.map((row) => row.attname),
      ["created_at", "event_class", "id", "organization_id"]
    );
    tests.push(
      "the purge owner has no privilege and no policy on the audit and the purge function does not mention it; the retention owner reads four columns and only deletes"
    );

    // ---------------------------------------------------- the CHECK is the domain
    const checkDefinition = await scalar<string>(
      `SELECT pg_get_constraintdef(c.oid) AS value FROM pg_catalog.pg_constraint AS c
        WHERE c.conrelid = 'public.tenant_audit_event'::regclass AND c.conname = 'tenant_audit_event_type_registered'`
    );
    assert.ok(checkDefinition, "the CHECK exists");
    sameSet(
      quotedLiterals(checkDefinition),
      Object.keys(TENANT_AUDIT_EVENT_TYPES)
    );
    const classExpression = await scalar<string>(
      `SELECT pg_get_expr(d.adbin, d.adrelid) AS value
         FROM pg_catalog.pg_attrdef AS d JOIN pg_catalog.pg_attribute AS a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
        WHERE d.adrelid = 'public.tenant_audit_event'::regclass AND a.attname = 'event_class'`
    );
    assert.ok(classExpression, "event_class is a generated column");
    sameSet(
      quotedLiterals(classExpression).filter(
        (value) => value !== "security" && value !== "operational"
      ),
      tenantAuditEventTypesOf("security")
    );
    tests.push(
      "the CHECK of event_type lists exactly the types of the domain registry, and the generated event_class lists exactly its security ones"
    );

    // ----------------------------------------------------------- fixtures
    const suffix = randomUUID().slice(0, 8);
    const principal = (
      await owner.pool.query<{ id: string }>(
        "INSERT INTO public.platform_principals (issuer, subject, role, status) VALUES ($1, $2, 'platform_owner', 'active') RETURNING id",
        ["https://audit-retention-gate.example", `audit-${randomUUID()}`]
      )
    ).rows[0]?.id;
    assert.ok(principal);

    const newLogin = async (group: string, prefix: string) => {
      const name = `${prefix}_${randomUUID().replaceAll("-", "")}`;
      const password = randomBytes(24).toString("hex");
      await owner.pool.query(
        `CREATE ROLE "${name}" WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`
      );
      await owner.pool.query(`GRANT "${group}" TO "${name}"`);
      logins.push([name, group]);
      return temporaryRuntimeUrl(adminUrl, name, password);
    };
    const tenantUrl = await newLogin(runtimeRole, "polaris_audit_tenant");
    const privacyUrl = await newLogin(
      "polaris_privacy_runtime",
      "polaris_audit_priv"
    );
    const adminRuntimeUrl = await newLogin(
      "polaris_admin_runtime",
      "polaris_audit_admin"
    );
    runtime = createDatabase(tenantUrl, { maxConnections: 2 });
    adminRuntime = createDatabase(adminRuntimeUrl, { maxConnections: 1 });
    privacy = createPrivacyMaintenanceClient(privacyUrl);
    const maintenance = privacy;
    const admin = adminRuntime.pool;
    const { db } = runtime;

    // the owner may become the NOLOGIN owners this gate tests (the migrations do the same); undone at the end
    for (const owned of [
      "polaris_privacy_owner",
      "polaris_admin_owner",
      "polaris_retention_owner",
    ]) {
      await owner.pool.query(
        `GRANT ${owned} TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE`
      );
      memberships.push(owned);
    }
    // a stand-in for the job that will call the expiry: a role with nothing but that EXECUTE
    probeRole = `polaris_audit_probe_${randomUUID().replaceAll("-", "")}`;
    await owner.pool.query(`CREATE ROLE "${probeRole}" NOLOGIN`);
    await owner.pool.query(
      `GRANT "${probeRole}" TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE`
    );
    const probe = probeRole;
    await asRole("polaris_retention_owner", (client) =>
      client.query(
        `GRANT EXECUTE ON FUNCTION public.expire_tenant_audit_events(integer) TO "${probe}"`
      )
    );

    // a paid organization cannot be purged while its access runs: E is on the Free plan
    const org = (label: string) =>
      createTenantFixture(
        owner.pool,
        `audit ${label} ${suffix}`,
        "America/Sao_Paulo",
        label === "E" ? "free" : "pro"
      );
    const [orgA, orgB, orgC, orgD, orgE, orgF] = (await Promise.all(
      ["A", "B", "C", "D", "E", "F"].map(org)
    )) as [
      TenantFixture,
      TenantFixture,
      TenantFixture,
      TenantFixture,
      TenantFixture,
      TenantFixture,
    ];

    /** Audit rows, written as the owner of the privacy functions (the tenant runtime can also write `created_at` today: a pending follow-up, ADR 0081). */
    async function seed(
      tenant: TenantFixture,
      rows: { age: string; type: string; label: string }[]
    ): Promise<Seeded[]> {
      return await asRole("polaris_privacy_owner", async (client) => {
        const seeded: Seeded[] = [];
        for (const row of rows) {
          const id = randomUUID();
          await client.query(
            `INSERT INTO ${AUDIT} (id, organization_id, actor_user_id, entity_type, entity_id, event_type, created_at)
             VALUES ($1, $2, $3, 'organization', $4, $5, now() - $6::interval)`,
            [
              id,
              tenant.organizationId,
              tenant.userId,
              randomUUID(),
              row.type,
              row.age,
            ]
          );
          seeded.push({ id, label: row.label });
        }
        return seeded;
      });
    }
    const present = async (ids: string[]) =>
      (
        await owner.pool.query<{ id: string }>(
          `SELECT id FROM ${AUDIT} WHERE id = ANY($1::uuid[])`,
          [ids]
        )
      ).rows.map((row) => row.id);
    const survivors = async (rows: Seeded[]) => {
      const alive = new Set(await present(rows.map((row) => row.id)));
      return rows
        .filter((row) => alive.has(row.id))
        .map((row) => row.label)
        .sort();
    };
    const expireRows = async (limit = 10_000) =>
      await asRole(probe, async (client) => {
        const result = await client.query<{
          expired: { operational: number; security: number };
        }>("SELECT public.expire_tenant_audit_events($1::integer) AS expired", [
          limit,
        ]);
        return result.rows[0]?.expired ?? { operational: -1, security: -1 };
      });

    // ------------------------------------------- every registered type is accepted, with its class
    await rolledBack(async (client) => {
      const written = new Map<string, string>();
      await client.query("SET LOCAL ROLE polaris_privacy_owner");
      for (const eventType of Object.keys(TENANT_AUDIT_EVENT_TYPES)) {
        const id = randomUUID();
        await client.query(
          `INSERT INTO ${AUDIT} (id, organization_id, actor_user_id, entity_type, entity_id, event_type)
           VALUES ($1, $2, $3, 'organization', $4, $5)`,
          [id, orgA.organizationId, orgA.userId, randomUUID(), eventType]
        );
        written.set(id, eventType);
      }
      await client.query("RESET ROLE");
      const classes = await client.query<{ event_class: string; id: string }>(
        `SELECT id, event_class FROM ${AUDIT} WHERE id = ANY($1::uuid[])`,
        [[...written.keys()]]
      );
      assert.equal(classes.rows.length, written.size);
      for (const row of classes.rows) {
        const eventType = written.get(row.id) ?? "";
        assert.equal(
          row.event_class,
          TENANT_AUDIT_EVENT_TYPES[
            eventType as keyof typeof TENANT_AUDIT_EVENT_TYPES
          ],
          eventType
        );
      }
    });
    // a new type without a class fails where it is written, instead of vanishing from the retention
    for (const unregistered of [
      "sale.exploded",
      "membership.invited",
      "organization.created.v2",
    ]) {
      await expectSqlState(
        () =>
          asRole(
            "polaris_privacy_owner",
            (client) =>
              client.query(
                `INSERT INTO ${AUDIT} (organization_id, actor_user_id, entity_type, entity_id, event_type)
                 VALUES ($1, $2, 'organization', $3, $4)`,
                [orgA.organizationId, orgA.userId, randomUUID(), unregistered]
              ),
            { commit: false }
          ),
        "23514",
        `${unregistered} has no class: the INSERT fails`,
        "tenant_audit_event_type_registered"
      );
    }
    tests.push(
      "every type of the registry inserts with the class the domain gives it; a type that is not in it (even a well-formed one) fails the INSERT on tenant_audit_event_type_registered"
    );

    // ------------------------------------- the real tenant runtime still writes its events
    const created = await withTenantAs(
      db,
      orgA,
      "customer:update",
      (transaction, identity) =>
        createCustomer(transaction, identity, {
          email: "audit@example.invalid",
          name: "Cliente da auditoria",
          notes: null,
          phone: null,
          requestId: randomUUID(),
        })
    );
    assert.ok(created);
    const tenantEvent = await owner.pool.query<{
      event_class: string;
      event_type: string;
    }>(
      `SELECT event_type, event_class FROM ${AUDIT} WHERE organization_id = $1 AND entity_id = $2`,
      [orgA.organizationId, created.id]
    );
    assert.deepEqual(tenantEvent.rows, [
      { event_class: "operational", event_type: "customer.created" },
    ]);
    tests.push(
      "the tenant runtime still writes its audit event through the policy, and the row gets its class"
    );

    // ------------------------------------------ immutable, even around the privileges
    const tableChecks: {
      seed: (client: PoolClient) => Promise<void>;
      table: string;
      update: string;
    }[] = [
      {
        seed: async () => undefined,
        table: "tenant_audit_event",
        update: `UPDATE public.tenant_audit_event SET entity_type = entity_type WHERE organization_id = '${orgA.organizationId}'`,
      },
      {
        seed: async (client) => {
          await client.query(
            "INSERT INTO public.auth_security_audit_event (event_type, outcome, request_id) VALUES ('logout_succeeded', 'succeeded', 'audit-gate')"
          );
        },
        table: "auth_security_audit_event",
        update:
          "UPDATE public.auth_security_audit_event SET request_id = request_id",
      },
      {
        seed: async (client) => {
          await client.query(
            "INSERT INTO public.deletion_ledger (organization_id, entity_type, entity_id, operation) VALUES ('audit-gate-org', 'organization', 'audit-gate-org', 'purge')"
          );
        },
        table: "deletion_ledger",
        update: "UPDATE public.deletion_ledger SET operation = operation",
      },
      {
        seed: async () => undefined,
        table: "platform_audit_events",
        update:
          "UPDATE public.platform_audit_events SET detail = detail WHERE true",
      },
    ];
    // some rows for the platform audit to refuse to touch
    const probeCase = await openSupportCase(admin, principal, {
      context: null,
      kind: "support",
      organizationId: orgA.organizationId,
      reason: "Prova da auditoria",
    });
    assert.ok(probeCase);
    const refuseEverything = async (replica: boolean) => {
      for (const check of tableChecks) {
        for (const [name, statement] of [
          ["UPDATE", check.update],
          ["DELETE", `DELETE FROM public.${check.table}`],
          ["TRUNCATE", `TRUNCATE public.${check.table}`],
        ] as const) {
          // biome-ignore lint/performance/noAwaitInLoops: each probe is its own rolled-back transaction
          await rolledBack(async (client) => {
            if (replica) {
              await client.query(
                "SET LOCAL session_replication_role = replica"
              );
            }
            // a policy and the privileges that would let the statement reach its rows: the trigger is what stops it
            await client.query(
              `CREATE POLICY audit_gate_probe ON public.${check.table} FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true)`
            );
            await check.seed(client);
            await assert.rejects(
              () => client.query(statement),
              (error: unknown) => {
                assert.equal((error as { code?: string }).code, "23514");
                assert.match(
                  (error as Error).message,
                  APPEND_ONLY,
                  `${check.table}: ${name}`
                );
                return true;
              },
              `${check.table}: ${name} is refused${replica ? " under session_replication_role = replica" : ""}`
            );
          });
        }
      }
    };
    await refuseEverything(false);
    tests.push(
      "UPDATE, DELETE and TRUNCATE are refused (23514) on the tenant audit, the auth security audit, the deletion ledger and the platform audit, even for the owner of the table with a policy that shows every row"
    );
    if (isSuperuser) {
      await refuseEverything(true);
      tests.push(
        "the same refusals hold under session_replication_role = replica (the triggers are ENABLE ALWAYS)"
      );
    } else {
      assert.notEqual(
        process.env.CI,
        "true",
        "the CI database must let the gate set session_replication_role"
      );
      tests.push(
        "session_replication_role = replica was not tried: the connection is not a superuser (the CI database always is)"
      );
    }
    await closeSupportCase(admin, principal, probeCase.id, "Fim da prova");

    // the foreign key restricts: an organization with audit cannot be deleted, and nothing cascades the audit away
    // (an organization of its own: the cases of the others would stop the DELETE first, on their own keys)
    const orgG = await org("G");
    await seed(orgG, [{ age: "1 day", label: "g", type: "sale.confirmed" }]);
    await rolledBack(async (client) => {
      await assert.rejects(
        () =>
          client.query("DELETE FROM public.organizations WHERE id = $1", [
            orgG.organizationId,
          ]),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, "23001");
          assert.equal(
            (error as { constraint?: string }).constraint,
            "tenant_audit_event_organization_id_organizations_id_fk"
          );
          return true;
        }
      );
    });
    // a TRUNCATE that reaches the audit through the organization is refused too: the trigger fires on the cascaded table
    await rolledBack(async (client) => {
      await assert.rejects(
        () => client.query("TRUNCATE public.organizations CASCADE"),
        (error: unknown) => {
          const { code } = error as { code?: string };
          assert.ok(code === "23514" || code === "0A000", String(code));
          return true;
        }
      );
    });
    tests.push(
      "deleting an organization that has audit rows fails on the RESTRICT foreign key (23001): nothing cascades the audit away"
    );

    // ------------------------------------------------------------- the purge keeps the audit
    const auditIdsOf = async (tenant: TenantFixture) =>
      (
        await owner.pool.query<{ id: string }>(
          `SELECT id FROM ${AUDIT} WHERE organization_id = $1 ORDER BY id`,
          [tenant.organizationId]
        )
      ).rows.map((row) => row.id);
    await seed(orgE, [
      { age: "1 day", label: "e-op", type: "sale.confirmed" },
      { age: "2 days", label: "e-sec", type: "data_export.requested" },
      {
        age: `${SECURITY_MONTHS - 1} months`,
        label: "e-old-sec",
        type: "offline_grant.issued",
      },
      { age: "400 days", label: "e-old-op", type: "category.created" },
    ]);
    await withTenantAs(
      db,
      orgE,
      "organization:close",
      (transaction, identity) =>
        requestOrganizationClosure(transaction, identity, {
          confirmation: `PR43 sales gate audit E ${suffix}`,
        })
    );
    await owner.pool.query(
      "UPDATE public.organization_closures SET requested_at = now() - interval '91 days', recover_until = now() - interval '1 day' WHERE organization_id = $1",
      [orgE.organizationId]
    );
    // the notice of D minus 7 days of this cycle was delivered, 8 days ago: no store is deleted before the owner was told,
    // and not before 7 days after (ADR 0102, amended). The e-mail that delivers it is a later change, so the row is
    // written as it would leave it.
    await owner.pool.query(
      `INSERT INTO public.closure_notices
         (organization_id, closure_requested_at, milestone, due_at, user_id, sent_at)
       SELECT organization_id, requested_at, 'd7', requested_at, requested_by_user_id, now() - interval '8 days'
         FROM public.organization_closures WHERE organization_id = $1`,
      [orgE.organizationId]
    );
    await maintenance.finalizeExpiredClosures(1000);
    const before = await auditIdsOf(orgE);
    assert.ok(
      before.length >= 5,
      "the closure request wrote its own event too"
    );
    const privacyCase = await openPrivacyCase(admin, principal, {
      channel: "email",
      dueDays: 15,
      note: null,
      organizationId: orgE.organizationId,
      reason: "Pedido de exclusão da organização",
      receivedAt: null,
      requesterKind: "organization_owner",
      requestType: "deletion",
    });
    assert.ok(privacyCase);
    await recordPrivacyIdentity(admin, principal, privacyCase.id, {
      method: "owner_confirmation",
      status: "verified",
    });
    await recordPrivacyRole(admin, principal, privacyCase.id, "controller");
    await recordPrivacyScope(admin, principal, privacyCase.id, {
      categories: [...ORGANIZATION_PURGE_REQUIRED_SCOPE],
      subjectReference: null,
    });
    await recordPrivacyDecision(admin, principal, privacyCase.id, {
      decision: "accept",
      note: null,
      reason: null,
    });
    // the case that says the audit logs go with the purge is refused: the purge no longer removes them
    const refusedCase = await openPrivacyCase(admin, principal, {
      channel: "email",
      dueDays: 15,
      note: null,
      organizationId: orgE.organizationId,
      reason: "Pedido com registros de auditoria",
      receivedAt: null,
      requesterKind: "organization_owner",
      requestType: "deletion",
    });
    assert.ok(refusedCase);
    await recordPrivacyIdentity(admin, principal, refusedCase.id, {
      method: "owner_confirmation",
      status: "verified",
    });
    await recordPrivacyRole(admin, principal, refusedCase.id, "controller");
    await recordPrivacyScope(admin, principal, refusedCase.id, {
      categories: [...ORGANIZATION_PURGE_REQUIRED_SCOPE, "audit_logs"],
      subjectReference: null,
    });
    await recordPrivacyDecision(admin, principal, refusedCase.id, {
      decision: "accept",
      note: null,
      reason: null,
    });
    await assert.rejects(
      () =>
        scheduleOrganizationPurge(
          admin,
          principal,
          refusedCase.id,
          orgE.organizationId
        ),
      (error: unknown) =>
        (error as { code?: string }).code === "privacy_scope_covers_kept_data",
      "a case that claims the audit logs is refused: they are kept data now"
    );
    const scheduled = await scheduleOrganizationPurge(
      admin,
      principal,
      privacyCase.id,
      orgE.organizationId
    );
    assert.equal(scheduled?.status, "purge_pending");
    // the run holds the purge (the claim takes the oldest in the whole database, so the lease is set directly)
    await asRole("polaris_admin_owner", (client) =>
      client.query(
        "UPDATE public.organization_purges SET locked_until = now() + interval '15 minutes' WHERE organization_id = $1",
        [orgE.organizationId]
      )
    );
    const purged = await maintenance.purgeOrganizationData(orgE.organizationId);
    assert.equal(purged.alreadyPurged, false);
    const status = await scalar<string>(
      "SELECT status AS value FROM public.organizations WHERE id = $1",
      [orgE.organizationId]
    );
    assert.equal(status, "purged");
    assert.deepEqual(
      await auditIdsOf(orgE),
      before,
      "every audit row of the organization is still there after the purge"
    );
    const memberCount = await scalar<string>(
      "SELECT count(*)::text AS value FROM public.memberships WHERE organization_id = $1",
      [orgE.organizationId]
    );
    assert.equal(
      memberCount,
      "0",
      "the purge did remove the rest of the tenant"
    );
    await asRole("polaris_admin_owner", (client) =>
      client.query(
        "UPDATE public.organization_purges SET swept_at = now(), locked_until = NULL WHERE organization_id = $1",
        [orgE.organizationId]
      )
    );
    tests.push(
      "purge_organization_data removes the tenant and leaves every row of its audit (security and operational, old and new); a deletion case that claims audit_logs is refused as covering kept data"
    );

    // ----------------------------------------- the expiry: only the expired, per class, from the right moment
    const supportCase = async (tenant: TenantFixture) => {
      const opened = await openSupportCase(admin, principal, {
        context: null,
        kind: "support",
        organizationId: tenant.organizationId,
        reason: "Prova da retenção",
      });
      assert.ok(opened);
      return opened.id;
    };
    /** The purge row of an organization: purged a while ago and already swept (nothing is left for a job to claim). */
    const markPurged = async (
      tenant: TenantFixture,
      caseId: string,
      ago: string
    ) =>
      await asRole("polaris_admin_owner", (client) =>
        client.query(
          `INSERT INTO public.organization_purges
             (organization_id, scheduled_at, scheduled_by, support_case_id, privacy_case_id, not_before, purged_at, swept_at)
           VALUES ($1, now() - $2::interval - interval '40 days', $3, $4, $4, now() - $2::interval - interval '30 days',
                   now() - $2::interval, now() - $2::interval)`,
          [tenant.organizationId, ago, principal, caseId]
        )
      );
    // A: not purged. B: purged beyond the operational period. C: purged inside it. D: purged long ago, under a legal hold
    const securityExpired = `${SECURITY_MONTHS} months ${MARGIN}`;
    const rowsA = await seed(orgA, [
      {
        age: securityExpired,
        label: "sec-expired",
        type: "customer.anonymized",
      },
      {
        age: `${SECURITY_MONTHS} months -${MARGIN}`,
        label: "sec-live",
        type: "data_export.ready",
      },
      { age: "120 months", label: "op-very-old", type: "sale.confirmed" },
    ]);
    const caseB = await supportCase(orgB);
    await markPurged(orgB, caseB, `${OPERATIONAL_MONTHS} months ${MARGIN}`);
    const rowsB = await seed(orgB, [
      { age: "1 day", label: "op-recent", type: "sale.confirmed" },
      { age: "1 day", label: "sec-recent", type: "organization.created" },
      {
        age: securityExpired,
        label: "sec-expired",
        type: "offline_grant.revoked",
      },
      // security (the whole catalog on or off): past the operational period of the purge, still inside the security one
      {
        age: `${SECURITY_MONTHS - 1} months`,
        label: "sec-catalog-live",
        type: "public_catalog.unpublished",
      },
    ]);
    const caseC = await supportCase(orgC);
    await markPurged(orgC, caseC, `${OPERATIONAL_MONTHS} months -${MARGIN}`);
    const rowsC = await seed(orgC, [
      { age: "1 day", label: "op-recent", type: "goal.created" },
      {
        age: securityExpired,
        label: "sec-expired",
        type: "product.published_to_catalog",
      },
      {
        age: securityExpired,
        label: "sec-catalog-expired",
        type: "public_catalog.published",
      },
    ]);
    const caseD = await supportCase(orgD);
    await placeOrganizationLegalHold(
      admin,
      principal,
      caseD,
      orgD.organizationId,
      new Date(Date.now() + 30 * 86_400_000).toISOString()
    );
    await markPurged(orgD, caseD, `${OPERATIONAL_MONTHS * 2} months`);
    const rowsD = await seed(orgD, [
      { age: "1 day", label: "op-recent", type: "expense.created" },
      {
        age: securityExpired,
        label: "sec-expired",
        type: "customer.anonymized",
      },
    ]);

    // the limit and the invalid arguments
    for (const bad of [0, -1, 10_001]) {
      await expectSqlState(
        () => expireRows(bad),
        "22023",
        `the batch size ${bad} is refused`
      );
    }
    await expectSqlState(
      () =>
        asRole(probe, (client) =>
          client.query("SELECT public.expire_tenant_audit_events(NULL)")
        ),
      "22023",
      "a null batch size is refused"
    );

    // what the predicate calls expired, counted before each run by the retention owner: the run removes exactly that
    const expiredNow = async () =>
      await asRole("polaris_retention_owner", async (client) => {
        const result = await client.query<{
          operational: string;
          security: string;
        }>(
          `SELECT count(*) FILTER (WHERE event_class = 'security')::text AS security,
                  count(*) FILTER (WHERE event_class = 'operational')::text AS operational
             FROM ${AUDIT}
            WHERE public.tenant_audit_event_expired(organization_id, event_class, created_at)`
        );
        return {
          operational: Number(result.rows[0]?.operational),
          security: Number(result.rows[0]?.security),
        };
      });
    const dueFirst = await expiredNow();
    assert.ok(dueFirst.security >= 3 && dueFirst.operational >= 1);
    const first = await expireRows();
    assert.deepEqual(
      first,
      dueFirst,
      "the run removes exactly what was expired (the security rows of A, B and C, the operational one of B; not D's)"
    );
    assert.deepEqual(
      await survivors(rowsA),
      ["op-very-old", "sec-live"],
      "A: security counts from the event; operational never expires while the organization is not purged"
    );
    assert.deepEqual(
      await survivors(rowsB),
      ["sec-catalog-live", "sec-recent"],
      "B: operational counts from the purge, whatever the age of the event; security from the event"
    );
    assert.deepEqual(
      await survivors(rowsC),
      ["op-recent"],
      "C: operational is kept inside the period after the purge; the expired security row went"
    );
    assert.deepEqual(
      await survivors(rowsD),
      ["op-recent", "sec-expired"],
      "D: a legal hold keeps even what is expired"
    );
    const untouched = await auditIdsOf(orgE);
    assert.deepEqual(
      untouched,
      before,
      "the organization purged now has all its audit: nothing of it is expired"
    );
    tests.push(
      `the expiry removes only the expired: security ${SECURITY_MONTHS} months after the event, operational ${OPERATIONAL_MONTHS} months after the purge of the organization (never before it), and each period is proved on both sides of its edge`
    );

    // the legal hold is the only thing that kept D: released, the same rows go on the next run
    await releaseOrganizationLegalHold(
      admin,
      principal,
      caseD,
      orgD.organizationId
    );
    const dueSecond = await expiredNow();
    assert.ok(dueSecond.security >= 1 && dueSecond.operational >= 1);
    assert.deepEqual(await expireRows(), dueSecond);
    assert.deepEqual(
      await survivors(rowsD),
      [],
      "D: once the hold is released both expired rows go (it was purged long enough ago for the operational one)"
    );
    // and a hold placed again protects again: the predicate looks at the hold in force now
    const rowsD2 = await seed(orgD, [
      {
        age: securityExpired,
        label: "sec-expired-2",
        type: "organization.closure_requested",
      },
    ]);
    await placeOrganizationLegalHold(
      admin,
      principal,
      caseD,
      orgD.organizationId,
      new Date(Date.now() + 30 * 86_400_000).toISOString()
    );
    await expireRows();
    assert.deepEqual(
      await survivors(rowsD2),
      ["sec-expired-2"],
      "a new hold keeps the new expired row"
    );
    await releaseOrganizationLegalHold(
      admin,
      principal,
      caseD,
      orgD.organizationId
    );
    tests.push(
      "an organization under a legal hold keeps its expired rows of both classes; they go on the next run after the hold is released, and a hold placed again protects again"
    );

    // running again changes nothing, and the batch size bounds a run
    const dueAgain = await expiredNow();
    assert.deepEqual(await expireRows(), dueAgain);
    assert.deepEqual(await expiredNow(), { operational: 0, security: 0 });
    assert.deepEqual(await survivors(rowsA), ["op-very-old", "sec-live"]);
    assert.deepEqual(await survivors(rowsB), [
      "sec-catalog-live",
      "sec-recent",
    ]);
    const rowsF = await seed(orgF, [
      { age: securityExpired, label: "f1", type: "customer.anonymized" },
      { age: securityExpired, label: "f2", type: "customer.anonymized" },
      { age: securityExpired, label: "f3", type: "customer.anonymized" },
    ]);
    const bounded = await expireRows(2);
    assert.equal(
      bounded.security + bounded.operational,
      2,
      "a batch of 2 removes 2"
    );
    assert.equal((await survivors(rowsF)).length, 1);
    await expireRows(100);
    assert.equal((await survivors(rowsF)).length, 0);
    tests.push(
      "running the expiry again removes nothing more of what is not expired, and the batch size bounds what a run removes"
    );

    // ------------------------------ there is no other way in: the trigger asks the same question again
    const heldRows = await seed(orgD, [
      {
        age: securityExpired,
        label: "held-expired",
        type: "customer.anonymized",
      },
    ]);
    const [aLive, aVeryOld] = [
      rowsA.find((row) => row.label === "sec-live"),
      rowsA.find((row) => row.label === "op-very-old"),
    ];
    assert.ok(aLive && aVeryOld);
    await placeOrganizationLegalHold(
      admin,
      principal,
      caseD,
      orgD.organizationId,
      new Date(Date.now() + 30 * 86_400_000).toISOString()
    );
    // as the retention owner itself, the policy shows it only the rows that are expired and not held
    const seen = await asRole(
      "polaris_retention_owner",
      async (client) =>
        (
          await client.query<{ id: string }>(
            `SELECT id FROM ${AUDIT} WHERE id = ANY($1::uuid[])`,
            [[aLive.id, aVeryOld.id, ...heldRows.map((row) => row.id)]]
          )
        ).rows.length
    );
    assert.equal(
      seen,
      2 + heldRows.length,
      "it can read the keys (SELECT is on four columns)"
    );
    for (const target of [aLive, aVeryOld, ...heldRows]) {
      const result = await asRole("polaris_retention_owner", (client) =>
        client.query(`DELETE FROM ${AUDIT} WHERE id = $1`, [target.id])
      );
      assert.equal(
        result.rowCount,
        0,
        `${target.label}: the policy hides it from a DELETE`
      );
    }
    // even with a policy that shows it everything, the trigger lets through only the expired and not held
    await rolledBack(async (client) => {
      await client.query(
        `CREATE POLICY audit_gate_retention_all ON ${AUDIT} FOR DELETE TO polaris_retention_owner USING (true)`
      );
      await client.query("SET LOCAL ROLE polaris_retention_owner");
      for (const target of [aLive, aVeryOld, ...heldRows]) {
        await client.query("SAVEPOINT attempt");
        await assert.rejects(
          () => client.query(`DELETE FROM ${AUDIT} WHERE id = $1`, [target.id]),
          (error: unknown) => (error as { code?: string }).code === "23514",
          `${target.label}: the trigger refuses it for the retention owner too`
        );
        await client.query("ROLLBACK TO SAVEPOINT attempt");
      }
    });
    // an UPDATE, an INSERT and a TRUNCATE are not in its privileges
    await expectSqlState(
      () =>
        asRole("polaris_retention_owner", (client) =>
          client.query(`UPDATE ${AUDIT} SET entity_type = entity_type`)
        ),
      "42501",
      "the retention owner cannot UPDATE"
    );
    await expectSqlState(
      () =>
        asRole("polaris_retention_owner", (client) =>
          client.query(`TRUNCATE ${AUDIT}`)
        ),
      "42501",
      "the retention owner cannot TRUNCATE"
    );
    // the other roles that touch the audit cannot delete it either
    for (const [name, url] of [
      ["the tenant runtime", tenantUrl],
      ["the privacy runtime", privacyUrl],
      ["the admin runtime", adminRuntimeUrl],
    ] as const) {
      const login = createDatabase(url, { maxConnections: 1 });
      try {
        await expectSqlState(
          () =>
            login.pool.query(`DELETE FROM ${AUDIT} WHERE id = $1`, [aLive.id]),
          "42501",
          `${name} cannot DELETE audit rows`
        );
        await expectSqlState(
          () => login.pool.query("SELECT public.expire_tenant_audit_events(1)"),
          "42501",
          `${name} cannot execute the expiry`
        );
      } finally {
        await login.pool.end();
      }
    }
    tests.push(
      "the retention owner reaches a row only through the policy and the trigger (expired, by its class, and without a legal hold), cannot UPDATE or TRUNCATE, and the runtimes can neither DELETE nor execute the expiry"
    );

    // the gate leaves no legal hold in force
    await releaseOrganizationLegalHold(
      admin,
      principal,
      caseD,
      orgD.organizationId
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
    await runtime?.pool.end().catch(() => undefined);
    await adminRuntime?.pool.end().catch(() => undefined);
    await privacy?.close().catch(() => undefined);
    // the probe, the memberships and the logins are the gate's own: all undone
    if (probeRole) {
      await asRole("polaris_retention_owner", (client) =>
        client.query(
          `REVOKE EXECUTE ON FUNCTION public.expire_tenant_audit_events(integer) FROM "${probeRole}"`
        )
      ).catch(() => undefined);
      await owner.pool
        .query(`REVOKE "${probeRole}" FROM CURRENT_USER`)
        .catch(() => undefined);
      await owner.pool
        .query(`DROP ROLE IF EXISTS "${probeRole}"`)
        .catch(() => undefined);
    }
    for (const owned of memberships) {
      // biome-ignore lint/performance/noAwaitInLoops: Cleanups, in order.
      await owner.pool
        .query(`REVOKE ${owned} FROM CURRENT_USER`)
        .catch(() => undefined);
    }
    for (const [loginRole, group] of logins) {
      // biome-ignore lint/performance/noAwaitInLoops: Cleanups, in order.
      await owner.pool.query(`REVOKE "${group}" FROM "${loginRole}"`);
      await owner.pool.query(`DROP ROLE IF EXISTS "${loginRole}"`);
    }
    await owner.pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    `Audit retention PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
