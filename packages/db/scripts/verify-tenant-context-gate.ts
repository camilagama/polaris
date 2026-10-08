import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import { Client } from "pg";
import { createDatabase } from "../src/client";
import {
  createInitialOrganizationInDatabase,
  type CreateInitialOrganizationInDatabaseResult,
} from "../src/organization-repository";
import { memberships, organizations } from "../src/schema/organization";
import { rlsPocOperations } from "../src/schema/rls-poc";
import {
  TenantAuthorizationError,
  withAuthorizedTenantTransaction,
} from "../src/tenant-transaction";

const runtimeRole = "polaris_pr11_runtime";
const expectedPocSeeds = [
  {
    organization_id: "org_a",
    token: "seed-a",
    value: "synthetic data for org_a",
  },
  {
    organization_id: "org_b",
    token: "seed-b",
    value: "synthetic data for org_b",
  },
];
const sqlStatePattern = /^[0-9A-Z]{5}$/;
const rollbackFailurePattern = /intentional PR22 rollback/;
const sqlIdentifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const neonTestHostnamePattern =
  /^ep-[a-z-]+-[a-z0-9]+\.[a-z0-9-]+\.sa-east-1\.aws\.neon\.tech$/;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error("Missing required tenant context gate configuration.");
  }
  return value;
}

function sqlState(error: unknown): string | undefined {
  const visited = new Set<object>();
  let current: unknown = error;

  while (typeof current === "object" && current !== null) {
    if (visited.has(current)) {
      return undefined;
    }
    visited.add(current);

    const candidate = current as { cause?: unknown; code?: unknown };
    if (
      typeof candidate.code === "string" &&
      sqlStatePattern.test(candidate.code)
    ) {
      return candidate.code;
    }
    current = candidate.cause;
  }

  return undefined;
}

async function expectSqlState(
  operation: Promise<unknown>,
  expectedCode: string,
  operationName: string
): Promise<void> {
  await assert.rejects(
    operation,
    (error: unknown) => {
      assert.equal(sqlState(error), expectedCode);
      return true;
    },
    `${operationName} should be rejected with SQLSTATE ${expectedCode}`
  );
}

async function expectNoRowsOrSqlState(
  operation: Promise<unknown>,
  expectedCode: string,
  operationName: string
): Promise<void> {
  try {
    const result = await operation;
    assert.deepEqual(result, [], operationName);
  } catch (error) {
    if (sqlState(error) === expectedCode) {
      return;
    }
    throw error;
  }
}
async function expectTenantAuthorizationError(
  operation: Promise<unknown>,
  expectedCode: string
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof TenantAuthorizationError);
    assert.equal(error.code, expectedCode);
    return true;
  });
}

