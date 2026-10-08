import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { createCategory, listCategories } from "../src/category-repository";
import { createDatabase } from "../src/client";
import { createInitialOrganizationInDatabase } from "../src/organization-repository";
import { categories } from "../src/schema/category";
import { withAuthorizedTenantTransaction } from "../src/tenant-transaction";

const runtimeRole = "polaris_pr11_runtime";
const onboardingRole = "polaris_onboarding_runtime";
const expectedHost = /^ep-[a-z-]+-[a-z0-9]+\.c-2\.sa-east-1\.aws\.neon\.tech$/;
const sqlIdentifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const rollbackMessagePattern = /intentional Gate 2 rollback/;
const sqlStatePattern = /^[0-9A-Z]{5}$/;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error("Missing Gate 2 database configuration.");
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

async function ensureSetRole(
  pool: ReturnType<typeof createDatabase>["pool"],
  roleName: string
): Promise<{ adminRole: string; canSet: boolean }> {
  const result = await pool.query<{
    adminRole: string;
    canSet: boolean;
  }>(
    'SELECT current_user AS "adminRole", ' +
      "pg_has_role(current_user, $1, 'SET') AS \"canSet\"",
    [roleName]
  );
  const [row] = result.rows;
  assert.ok(row);
  assert.match(row.adminRole, sqlIdentifierPattern);
  return { adminRole: row.adminRole, canSet: row.canSet };
}

