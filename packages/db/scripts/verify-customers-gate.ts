import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { CustomerVersionConflictError } from "@polaris/domain/customers/customer";
import { Client } from "pg";
import { createDatabase } from "../src/client";
import {
  archiveCustomer,
  createCustomer,
  listCustomers,
  restoreCustomer,
  updateCustomer,
} from "../src/customer-repository";
import {
  type TenantRequestIdentity,
  type TenantRequestTransaction,
  withAuthorizedTenantTransaction,
} from "../src/tenant-transaction";

const expectedBranch = "pr36-customers-gate";
const runtimeRole = "polaris_pr11_runtime";
const cleanupOwnerRole = "polaris_media_cleanup_owner";
const cleanupRuntimeRole = "polaris_media_cleanup_runtime";
const poolerPattern = /pooler/i;
const customerContactUniqueIndexPattern = /\((?:.*\bemail\b|.*\bphone\b)/i;
const disposableHostPattern =
  /^ep-[a-z-]+-[a-z0-9]+\.c-2\.sa-east-1\.aws\.neon\.tech$/;

type Database = ReturnType<typeof createDatabase>["db"];
type AdminPool = ReturnType<typeof createDatabase>["pool"];
interface TenantFixture {
  organizationId: string;
  userId: string;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}.`);
  }
  return value;
}

function sqlState(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const { code } = error as { code?: unknown };
  return typeof code === "string" ? code : undefined;
}

async function expectSqlState(
  operation: () => Promise<unknown>,
  expected: string,
  label: string
): Promise<void> {
  await assert.rejects(
    operation,
    (error: unknown) => {
      assert.equal(sqlState(error), expected, label);
      return true;
    },
    label
  );
}

async function createTenantFixture(
  adminPool: AdminPool,
  label: string
): Promise<TenantFixture> {
  const userId = randomUUID();
  const organizationId = randomUUID();
  await adminPool.query(
    'INSERT INTO public."user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)',
    [userId, `PR36 customers gate ${label}`, `pr36-${userId}@example.invalid`]
  );
  await adminPool.query(
    "INSERT INTO public.organizations (id, name, timezone) VALUES ($1, $2, $3)",
    [organizationId, `PR36 customers gate ${label}`, "America/Sao_Paulo"]
  );
  await adminPool.query(
    "INSERT INTO public.memberships (organization_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')",
    [organizationId, userId]
  );
  return { organizationId, userId };
}

async function withTenant<T>(
  database: Database,
  fixture: TenantFixture,
  operation: (
    transaction: TenantRequestTransaction,
    identity: TenantRequestIdentity
  ) => Promise<T>
): Promise<T> {
  return await withAuthorizedTenantTransaction(
    database,
    {
      authenticatedUserId: fixture.userId,
      capability: "customer:update",
      requestedOrganizationId: fixture.organizationId,
    },
    operation
  );
}

async function withRuntimeSqlContext<T>(
  connectionString: string,
  fixture: TenantFixture,
  operation: (client: Client) => Promise<T>
): Promise<T> {
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  await client.query("BEGIN");
  try {
    await client.query(
      "SELECT set_config('app.organization_id', $1, true), set_config('app.user_id', $2, true)",
      [fixture.organizationId, fixture.userId]
    );
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

function temporaryRuntimeUrl(adminUrl: string, role: string, password: string) {
  const url = new URL(adminUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}

async function run() {
  const branch = requiredEnvironment("POLARIS_CUSTOMER_GATE_BRANCH");
  assert.equal(branch, expectedBranch);
  const adminUrl = requiredEnvironment("POLARIS_CUSTOMER_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);

  const admin = createDatabase(adminUrl, { maxConnections: 2 });
  let runtime: ReturnType<typeof createDatabase> | undefined;
  let loginRole: string | undefined;
  const tests: string[] = [];

  try {
    const server = await admin.pool.query<{
      database_name: string;
      server_version: string;
      server_version_num: string;
    }>(
      "SELECT current_database() AS database_name, current_setting('server_version') AS server_version, current_setting('server_version_num') AS server_version_num"
    );
    const [serverRow] = server.rows;
    assert.ok(serverRow);
    assert.equal(serverRow.database_name, "neondb");
    assert.ok(Number(serverRow.server_version_num) >= 180_000);
    tests.push("disposable direct Neon connection is PostgreSQL 18");

    const table = await admin.pool.query<{
      relforcerowsecurity: boolean;
      relowner: string;
      relrowsecurity: boolean;
    }>(
      "SELECT c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) AS relowner FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customers'"
    );
    assert.equal(table.rows.length, 1);
    assert.equal(table.rows[0]?.relrowsecurity, true);
    assert.equal(table.rows[0]?.relforcerowsecurity, true);
    assert.notEqual(table.rows[0]?.relowner, runtimeRole);

    const privileges = await admin.pool.query<{
      can_delete: boolean;
      can_insert: boolean;
      can_select: boolean;
      can_update: boolean;
    }>(
      "SELECT has_table_privilege($1, 'public.customers', 'SELECT') AS can_select, has_table_privilege($1, 'public.customers', 'INSERT') AS can_insert, has_table_privilege($1, 'public.customers', 'UPDATE') AS can_update, has_table_privilege($1, 'public.customers', 'DELETE') AS can_delete",
      [runtimeRole]
    );
    assert.deepEqual(privileges.rows[0], {
      can_delete: false,
      can_insert: true,
      can_select: true,
      can_update: true,
    });

    const runtimeRoleState = await admin.pool.query<{
      rolbypassrls: boolean;
      rolcreaterole: boolean;
      rolsuper: boolean;
    }>(
      "SELECT rolbypassrls, rolcreaterole, rolsuper FROM pg_catalog.pg_roles WHERE rolname = $1",
      [runtimeRole]
    );
    assert.deepEqual(runtimeRoleState.rows[0], {
      rolbypassrls: false,
      rolcreaterole: false,
      rolsuper: false,
    });

    const cleanupFunctions = await admin.pool.query<{
      cleanup_can_execute: boolean;
      function_owner: string;
      migration_owner_can_set: boolean;
      proname: string;
      public_can_execute: boolean;
      tenant_can_execute: boolean;
      tenant_is_cleanup_owner: boolean;
    }>(
      "SELECT p.proname, owner.rolname AS function_owner, " +
        "EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl " +
        "WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE') AS public_can_execute, " +
        "pg_has_role('neondb_owner', $1, 'SET') AS migration_owner_can_set, " +
        "pg_has_role($2, $1, 'MEMBER') AS tenant_is_cleanup_owner, " +
        "has_function_privilege($2, p.oid, 'EXECUTE') AS tenant_can_execute, " +
        "has_function_privilege($3, p.oid, 'EXECUTE') AS cleanup_can_execute " +
        "FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles owner ON owner.oid = p.proowner " +
        "WHERE p.oid IN ($4::regprocedure, $5::regprocedure) ORDER BY p.proname",
      [
        cleanupOwnerRole,
        runtimeRole,
        cleanupRuntimeRole,
        "public.claim_media_storage_key_for_cleanup(text)",
        "public.guard_media_storage_key_cleanup_claim()",
      ]
    );
    assert.equal(cleanupFunctions.rows.length, 2);
    for (const fn of cleanupFunctions.rows) {
      assert.equal(fn.function_owner, cleanupOwnerRole);
      assert.equal(fn.migration_owner_can_set, false);
      assert.equal(fn.tenant_is_cleanup_owner, false);
      assert.equal(fn.tenant_can_execute, false);
      assert.equal(fn.public_can_execute, false);
      assert.equal(
        fn.cleanup_can_execute,
        fn.proname === "claim_media_storage_key_for_cleanup"
      );
    }
    tests.push(
      "migration 0026 cleanup function ownership and ACLs are least privilege"
    );

    const customerIndexes = await admin.pool.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_catalog.pg_indexes WHERE schemaname = 'public' AND tablename = 'customers' AND indexdef ILIKE 'CREATE UNIQUE INDEX%'"
    );
    assert.equal(
      customerIndexes.rows.some((row) =>
        customerContactUniqueIndexPattern.test(row.indexdef)
      ),
      false
    );
    tests.push("FORCE RLS and least-privilege runtime grants are installed");
    tests.push("customer contact values have no hard unique index");

    const tenantA = await createTenantFixture(admin.pool, "A");
    const tenantB = await createTenantFixture(admin.pool, "B");
    const loginSuffix = randomUUID().replaceAll("-", "");
    loginRole = `polaris_customer_gate_${loginSuffix}`;
    const loginPassword = randomBytes(24).toString("hex");
    await admin.pool.query(
      `CREATE ROLE "${loginRole}" WITH LOGIN INHERIT PASSWORD '${loginPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
    );
    await admin.pool.query(`GRANT "${runtimeRole}" TO "${loginRole}"`);

    const runtimeUrl = temporaryRuntimeUrl(adminUrl, loginRole, loginPassword);
    runtime = createDatabase(runtimeUrl, { maxConnections: 1 });
    const runtimeIdentity = await runtime.pool.query<{ current_user: string }>(
      "SELECT current_user"
    );
    assert.equal(runtimeIdentity.rows[0]?.current_user, loginRole);

    const first = await withTenant(
      runtime.db,
      tenantA,
      (transaction, identity) =>
        createCustomer(transaction, identity, {
          email: "shared@example.test",
          name: "Ana Silva",
          notes: "Anotação sintética de teste",
          phone: "+5511999990000",
          requestId: randomUUID(),
        })
    );
    const second = await withTenant(
      runtime.db,
      tenantA,
      (transaction, identity) =>
        createCustomer(transaction, identity, {
          email: "shared@example.test",
          name: "Ana Silva 2",
          notes: null,
          phone: null,
          requestId: randomUUID(),
        })
    );
    const third = await withTenant(
      runtime.db,
      tenantA,
      (transaction, identity) =>
        createCustomer(transaction, identity, {
          email: null,
          name: "Ana Silva 3",
          notes: null,
          phone: "+5511999990000",
          requestId: randomUUID(),
        })
    );
    assert.notEqual(first.id, second.id);
    assert.notEqual(first.id, third.id);

    const activeCustomers = await withTenant(
      runtime.db,
      tenantA,
      (transaction, identity) =>
        listCustomers(transaction, identity, { status: "active" })
    );
    assert.deepEqual(
      activeCustomers.map((customer) => customer.id).sort(),
      [first.id, second.id, third.id].sort()
    );
    tests.push(
      "same organization permits duplicate emails/phones and either contact field"
    );

    const crossTenantRows = await withRuntimeSqlContext(
      runtimeUrl,
      tenantA,
      async (client) =>
        await client.query(
          "SELECT id FROM public.customers WHERE organization_id = $1",
          [tenantB.organizationId]
        )
    );
    assert.equal(crossTenantRows.rows.length, 0);
    tests.push("tenant RLS hides another organization's customer rows");

    await expectSqlState(
      async () =>
        await withRuntimeSqlContext(
          runtimeUrl,
          tenantA,
          async (client) =>
            await client.query(
              "INSERT INTO public.customers (organization_id, name, email) VALUES ($1, $2, $3)",
              [tenantB.organizationId, "Cross tenant", "cross@example.test"]
            )
        ),
      "42501",
      "RLS rejects cross-tenant customer inserts"
    );
    await expectSqlState(
      async () =>
        await withRuntimeSqlContext(
          runtimeUrl,
          tenantA,
          async (client) =>
            await client.query("DELETE FROM public.customers WHERE id = $1", [
              first.id,
            ])
        ),
      "42501",
      "runtime cannot delete customer rows"
    );
    tests.push("cross-tenant inserts and runtime deletes are denied");

    const invalidCustomer = await createTenantFixture(admin.pool, "invalid");
    await expectSqlState(
      async () =>
        await admin.pool.query(
          "INSERT INTO public.customers (organization_id, name) VALUES ($1, $2)",
          [invalidCustomer.organizationId, "No contact"]
        ),
      "23514",
      "database requires a phone or email"
    );
    tests.push("database enforces the name/contact invariant");

    const updated = await withTenant(
      runtime.db,
      tenantA,
      (transaction, identity) =>
        updateCustomer(transaction, identity, {
          email: first.email,
          expectedVersion: first.version,
          id: first.id,
          name: "Ana Silva Atualizada",
          notes: "Nota atualizada",
          phone: first.phone,
          requestId: randomUUID(),
        })
    );
    assert.equal(updated.changed, true);
    assert.equal(updated.customer.version, first.version + 1);

    await assert.rejects(
      withTenant(runtime.db, tenantA, (transaction, identity) =>
        updateCustomer(transaction, identity, {
          email: first.email,
          expectedVersion: first.version,
          id: first.id,
          name: "Versão antiga",
          notes: "",
          phone: first.phone,
          requestId: randomUUID(),
        })
      ),
      CustomerVersionConflictError
    );

    const archived = await withTenant(
      runtime.db,
      tenantA,
      (transaction, identity) =>
        archiveCustomer(transaction, identity, {
          expectedVersion: updated.customer.version,
          id: first.id,
          requestId: randomUUID(),
        })
    );
    assert.equal(archived.changed, true);
    assert.equal(archived.customer.archivedAt instanceof Date, true);

    const repeatedArchive = await withTenant(
      runtime.db,
      tenantA,
      (transaction, identity) =>
        archiveCustomer(transaction, identity, {
          expectedVersion: archived.customer.version,
          id: first.id,
          requestId: randomUUID(),
        })
    );
    assert.equal(repeatedArchive.changed, false);

    const restored = await withTenant(
      runtime.db,
      tenantA,
      (transaction, identity) =>
        restoreCustomer(transaction, identity, {
          expectedVersion: archived.customer.version,
          id: first.id,
          requestId: randomUUID(),
        })
    );
    assert.equal(restored.changed, true);
    assert.equal(restored.customer.archivedAt, null);

    const audit = await admin.pool.query<{ event_type: string }>(
      "SELECT event_type FROM public.tenant_audit_event WHERE organization_id = $1 AND entity_type = 'customer' AND entity_id = $2 ORDER BY created_at, id",
      [tenantA.organizationId, first.id]
    );
    assert.deepEqual(
      audit.rows.map((row) => row.event_type),
      [
        "customer.created",
        "customer.updated",
        "customer.archived",
        "customer.restored",
      ]
    );
    tests.push(
      "expectedVersion, reversible archive, idempotence, and PII-free event audit"
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
    if (runtime) {
      await runtime.pool.end();
    }
    if (loginRole) {
      await admin.pool.query(`REVOKE "${runtimeRole}" FROM "${loginRole}"`);
      await admin.pool.query(`DROP ROLE "${loginRole}"`);
    }
    await admin.pool.end();
  }
}

run().catch(() => {
  console.error(
    "Customers PostgreSQL gate failed; sensitive connection details were suppressed."
  );
  process.exitCode = 1;
});