async function ensureRuntimeRoleCanBeSet(
  adminPool: ReturnType<typeof createDatabase>["pool"],
  roleName: string
): Promise<{ adminRoleName: string; membershipAdded: boolean }> {
  const result = await adminPool.query<{
    admin_role: string;
    can_set_runtime_role: boolean;
  }>(
    "SELECT current_user AS admin_role, pg_has_role(current_user, $1, 'SET') AS can_set_runtime_role",
    [roleName]
  );
  const [adminRole] = result.rows;
  assert.ok(adminRole);
  assert.match(adminRole.admin_role, sqlIdentifierPattern);
  if (adminRole.can_set_runtime_role) {
    return { adminRoleName: adminRole.admin_role, membershipAdded: false };
  }

  const grantSql = `GRANT "${roleName}" TO "${adminRole.admin_role}"`;
  await adminPool.query(grantSql);
  return { adminRoleName: adminRole.admin_role, membershipAdded: true };
}
async function main() {
  const connectionString = requiredEnvironment(
    "POLARIS_TENANT_CONTEXT_TEST_DATABASE_URL"
  );
  const expectedHostname = requiredEnvironment(
    "POLARIS_TENANT_CONTEXT_TEST_EXPECTED_HOSTNAME"
  );
  if (
    process.env.POLARIS_TENANT_CONTEXT_TEST_CONFIRM_DISPOSABLE !==
    "polaris-pr22-tenant-context-disposable"
  ) {
    throw new Error(
      "Confirm the disposable Neon branch with POLARIS_TENANT_CONTEXT_TEST_CONFIRM_DISPOSABLE=polaris-pr22-tenant-context-disposable."
    );
  }

  let databaseUrl: URL;
  try {
    databaseUrl = new URL(connectionString);
  } catch (error) {
    throw new Error(
      "The tenant context gate requires a valid direct Neon URL.",
      {
        cause: error,
      }
    );
  }
  assert.equal(databaseUrl.hostname, expectedHostname);
  assert.equal(databaseUrl.pathname, "/neondb");
  assert.equal(databaseUrl.hostname.includes("-pooler"), false);
  assert.match(databaseUrl.hostname, neonTestHostnamePattern);

  const { pool: adminPool } = createDatabase(connectionString, {
    maxConnections: 2,
  });
  const runtimeClient = new Client({
    connectionString,
    connectionTimeoutMillis: 5000,
  });
  const runtimeDb = drizzle({ client: runtimeClient }) as unknown as ReturnType<
    typeof createDatabase
  >["db"];
  let runtimeClientConnected = false;
  const fixtureUserIds: string[] = [];
  const fixtureOrganizationIds: string[] = [];
  const fixtureOperationTokens: string[] = [];
  let gatePassed = false;
  let adminRoleName: string | undefined;
  let runtimeRoleMembershipAdded = false;

  async function createUser(name: string): Promise<string> {
    const id = randomUUID();
    fixtureUserIds.push(id);
    await adminPool.query(
      'INSERT INTO public."user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)',
      [id, name, `pr22-${id}@example.invalid`]
    );
    return id;
  }

  async function createInitialOrganization(
    userId: string,
    name: string
  ): Promise<CreateInitialOrganizationInDatabaseResult> {
    const result = await createInitialOrganizationInDatabase(runtimeDb, {
      id: randomUUID(),
      name,
      timezone: "America/Sao_Paulo",
      userId,
    });
    fixtureOrganizationIds.push(result.organization.id);
    return result;
  }

  try {
    const databaseIdentity = await adminPool.query<{
      database: string;
      server_version: string;
    }>(
      "SELECT current_database() AS database, current_setting('server_version') AS server_version"
    );
    assert.equal(databaseIdentity.rows[0]?.database, "neondb");
    assert.equal(
      Number.parseInt(
        databaseIdentity.rows[0]?.server_version.split(".")[0] ?? "",
        10
      ),
      18,
      "The tenant context gate requires PostgreSQL 18."
    );

    const runtimeRoleResult = await adminPool.query<{
      bypass_rls: boolean;
      superuser: boolean;
    }>(
      "SELECT rolbypassrls AS bypass_rls, rolsuper AS superuser FROM pg_roles WHERE rolname = $1",
      [runtimeRole]
    );
    assert.deepEqual(runtimeRoleResult.rows[0], {
      bypass_rls: false,
      superuser: false,
    });

    const tableOwners = await adminPool.query<{
      owner: string;
      table_name: string;
    }>(
      "SELECT c.relname AS table_name, pg_get_userbyid(c.relowner) AS owner " +
        "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
        "WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])",
      [["organizations", "memberships"]]
    );
    assert.equal(tableOwners.rows.length, 2);
    assert.equal(
      tableOwners.rows.some((row) => row.owner === runtimeRole),
      false
    );

    const rlsState = await adminPool.query<{
      force_rls: boolean;
      rls_enabled: boolean;
      table_name: string;
    }>(
      "SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled, " +
        "c.relforcerowsecurity AS force_rls " +
        "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
        "WHERE n.nspname = 'public' AND c.relname = ANY($1::text[]) " +
        "ORDER BY c.relname",
      [["memberships", "organizations"]]
    );
    assert.deepEqual(
      rlsState.rows.map((row) => [
        row.table_name,
        row.rls_enabled,
        row.force_rls,
      ]),
      [
        ["memberships", true, true],
        ["organizations", true, true],
      ]
    );

    const policies = await adminPool.query<{
      command: string;
      policy_name: string;
      roles: string;
      table_name: string;
      with_check: string | null;
      using_expression: string | null;
    }>(
      "SELECT tablename AS table_name, policyname AS policy_name, cmd AS command, " +
        "roles, qual AS using_expression, with_check " +
        "FROM pg_policies WHERE schemaname = 'public' " +
        "AND tablename = ANY($1::text[]) ORDER BY tablename, policyname",
      [["memberships", "organizations"]]
    );
    assert.deepEqual(
      policies.rows.map((policy) => policy.policy_name),
      [
        "memberships_current_user_insert",
        "memberships_current_user_select",
        "organizations_active_tenant_select",
        "organizations_context_insert",
      ]
    );
    assert.ok(
      policies.rows.every((policy) => policy.roles === `{${runtimeRole}}`)
    );
    const organizationReadPolicy = policies.rows.find(
      (policy) => policy.policy_name === "organizations_active_tenant_select"
    );
    assert.ok(organizationReadPolicy?.using_expression?.includes("active"));
    const organizationInsertPolicy = policies.rows.find(
      (policy) => policy.policy_name === "organizations_context_insert"
    );
    assert.ok(organizationInsertPolicy?.with_check?.includes("active"));

    const grants = await adminPool.query<{
      memberships_delete: boolean;
      memberships_insert: boolean;
      memberships_select: boolean;
      memberships_update: boolean;
      organizations_delete: boolean;
      organizations_insert: boolean;
      organizations_select: boolean;
      organizations_update: boolean;
    }>(
      "SELECT has_table_privilege($1, 'public.memberships', 'SELECT') AS memberships_select, " +
        "has_table_privilege($1, 'public.memberships', 'INSERT') AS memberships_insert, " +
        "has_table_privilege($1, 'public.memberships', 'UPDATE') AS memberships_update, " +
        "has_table_privilege($1, 'public.memberships', 'DELETE') AS memberships_delete, " +
        "has_table_privilege($1, 'public.organizations', 'SELECT') AS organizations_select, " +
        "has_table_privilege($1, 'public.organizations', 'INSERT') AS organizations_insert, " +
        "has_table_privilege($1, 'public.organizations', 'UPDATE') AS organizations_update, " +
        "has_table_privilege($1, 'public.organizations', 'DELETE') AS organizations_delete",
      [runtimeRole]
    );
    assert.deepEqual(grants.rows[0], {
      memberships_delete: false,
      memberships_insert: true,
      memberships_select: true,
      memberships_update: false,
      organizations_delete: false,
      organizations_insert: true,
      organizations_select: true,
      organizations_update: false,
    });

    ({ adminRoleName, membershipAdded: runtimeRoleMembershipAdded } =
      await ensureRuntimeRoleCanBeSet(adminPool, runtimeRole));
    await runtimeClient.connect();
    runtimeClientConnected = true;
    await runtimeClient.query("SET ROLE polaris_pr11_runtime");
    const currentRole = await runtimeClient.query(
      "SELECT current_user AS role"
    );
    assert.equal(currentRole.rows[0]?.role, runtimeRole);
    await runtimeClient.query("BEGIN");
    try {
      const [seedA, seedB] = expectedPocSeeds;
      assert.ok(seedA);
      assert.ok(seedB);
      const seedPocRow = async (seed: (typeof expectedPocSeeds)[number]) => {
        await runtimeClient.query(
          "SELECT set_config('app.organization_id', $1, true)",
          [seed.organization_id]
        );
        await runtimeClient.query(
          "INSERT INTO public.rls_poc_operations (organization_id, token, value) " +
            "VALUES ($1, $2, $3) ON CONFLICT (organization_id, token) DO NOTHING",
          [seed.organization_id, seed.token, seed.value]
        );
      };
      await seedPocRow(seedA);
      await seedPocRow(seedB);
      await runtimeClient.query("COMMIT");
    } catch (error) {
      await runtimeClient.query("ROLLBACK");
      throw error;
    }
    const restoredPocSeeds = await adminPool.query<{
      organization_id: string;
      token: string;
      value: string;
    }>(
      "SELECT organization_id, token, value FROM public.rls_poc_operations " +
        "ORDER BY organization_id"
    );
    assert.deepEqual(restoredPocSeeds.rows, expectedPocSeeds);

    const userA = await createUser("PR22 tenant context A");
    const userB = await createUser("PR22 tenant context B");
    const initialA = await createInitialOrganization(
      userA,
      "PR22 tenant context A"
    );
    const initialB = await createInitialOrganization(
      userB,
      "PR22 tenant context B"
    );
    assert.equal(initialA.created, true);
    assert.equal(initialB.created, true);

    const retryA = await createInitialOrganization(
      userA,
      "Changed retry must not replace the first name"
    );
    assert.equal(retryA.created, false);
    assert.equal(retryA.organization.id, initialA.organization.id);
    assert.equal(retryA.organization.name, initialA.organization.name);

    const contextlessOrganizations = await runtimeClient.query(
      "SELECT id FROM public.organizations"
    );
    const contextlessMemberships = await runtimeClient.query(
      "SELECT organization_id FROM public.memberships"
    );
    assert.deepEqual(contextlessOrganizations.rows, []);
    assert.deepEqual(contextlessMemberships.rows, []);

    const tokenA = `pr22-${randomUUID()}`;
    const tokenB = `pr22-${randomUUID()}`;
    fixtureOperationTokens.push(tokenA, tokenB);
    await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "organization:manage",
        requestedOrganizationId: initialA.organization.id,
      },
      async (transaction) => {
        await transaction.insert(rlsPocOperations).values({
          organizationId: initialA.organization.id,
          token: tokenA,
          value: "tenant-a",
        });
      }
    );
    await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userB,
        capability: "organization:manage",
        requestedOrganizationId: initialB.organization.id,
      },
      async (transaction) => {
        await transaction.insert(rlsPocOperations).values({
          organizationId: initialB.organization.id,
          token: tokenB,
          value: "tenant-b",
        });
      }
    );

    const firstBackend = await runtimeClient.query(
      "SELECT pg_backend_pid() AS pid"
    );
    const visibleA = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "catalog:read",
        requestedOrganizationId: initialA.organization.id,
      },
      async (transaction) => ({
        organizations: await transaction
          .select({ id: organizations.id })
          .from(organizations),
        memberships: await transaction
          .select({
            organizationId: memberships.organizationId,
            userId: memberships.userId,
          })
          .from(memberships),
        otherOrganization: await transaction
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.id, initialB.organization.id)),
        otherMembership: await transaction
          .select({ organizationId: memberships.organizationId })
          .from(memberships)
          .where(eq(memberships.organizationId, initialB.organization.id)),
        ownPocRow: await transaction
          .select({ token: rlsPocOperations.token })
          .from(rlsPocOperations)
          .where(eq(rlsPocOperations.organizationId, initialA.organization.id)),
        otherPocRow: await transaction
          .select({ token: rlsPocOperations.token })
          .from(rlsPocOperations)
          .where(eq(rlsPocOperations.organizationId, initialB.organization.id)),
      })
    );
    assert.deepEqual(visibleA.organizations, [
      { id: initialA.organization.id },
    ]);
    assert.deepEqual(visibleA.memberships, [
      { organizationId: initialA.organization.id, userId: userA },
    ]);
    assert.deepEqual(visibleA.otherOrganization, []);
    assert.deepEqual(visibleA.otherMembership, []);
    assert.deepEqual(visibleA.ownPocRow, [{ token: tokenA }]);
    assert.deepEqual(visibleA.otherPocRow, []);

    await expectTenantAuthorizationError(
      withAuthorizedTenantTransaction(
        runtimeDb,
        {
          authenticatedUserId: userA,
          capability: "catalog:read",
          requestedOrganizationId: initialB.organization.id,
        },
        async () => "must not execute"
      ),
      "tenant_access_denied"
    );
    await expectTenantAuthorizationError(
      withAuthorizedTenantTransaction(
        runtimeDb,
        {
          authenticatedUserId: userA,
          capability: "__proto__",
          requestedOrganizationId: initialA.organization.id,
        },
        async () => "must not execute"
      ),
      "capability_denied"
    );

    const crossTenantToken = `pr22-${randomUUID()}`;
    fixtureOperationTokens.push(crossTenantToken);
    await expectSqlState(
      withAuthorizedTenantTransaction(
        runtimeDb,
        {
          authenticatedUserId: userA,
          capability: "organization:manage",
          requestedOrganizationId: initialA.organization.id,
        },
        async (transaction) => {
          await transaction.insert(rlsPocOperations).values({
            organizationId: initialB.organization.id,
            token: crossTenantToken,
            value: "must be rejected",
          });
        }
      ),
      "42501",
      "cross-tenant POC insert"
    );

    await expectSqlState(
      withAuthorizedTenantTransaction(
        runtimeDb,
        {
          authenticatedUserId: userA,
          capability: "organization:manage",
          requestedOrganizationId: initialA.organization.id,
        },
        async (transaction) => {
          await transaction.insert(organizations).values({
            id: randomUUID(),
            name: "Cross-tenant organization insert",
            timezone: "America/Sao_Paulo",
          });
        }
      ),
      "42501",
      "cross-tenant organization insert"
    );

    await expectSqlState(
      withAuthorizedTenantTransaction(
        runtimeDb,
        {
          authenticatedUserId: userA,
          capability: "organization:manage",
          requestedOrganizationId: initialA.organization.id,
        },
        async (transaction) => {
          await transaction.insert(memberships).values({
            organizationId: initialB.organization.id,
            userId: userA,
          });
        }
      ),
      "42501",
      "cross-tenant membership insert"
    );

    const rollbackToken = `pr22-${randomUUID()}`;
    fixtureOperationTokens.push(rollbackToken);
    await assert.rejects(
      withAuthorizedTenantTransaction(
        runtimeDb,
        {
          authenticatedUserId: userA,
          capability: "organization:manage",
          requestedOrganizationId: initialA.organization.id,
        },
        async (transaction) => {
          await transaction.insert(rlsPocOperations).values({
            organizationId: initialA.organization.id,
            token: rollbackToken,
            value: "must roll back",
          });
          throw new Error("intentional PR22 rollback");
        }
      ),
      rollbackFailurePattern
    );
    const rolledBackOperation = await adminPool.query(
      "SELECT token FROM public.rls_poc_operations " +
        "WHERE organization_id = $1 AND token = $2",
      [initialA.organization.id, rollbackToken]
    );
    assert.deepEqual(rolledBackOperation.rows, []);

    const contextlessPocRows = await runtimeClient.query(
      "SELECT organization_id FROM public.rls_poc_operations"
    );
    assert.deepEqual(contextlessPocRows.rows, []);

    const visibleB = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userB,
        capability: "catalog:read",
        requestedOrganizationId: initialB.organization.id,
      },
      async (transaction) => ({
        organizations: await transaction
          .select({ id: organizations.id })
          .from(organizations),
        memberships: await transaction
          .select({
            organizationId: memberships.organizationId,
            userId: memberships.userId,
          })
          .from(memberships),
        ownPocRow: await transaction
          .select({ token: rlsPocOperations.token })
          .from(rlsPocOperations)
          .where(eq(rlsPocOperations.organizationId, initialB.organization.id)),
        otherPocRow: await transaction
          .select({ token: rlsPocOperations.token })
          .from(rlsPocOperations)
          .where(eq(rlsPocOperations.organizationId, initialA.organization.id)),
      })
    );
    assert.deepEqual(visibleB.organizations, [
      { id: initialB.organization.id },
    ]);
    assert.deepEqual(visibleB.memberships, [
      { organizationId: initialB.organization.id, userId: userB },
    ]);
    assert.deepEqual(visibleB.ownPocRow, [{ token: tokenB }]);
    assert.deepEqual(visibleB.otherPocRow, []);

    const reusedBackend = await runtimeClient.query(
      "SELECT pg_backend_pid() AS pid"
    );
    assert.equal(reusedBackend.rows[0]?.pid, firstBackend.rows[0]?.pid);

    const runtimeDmlPrivileges = await runtimeClient.query<{
      can_delete_memberships: boolean;
      current_user: string;
      session_user: string;
    }>(
      "SELECT current_user AS current_user, session_user AS session_user, " +
        "has_table_privilege(current_user, 'public.memberships', 'DELETE') AS can_delete_memberships"
    );
    assert.equal(runtimeDmlPrivileges.rows[0]?.current_user, runtimeRole);
    assert.equal(runtimeDmlPrivileges.rows[0]?.can_delete_memberships, false);

    await expectSqlState(
      runtimeClient.query(
        "UPDATE public.organizations SET name = 'forbidden' WHERE id = $1",
        [initialA.organization.id]
      ),
      "42501",
      "runtime organization UPDATE"
    );
    await expectNoRowsOrSqlState(
      withAuthorizedTenantTransaction(
        runtimeDb,
        {
          authenticatedUserId: userA,
          capability: "organization:manage",
          requestedOrganizationId: initialA.organization.id,
        },
        async (transaction) => {
          const effectiveRole = await transaction.execute(
            sql`SELECT current_user AS role, has_table_privilege(current_user, 'public.memberships', 'DELETE') AS can_delete_memberships`
          );
          assert.equal(effectiveRole.rows[0]?.role, runtimeRole);
          assert.equal(effectiveRole.rows[0]?.can_delete_memberships, false);
          return await transaction
            .delete(memberships)
            .where(eq(memberships.organizationId, initialA.organization.id))
            .returning({ userId: memberships.userId });
        }
      ),
      "42501",
      "runtime membership DELETE"
    );

    gatePassed = true;
    console.log(
      JSON.stringify({
        status: "passed",
        postgresMajorVersion: 18,
        role: runtimeRole,
        roleBypassRls: false,
        tableOwnerBypass: false,
        rlsTables: ["organizations", "memberships"],
        contextlessReads: "denied",
        ownMembershipAndOrganization: "allowed",
        crossTenantReadsAndWrites: "denied",
        onboardingUnderRls: "passed",
        retryIdempotency: "passed",
        transactionRollback: "passed",
        pooledBackendContextReset: "passed",
        updateAndDeleteGrants: "denied",
      })
    );
  } finally {
    const cleanupErrors: unknown[] = [];
    try {
      if (runtimeClientConnected) {
        await runtimeClient.query("RESET ROLE");
      }
      if (runtimeRoleMembershipAdded && adminRoleName) {
        const revokeSql = `REVOKE "${runtimeRole}" FROM "${adminRoleName}"`;
        await adminPool.query(revokeSql);
        runtimeRoleMembershipAdded = false;
      }
    } catch (error) {
      cleanupErrors.push(error);
    }

    try {
      if (fixtureOperationTokens.length > 0) {
        await adminPool.query(
          "DELETE FROM public.rls_poc_operations WHERE token = ANY($1::text[])",
          [fixtureOperationTokens]
        );
      }
      if (fixtureOrganizationIds.length > 0) {
        await adminPool.query(
          "DELETE FROM public.organizations WHERE id = ANY($1::text[])",
          [fixtureOrganizationIds]
        );
      }
      if (fixtureUserIds.length > 0) {
        await adminPool.query(
          'DELETE FROM public."user" WHERE id = ANY($1::text[])',
          [fixtureUserIds]
        );
      }
    } catch (error) {
      cleanupErrors.push(error);
    }

    const poolsClosed = await Promise.allSettled([
      adminPool.end(),
      runtimeClientConnected ? runtimeClient.end() : Promise.resolve(),
    ]);
    for (const result of poolsClosed) {
      if (result.status === "rejected") {
        cleanupErrors.push(result.reason);
      }
    }

    if (cleanupErrors.length > 0) {
      console.error(
        gatePassed
          ? "The tenant context gate passed, but fixture cleanup failed."
          : "The tenant context gate failed and fixture cleanup was incomplete."
      );
      process.exitCode = 1;
    }
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? `Tenant context gate failed: ${error.message}`
      : "Tenant context gate failed."
  );
  process.exitCode = 1;
});
