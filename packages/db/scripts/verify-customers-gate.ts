import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  CustomerVersionConflictError,
  InvalidCustomerProfileError,
} from "@polaris/domain/customers/customer";
import { Client } from "pg";
import { createDatabase } from "../src/client";
import {
  archiveCustomer,
  CustomerIdConflictError,
  createCustomer,
  findPossibleCustomerDuplicates,
  listCustomers,
  restoreCustomer,
  updateCustomer,
} from "../src/customer-repository";
import {
  type TenantRequestIdentity,
  type TenantRequestTransaction,
  withAuthorizedTenantTransaction,
} from "../src/tenant-transaction";
import { assertAllowedGateUrl, disposableHostPattern } from "./gate-hosts";
import { redactedFailure } from "./sales-gate-support";

const gateDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const expectedBranch = process.env.POLARIS_GATE_BRANCH ?? "pr36-customers-gate";
const runtimeRole = "polaris_pr11_runtime";
const cleanupOwnerRole = "polaris_media_cleanup_owner";
const cleanupRuntimeRole = "polaris_media_cleanup_runtime";
const poolerPattern = /pooler/i;
const customerContactUniqueIndexPattern = /\((?:.*\bemail\b|.*\bphone\b)/i;
const customerEmailDuplicateIndexPattern =
  /using btree \(organization_id, lower\(email\)\) where \(email is not null\)$/;
const customerPhoneDuplicateIndexPattern =
  /using btree \(organization_id, phone\) where \(phone is not null\)$/;

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
  const parsedAdminUrl = assertAllowedGateUrl(adminUrl);
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
    assert.equal(serverRow.database_name, gateDatabase);
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
      "SELECT has_table_privilege($1, 'public.customers', 'SELECT') AS can_select, has_table_privilege($1, 'public.customers', 'INSERT') AS can_insert, has_any_column_privilege($1, 'public.customers', 'UPDATE') AS can_update, has_table_privilege($1, 'public.customers', 'DELETE') AS can_delete",
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

    // Membership is read from pg_auth_members: pg_has_role() answers true for
    // a superuser, which is what the owner is on the CI Postgres (not on Neon).
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
        "EXISTS (WITH RECURSIVE chain(roleid) AS (SELECT m.roleid FROM pg_auth_members m WHERE m.member = 'neondb_owner'::regrole AND m.set_option UNION SELECT m.roleid FROM pg_auth_members m JOIN chain c ON m.member = c.roleid WHERE m.set_option) SELECT 1 FROM chain WHERE roleid = $1::regrole) AS migration_owner_can_set, " +
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
    const duplicateLookupIndexes = await admin.pool.query<{
      indexdef: string;
      indexname: string;
    }>(
      "SELECT indexname, indexdef FROM pg_catalog.pg_indexes WHERE schemaname = 'public' AND tablename = 'customers' AND indexname IN ('customers_organization_email_lower_idx', 'customers_organization_phone_idx') ORDER BY indexname"
    );
    assert.deepEqual(
      duplicateLookupIndexes.rows.map((row) => row.indexname),
      [
        "customers_organization_email_lower_idx",
        "customers_organization_phone_idx",
      ]
    );
    assert.ok(
      duplicateLookupIndexes.rows.every(
        (row) => !row.indexdef.toLowerCase().startsWith("create unique index")
      )
    );
    const emailLookupIndex = duplicateLookupIndexes.rows.find(
      (row) => row.indexname === "customers_organization_email_lower_idx"
    )?.indexdef;
    const phoneLookupIndex = duplicateLookupIndexes.rows.find(
      (row) => row.indexname === "customers_organization_phone_idx"
    )?.indexdef;
    assert.ok(emailLookupIndex);
    assert.ok(phoneLookupIndex);
    assert.match(
      emailLookupIndex.toLowerCase().replaceAll('"', ""),
      customerEmailDuplicateIndexPattern
    );
    assert.match(
      phoneLookupIndex.toLowerCase().replaceAll('"', ""),
      customerPhoneDuplicateIndexPattern
    );
    tests.push("FORCE RLS and least-privilege runtime grants are installed");
    tests.push("customer contact values have no hard unique index");
    tests.push(
      "duplicate lookup indexes have the expected non-unique organization/email and organization/phone definitions"
    );

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

    const clientCustomerId = randomUUID();
    const clientCustomer = await withTenant(
      runtime.db,
      tenantA,
      (transaction, identity) =>
        createCustomer(transaction, identity, {
          email: null,
          id: clientCustomerId,
          name: "Criado offline",
          notes: null,
          phone: "+5511977770000",
          requestId: randomUUID(),
        })
    );
    assert.equal(clientCustomer.id, clientCustomerId);
    assert.equal(clientCustomer.organizationId, tenantA.organizationId);
    // a duplicate ID is a clean conflict and leaves the caller's transaction usable
    const afterConflict = await withTenant(
      runtime.db,
      tenantA,
      async (transaction, identity) => {
        await assert.rejects(
          createCustomer(transaction, identity, {
            email: null,
            id: clientCustomerId,
            name: "Mesmo id",
            notes: null,
            phone: "+5511966660000",
          }),
          CustomerIdConflictError
        );
        return listCustomers(transaction, identity, { status: "active" });
      }
    );
    assert.ok(
      afterConflict.some((customer) => customer.id === clientCustomerId)
    );
    assert.equal(
      afterConflict.filter((customer) => customer.name === "Mesmo id").length,
      0
    );
    // another tenant cannot take the same ID either
    await withTenant(runtime.db, tenantB, (transaction, identity) =>
      assert.rejects(
        createCustomer(transaction, identity, {
          email: null,
          id: clientCustomerId,
          name: "Outro tenant mesmo id",
          notes: null,
          phone: "+5511955550000",
        }),
        CustomerIdConflictError
      )
    );
    // an ID that is not a UUID never reaches the database
    await withTenant(runtime.db, tenantA, (transaction, identity) =>
      assert.rejects(
        createCustomer(transaction, identity, {
          email: null,
          id: "not-a-uuid",
          name: "Id invalido",
          notes: null,
          phone: "1",
        }),
        InvalidCustomerProfileError
      )
    );
    tests.push(
      "a client-supplied customer ID is kept; a duplicate (same or other tenant) is a clean conflict that does not abort the transaction"
    );

    const archivedDuplicate = await withTenant(
      runtime.db,
      tenantA,
      (transaction, identity) =>
        createCustomer(transaction, identity, {
          email: "Shared@example.test",
          name: "Cadastro arquivado",
          notes: null,
          phone: null,
          requestId: randomUUID(),
        })
    );
    const archivedDuplicateState = await withTenant(
      runtime.db,
      tenantA,
      (transaction, identity) =>
        archiveCustomer(transaction, identity, {
          expectedVersion: archivedDuplicate.version,
          id: archivedDuplicate.id,
          requestId: randomUUID(),
        })
    );
    assert.equal(archivedDuplicateState.changed, true);

    const sameNameDifferentContacts = await withTenant(
      runtime.db,
      tenantA,
      (transaction, identity) =>
        createCustomer(transaction, identity, {
          email: "unique-name@example.test",
          name: "Ana Silva",
          notes: null,
          phone: null,
          requestId: randomUUID(),
        })
    );
    const formattedPhone = await withTenant(
      runtime.db,
      tenantA,
      (transaction, identity) =>
        createCustomer(transaction, identity, {
          email: "formatted-phone@example.test",
          name: "Telefone formatado",
          notes: null,
          phone: "+55 (11) 98888-0000",
          requestId: randomUUID(),
        })
    );
    const tenantBContactMatch = await withTenant(
      runtime.db,
      tenantB,
      (transaction, identity) =>
        createCustomer(transaction, identity, {
          email: "shared@example.test",
          name: "Outro tenant",
          notes: null,
          phone: null,
          requestId: randomUUID(),
        })
    );

    const matches = await withTenant(
      runtime.db,
      tenantA,
      (transaction, identity) =>
        findPossibleCustomerDuplicates(transaction, identity, {
          email: " Shared@example.test ",
          phone: " +5511999990000 ",
        })
    );
    const matchesById = new Map(
      matches.map((match) => [match.customer.id, match.matchedBy])
    );
    assert.deepEqual(
      [...matchesById.keys()].sort(),
      [first.id, second.id, third.id, archivedDuplicate.id].sort()
    );
    assert.deepEqual(matchesById.get(first.id), ["email", "phone"]);
    assert.deepEqual(matchesById.get(second.id), ["email"]);
    assert.deepEqual(matchesById.get(third.id), ["phone"]);
    assert.deepEqual(matchesById.get(archivedDuplicate.id), ["email"]);
    assert.equal(
      matches.find((match) => match.customer.id === archivedDuplicate.id)
        ?.customer.archivedAt instanceof Date,
      true
    );
    assert.equal(matchesById.has(sameNameDifferentContacts.id), false);
    assert.equal(matchesById.has(tenantBContactMatch.id), false);

    const exactFormattedPhone = await withTenant(
      runtime.db,
      tenantA,
      (transaction, identity) =>
        findPossibleCustomerDuplicates(transaction, identity, {
          phone: " +55 (11) 98888-0000 ",
        })
    );
    assert.deepEqual(
      exactFormattedPhone.map((match) => match.customer.id),
      [formattedPhone.id]
    );
    const differentlyFormattedPhone = await withTenant(
      runtime.db,
      tenantA,
      (transaction, identity) =>
        findPossibleCustomerDuplicates(transaction, identity, {
          phone: "+5511988880000",
        })
    );
    assert.deepEqual(differentlyFormattedPhone, []);
    tests.push(
      "case-insensitive exact email and trimmed exact phone matches include archived rows, return every candidate, ignore name/formatting, and stay tenant-scoped"
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

run().catch((error: unknown) => {
  console.error(`Customers PostgreSQL gate failed (${redactedFailure(error)})`);
  process.exitCode = 1;
});