async function expectForgedCategoryInsertDenied(
  client: Client,
  userId: string,
  organizationId: string
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(
      "SELECT set_config('app.user_id', $1, true), " +
        "set_config('app.organization_id', $2, true)",
      [userId, organizationId]
    );
    await expectSqlState(
      client.query(
        "INSERT INTO public.categories (organization_id, name) VALUES ($1, $2)",
        [organizationId, "forged category"]
      ),
      "42501",
      "category insert with forged context"
    );
  } finally {
    await client.query("ROLLBACK");
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This gate is a sequential checklist of independent database invariants.
async function main() {
  const connectionString = requiredEnvironment(
    "POLARIS_GATE2_TEST_DATABASE_URL"
  );
  const expectedHostname = requiredEnvironment(
    "POLARIS_GATE2_TEST_EXPECTED_HOSTNAME"
  );
  if (
    process.env.POLARIS_GATE2_TEST_CONFIRM_DISPOSABLE !== "gate2-runtime-proof"
  ) {
    throw new Error(
      "Set POLARIS_GATE2_TEST_CONFIRM_DISPOSABLE=gate2-runtime-proof only for the auto-expiring disposable Neon branch."
    );
  }
  const databaseUrl = new URL(connectionString);
  assert.equal(databaseUrl.hostname, expectedHostname);
  assert.equal(databaseUrl.pathname, "/neondb");
  assert.equal(databaseUrl.hostname.includes("-pooler"), false);
  assert.match(databaseUrl.hostname, expectedHost);

  const { db: adminDb, pool: adminPool } = createDatabase(connectionString, {
    maxConnections: 3,
  });
  const runtimeClient = new Client({
    connectionString,
    connectionTimeoutMillis: 5000,
  });
  const runtimeDb = drizzle({ client: runtimeClient }) as unknown as ReturnType<
    typeof createDatabase
  >["db"];
  const fixtureUsers: string[] = [];
  const fixtureOrganizations: string[] = [];
  let connected = false;
  let adminRole: string | undefined;
  let grantedRuntimeRole = false;
  let grantedOnboardingRole = false;
  let passed = false;

  async function createUser(
    name: string,
    emailVerified = true
  ): Promise<string> {
    const id = randomUUID();
    fixtureUsers.push(id);
    await adminPool.query(
      'INSERT INTO public."user" (id, name, email, email_verified) VALUES ($1, $2, $3, $4)',
      [id, name, `gate2-${id}@example.invalid`, emailVerified]
    );
    return id;
  }

  async function createOrganization(userId: string, name: string) {
    const result = await createInitialOrganizationInDatabase(adminDb, {
      id: randomUUID(),
      name,
      requestId: randomUUID(),
      timezone: "America/Sao_Paulo",
      userId,
    });
    fixtureOrganizations.push(result.organization.id);
    return result;
  }

  try {
    const server = await adminPool.query<{
      database: string;
      version: string;
      owner: string;
      ownerBypassRls: boolean;
    }>(
      "SELECT current_database() AS database, " +
        "current_setting('server_version') AS version, " +
        "current_user AS owner, " +
        '(SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS "ownerBypassRls"'
    );
    assert.equal(server.rows[0]?.database, "neondb");
    assert.equal(
      Number.parseInt(server.rows[0]?.version.split(".")[0] ?? "", 10),
      18
    );
    assert.equal(server.rows[0]?.ownerBypassRls, true);
    const ownerName = server.rows[0]?.owner;
    assert.ok(ownerName);

    const roleState = await adminPool.query<{
      roleName: string;
      bypassRls: boolean;
      canLogin: boolean;
    }>(
      'SELECT rolname AS "roleName", rolbypassrls AS "bypassRls", ' +
        'rolcanlogin AS "canLogin" FROM pg_roles ' +
        "WHERE rolname = ANY($1::text[]) ORDER BY rolname",
      [[onboardingRole, runtimeRole]]
    );
    assert.deepEqual(
      roleState.rows.map((role) => [
        role.roleName,
        role.bypassRls,
        role.canLogin,
      ]),
      [
        [onboardingRole, false, false],
        [runtimeRole, false, true],
      ]
    );

    const rls = await adminPool.query<{
      name: string;
      enabled: boolean;
      forced: boolean;
      owner: string;
    }>(
      "SELECT c.relname AS name, c.relrowsecurity AS enabled, " +
        "c.relforcerowsecurity AS forced, pg_get_userbyid(c.relowner) AS owner " +
        "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
        "WHERE n.nspname = 'public' AND c.relname = ANY($1::text[]) " +
        "ORDER BY c.relname",
      [["categories", "memberships", "organizations", "tenant_audit_event"]]
    );
    assert.deepEqual(
      rls.rows.map((table) => [table.name, table.enabled, table.forced]),
      [
        ["categories", true, true],
        ["memberships", true, true],
        ["organizations", true, true],
        ["tenant_audit_event", true, true],
      ]
    );
    assert.ok(rls.rows.every((table) => table.owner === ownerName));
    assert.ok(rls.rows.every((table) => table.owner !== runtimeRole));
    assert.ok(rls.rows.every((table) => table.owner !== onboardingRole));

    const categoryPolicies = await adminPool.query<{
      name: string;
      command: string;
      roles: string;
      usingExpression: string | null;
      withCheck: string | null;
    }>(
      "SELECT policyname AS name, cmd AS command, roles, " +
        'qual AS "usingExpression", with_check AS "withCheck" ' +
        "FROM pg_policies WHERE schemaname = 'public' AND tablename = 'categories' " +
        "ORDER BY policyname"
    );
    assert.deepEqual(
      categoryPolicies.rows.map((policy) => policy.name),
      ["categories_current_tenant_insert", "categories_current_tenant_select"]
    );
    assert.ok(
      categoryPolicies.rows.every(
        (policy) => policy.roles === `{${runtimeRole}}`
      )
    );
    assert.equal(categoryPolicies.rows[0]?.command, "INSERT");
    assert.ok(categoryPolicies.rows[0]?.withCheck?.includes("app.user_id"));
    assert.ok(
      categoryPolicies.rows[0]?.withCheck?.includes("app.organization_id")
    );
    assert.equal(categoryPolicies.rows[1]?.command, "SELECT");
    assert.ok(
      categoryPolicies.rows[1]?.usingExpression?.includes("app.user_id")
    );
    assert.ok(
      categoryPolicies.rows[1]?.usingExpression?.includes("app.organization_id")
    );

    const grants = await adminPool.query<{
      categorySelect: boolean;
      categoryInsert: boolean;
      categoryUpdate: boolean;
      categoryDelete: boolean;
      organizationInsert: boolean;
      membershipInsert: boolean;
    }>(
      "SELECT has_table_privilege($1, 'public.categories', 'SELECT') AS \"categorySelect\", " +
        "has_table_privilege($1, 'public.categories', 'INSERT') AS \"categoryInsert\", " +
        "has_table_privilege($1, 'public.categories', 'UPDATE') AS \"categoryUpdate\", " +
        "has_table_privilege($1, 'public.categories', 'DELETE') AS \"categoryDelete\", " +
        "has_table_privilege($1, 'public.organizations', 'INSERT') AS \"organizationInsert\", " +
        "has_table_privilege($1, 'public.memberships', 'INSERT') AS \"membershipInsert\"",
      [runtimeRole]
    );
    assert.deepEqual(grants.rows[0], {
      categoryDelete: false,
      categoryInsert: true,
      categorySelect: true,
      categoryUpdate: false,
      membershipInsert: false,
      organizationInsert: false,
    });

    const functionAccess = await adminPool.query<{
      runtimeCanExecute: boolean;
      onboardingCanExecute: boolean;
      publicCanExecute: boolean;
      securityDefiner: boolean;
      owner: string;
      config: string[] | null;
    }>(
      "SELECT has_function_privilege($1, " +
        "'public.create_initial_organization(text,text,text,text,uuid)', 'EXECUTE') AS \"runtimeCanExecute\", " +
        "has_function_privilege($2, " +
        "'public.create_initial_organization(text,text,text,text,uuid)', 'EXECUTE') AS \"onboardingCanExecute\", " +
        "EXISTS (SELECT 1 FROM pg_catalog.aclexplode(" +
        "COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS acl " +
        "WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE') AS \"publicCanExecute\", " +
        'p.prosecdef AS "securityDefiner", ' +
        "pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config " +
        "FROM pg_catalog.pg_proc p " +
        "WHERE p.oid = 'public.create_initial_organization(text,text,text,text,uuid)'::regprocedure",
      [runtimeRole, onboardingRole]
    );
    assert.deepEqual(functionAccess.rows[0], {
      config: ["search_path=pg_catalog, pg_temp"],
      onboardingCanExecute: true,
      owner: ownerName,
      publicCanExecute: false,
      runtimeCanExecute: false,
      securityDefiner: true,
    });

    const runtimeSet = await ensureSetRole(adminPool, runtimeRole);
    ({ adminRole } = runtimeSet);
    if (!runtimeSet.canSet) {
      grantedRuntimeRole = true;
      await adminPool.query(`GRANT ${runtimeRole} TO ${adminRole}`);
    }
    const onboardingSet = await ensureSetRole(adminPool, onboardingRole);
    if (!onboardingSet.canSet) {
      grantedOnboardingRole = true;
      await adminPool.query(
        `GRANT ${onboardingRole} TO ${onboardingSet.adminRole}`
      );
    }

    await runtimeClient.connect();
    connected = true;
    await runtimeClient.query(`SET ROLE ${runtimeRole}`);

    const userA = await createUser("Gate 2 tenant A");
    const userB = await createUser("Gate 2 tenant B");
    const unverifiedUser = await createUser("Gate 2 unverified", false);
    const organizationA = await createOrganization(userA, "Gate 2 tenant A");
    const organizationB = await createOrganization(userB, "Gate 2 tenant B");
    assert.equal(organizationA.created, true);
    assert.equal(organizationB.created, true);

    const onboardingUser = await createUser("Gate 2 onboarding writer");
    const onboardingOrganizationId = randomUUID();
    fixtureOrganizations.push(onboardingOrganizationId);
    await expectSqlState(
      runtimeClient.query(
        "SELECT * FROM public.create_initial_organization($1, $2, $3, $4, $5)",
        [
          onboardingUser,
          randomUUID(),
          "Runtime role must not call the writer",
          "America/Sao_Paulo",
          randomUUID(),
        ]
      ),
      "42501",
      "the tenant role cannot execute the onboarding writer"
    );

    await runtimeClient.query("RESET ROLE");
    await runtimeClient.query(`SET ROLE ${onboardingRole}`);
    const onboardingRequestId = randomUUID();
    const onboardingResult = await runtimeClient.query<{
      created: boolean;
      id: string;
      name: string;
      timezone: string;
      currency: string;
      status: string;
    }>("SELECT * FROM public.create_initial_organization($1, $2, $3, $4, $5)", [
      onboardingUser,
      onboardingOrganizationId,
      "Runtime onboarding",
      "America/Sao_Paulo",
      onboardingRequestId,
    ]);
    assert.equal(onboardingResult.rows[0]?.created, true);
    assert.equal(onboardingResult.rows[0]?.id, onboardingOrganizationId);
    assert.equal(onboardingResult.rows[0]?.name, "Runtime onboarding");
    assert.equal(onboardingResult.rows[0]?.status, "active");

    const retry = await runtimeClient.query<{
      created: boolean;
      id: string;
      name: string;
    }>(
      "SELECT created, id, name FROM public.create_initial_organization($1, $2, $3, $4, $5)",
      [
        onboardingUser,
        randomUUID(),
        "Retry must not mutate existing organization",
        "Etc/UTC",
        randomUUID(),
      ]
    );
    assert.deepEqual(retry.rows[0], {
      created: false,
      id: onboardingOrganizationId,
      name: "Runtime onboarding",
    });

    await expectSqlState(
      runtimeClient.query(
        "SELECT * FROM public.create_initial_organization($1, $2, $3, $4, $5)",
        [
          unverifiedUser,
          randomUUID(),
          "Must be rejected",
          "America/Sao_Paulo",
          randomUUID(),
        ]
      ),
      "P0001",
      "unverified onboarding user is rejected"
    );
    await expectSqlState(
      runtimeClient.query(
        "INSERT INTO public.organizations (id, name, timezone) VALUES ($1, $2, $3)",
        [randomUUID(), "Direct write forbidden", "Etc/UTC"]
      ),
      "42501",
      "the onboarding role has no direct table DML"
    );
    await runtimeClient.query("RESET ROLE");
    await runtimeClient.query(`SET ROLE ${runtimeRole}`);

    const onboardingMembership = await adminPool.query(
      "SELECT organization_id FROM public.memberships WHERE user_id = $1",
      [onboardingUser]
    );
    assert.deepEqual(onboardingMembership.rows, [
      { organization_id: onboardingOrganizationId },
    ]);
    const onboardingAudit = await adminPool.query(
      "SELECT organization_id, actor_user_id, event_type, entity_type, entity_id, request_id " +
        "FROM public.tenant_audit_event WHERE event_type = 'organization.created' " +
        "AND entity_id = $1",
      [onboardingOrganizationId]
    );
    assert.deepEqual(onboardingAudit.rows, [
      {
        actor_user_id: onboardingUser,
        entity_id: onboardingOrganizationId,
        entity_type: "organization",
        event_type: "organization.created",
        organization_id: onboardingOrganizationId,
        request_id: onboardingRequestId,
      },
    ]);

    const contextlessCategories = await runtimeClient.query(
      "SELECT id FROM public.categories"
    );
    assert.deepEqual(contextlessCategories.rows, []);

    const categoryA = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "category:create",
        requestedOrganizationId: organizationA.organization.id,
      },
      (transaction, identity) =>
        createCategory(transaction, identity, {
          name: "  Escritório  ",
          requestId: randomUUID(),
        })
    );
    const categoryB = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userB,
        capability: "category:create",
        requestedOrganizationId: organizationB.organization.id,
      },
      (transaction, identity) =>
        createCategory(transaction, identity, {
          name: "Outro",
          requestId: randomUUID(),
        })
    );
    assert.equal(categoryA.name, "Escritório");

    const visibleA = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "catalog:read",
        requestedOrganizationId: organizationA.organization.id,
      },
      async (transaction, identity) => ({
        categories: await listCategories(transaction, identity),
        otherTenantRows: await transaction
          .select({ id: categories.id })
          .from(categories)
          .where(eq(categories.organizationId, organizationB.organization.id)),
      })
    );
    assert.deepEqual(visibleA.categories, [categoryA]);
    assert.deepEqual(visibleA.otherTenantRows, []);

    await expectForgedCategoryInsertDenied(
      runtimeClient,
      userA,
      organizationB.organization.id
    );

    let rolledBackCategoryId: string | undefined;
    await assert.rejects(
      withAuthorizedTenantTransaction(
        runtimeDb,
        {
          authenticatedUserId: userA,
          capability: "category:create",
          requestedOrganizationId: organizationA.organization.id,
        },
        async (transaction, identity) => {
          const category = await createCategory(transaction, identity, {
            name: "Rollback",
            requestId: randomUUID(),
          });
          rolledBackCategoryId = category.id;
          throw new Error("intentional Gate 2 rollback");
        }
      ),
      rollbackMessagePattern
    );
    assert.ok(rolledBackCategoryId);
    assert.deepEqual(
      (
        await adminPool.query(
          "SELECT id FROM public.categories WHERE id = $1",
          [rolledBackCategoryId]
        )
      ).rows,
      []
    );
    assert.deepEqual(
      (
        await adminPool.query(
          "SELECT id FROM public.tenant_audit_event WHERE entity_id = $1",
          [rolledBackCategoryId]
        )
      ).rows,
      []
    );

    const categoryAudit = await adminPool.query(
      "SELECT entity_id, actor_user_id, organization_id " +
        "FROM public.tenant_audit_event WHERE event_type = 'category.created' " +
        "AND entity_id = ANY($1::text[])",
      [[categoryA.id, categoryB.id]]
    );
    assert.equal(categoryAudit.rows.length, 2);

    await adminPool.query("DELETE FROM public.organizations WHERE id = $1", [
      organizationB.organization.id,
    ]);
    fixtureOrganizations.splice(
      fixtureOrganizations.indexOf(organizationB.organization.id),
      1
    );
    assert.deepEqual(
      (
        await adminPool.query(
          "SELECT id FROM public.categories WHERE id = $1",
          [categoryB.id]
        )
      ).rows,
      []
    );
    assert.deepEqual(
      (
        await adminPool.query(
          "SELECT id FROM public.tenant_audit_event WHERE entity_id = $1",
          [categoryB.id]
        )
      ).rows,
      []
    );

    passed = true;
    console.log(
      JSON.stringify({
        categoryIsolationAndAudit: "passed",
        directOnboardingDml: "denied",
        onboardingAtomicRetryAndAudit: "passed",
        onboardingRole,
        onboardingRoleCanExecuteOnboarding: true,
        postgresMajorVersion: 18,
        postgresServerVersion: server.rows[0]?.version,
        publicExecute: false,
        rlsTables: [
          "categories",
          "memberships",
          "organizations",
          "tenant_audit_event",
        ],
        rollbackAndCascade: "passed",
        status: "passed",
        tenantRole: runtimeRole,
        tenantRoleCanExecuteOnboarding: false,
      })
    );
  } finally {
    const cleanupErrors: unknown[] = [];
    if (connected) {
      try {
        await runtimeClient.query("RESET ROLE");
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (adminRole && grantedRuntimeRole) {
      try {
        await adminPool.query(`REVOKE ${runtimeRole} FROM ${adminRole}`);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (adminRole && grantedOnboardingRole) {
      try {
        await adminPool.query(`REVOKE ${onboardingRole} FROM ${adminRole}`);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    const organizationCleanup = await Promise.allSettled(
      fixtureOrganizations.map((organizationId) =>
        adminPool.query("DELETE FROM public.organizations WHERE id = $1", [
          organizationId,
        ])
      )
    );
    for (const result of organizationCleanup) {
      if (result.status === "rejected") {
        cleanupErrors.push(result.reason);
      }
    }
    const userCleanup = await Promise.allSettled(
      fixtureUsers.map((userId) =>
        adminPool.query('DELETE FROM public."user" WHERE id = $1', [userId])
      )
    );
    for (const result of userCleanup) {
      if (result.status === "rejected") {
        cleanupErrors.push(result.reason);
      }
    }
    await Promise.allSettled([
      connected ? runtimeClient.end() : Promise.resolve(),
      adminPool.end(),
    ]);
    if (cleanupErrors.length > 0) {
      process.exitCode = 1;
      console.error("gate2_database_cleanup=failed", cleanupErrors.length);
    }
    if (!passed) {
      console.error("gate2_runtime=failed");
    }
  }
}

main().catch((error: unknown) => {
  const connectionString = process.env.POLARIS_GATE2_TEST_DATABASE_URL ?? "";
  const message = error instanceof Error ? error.message : "unknown error";
  console.error(
    "gate2_runtime=failed",
    error instanceof Error ? error.name : "UnknownError",
    message.replaceAll(connectionString, "[redacted]")
  );
  process.exitCode = 1;
});
