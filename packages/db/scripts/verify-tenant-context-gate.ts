import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { createDatabase } from "../src/client";
import {
  type CreateInitialOrganizationInDatabaseResult,
  createInitialOrganizationInDatabase,
} from "../src/organization-repository";
import { memberships, organizations } from "../src/schema/organization";
import { rlsPocOperations } from "../src/schema/rls-poc";
import { tenantAuditEvents } from "../src/schema/tenant-audit";
import { recordTenantAuditEvent } from "../src/tenant-audit";
import {
  TenantAuthorizationError,
  withAuthorizedTenantTransaction,
} from "../src/tenant-transaction";
import { assertAllowedGateUrl, disposableHostPattern } from "./gate-hosts";
import { deleteOrganizationsWithAudit } from "./teardown-support";

const gateDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

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
const rollbackFailurePattern = /intentional PR23 rollback/;
const sqlIdentifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
async function expectForgedGucInsertDenied(
  runtimeClient: Client,
  userId: string,
  organizationId: string,
  insertSql: string,
  values: string[],
  operationName: string
): Promise<void> {
  await runtimeClient.query("BEGIN");
  try {
    await runtimeClient.query(
      "SELECT set_config('app.user_id', $1, true), " +
        "set_config('app.organization_id', $2, true)",
      [userId, organizationId]
    );
    await expectSqlState(
      runtimeClient.query(insertSql, values),
      "42501",
      operationName
    );
  } finally {
    await runtimeClient.query("ROLLBACK");
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
): Promise<{ adminRoleName: string; canSetRuntimeRole: boolean }> {
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
  return {
    adminRoleName: adminRole.admin_role,
    canSetRuntimeRole: adminRole.can_set_runtime_role,
  };
}

async function cleanupTemporaryRuntimeRole(input: {
  adminPool: ReturnType<typeof createDatabase>["pool"];
  adminRoleName: string | undefined;
  runtimeClient: Client;
  runtimeClientConnected: boolean;
  runtimeRoleName: string;
  runtimeRoleMembershipGrantAttempted: boolean;
}): Promise<unknown[]> {
  const errors: unknown[] = [];
  if (input.runtimeClientConnected) {
    try {
      await input.runtimeClient.query("RESET ROLE");
    } catch (error) {
      errors.push(error);
    }
  }
  if (input.runtimeRoleMembershipGrantAttempted && input.adminRoleName) {
    try {
      await input.adminPool.query(
        `REVOKE "${input.runtimeRoleName}" FROM "${input.adminRoleName}"`
      );
      const roleMembership = await input.adminPool.query<{
        can_set_runtime_role: boolean;
      }>(
        "SELECT pg_has_role(current_user, $1, 'SET') AS can_set_runtime_role",
        [input.runtimeRoleName]
      );
      assert.equal(roleMembership.rows[0]?.can_set_runtime_role, false);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}
async function cleanupTenantFixtures(input: {
  adminPool: ReturnType<typeof createDatabase>["pool"];
  fixtureOperationTokens: string[];
  fixtureOrganizationIds: string[];
  fixtureUserIds: string[];
}): Promise<unknown[]> {
  const errors: unknown[] = [];
  if (input.fixtureOperationTokens.length > 0) {
    try {
      await input.adminPool.query(
        "DELETE FROM public.rls_poc_operations WHERE token = ANY($1::text[])",
        [input.fixtureOperationTokens]
      );
    } catch (error) {
      errors.push(error);
    }
  }
  if (input.fixtureOrganizationIds.length > 0) {
    try {
      await deleteOrganizationsWithAudit(
        input.adminPool,
        input.fixtureOrganizationIds
      );
    } catch (error) {
      errors.push(error);
    }
    try {
      const remainingAuditEvents = await input.adminPool.query(
        "SELECT id FROM public.tenant_audit_event " +
          "WHERE organization_id = ANY($1::text[])",
        [input.fixtureOrganizationIds]
      );
      assert.deepEqual(remainingAuditEvents.rows, []);
    } catch (error) {
      errors.push(error);
    }
  }
  if (input.fixtureUserIds.length > 0) {
    try {
      await input.adminPool.query(
        'DELETE FROM public."user" WHERE id = ANY($1::text[])',
        [input.fixtureUserIds]
      );
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
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
    databaseUrl = assertAllowedGateUrl(connectionString);
  } catch (error) {
    throw new Error(
      "The tenant context gate requires a valid direct Neon URL.",
      {
        cause: error,
      }
    );
  }
  assert.equal(databaseUrl.hostname, expectedHostname);
  assert.equal(databaseUrl.pathname, `/${gateDatabase}`);
  assert.equal(databaseUrl.hostname.includes("-pooler"), false);
  assert.match(databaseUrl.hostname, disposableHostPattern);

  const { db: adminDatabase, pool: adminPool } = createDatabase(
    connectionString,
    {
      maxConnections: 2,
    }
  );
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
  let runtimeRoleMembershipGrantAttempted = false;

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
    const result = await createInitialOrganizationInDatabase(adminDatabase, {
      id: randomUUID(),
      name,
      requestId: randomUUID(),
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
    assert.equal(databaseIdentity.rows[0]?.database, gateDatabase);
    const postgresServerVersion = databaseIdentity.rows[0]?.server_version;
    assert.ok(postgresServerVersion);
    assert.equal(
      Number.parseInt(postgresServerVersion.split(".")[0] ?? "", 10),
      18,
      "The tenant context gate requires PostgreSQL 18."
    );
    const adminRoleResult = await adminPool.query<{
      admin_role: string;
      bypass_rls: boolean;
    }>(
      "SELECT current_user AS admin_role, rolbypassrls AS bypass_rls " +
        "FROM pg_roles WHERE rolname = current_user"
    );
    const [adminRole] = adminRoleResult.rows;
    assert.ok(adminRole);
    assert.notEqual(adminRole.admin_role, runtimeRole);
    assert.equal(
      adminRole.bypass_rls,
      true,
      "The disposable gate requires its privileged Neon owner connection."
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
      [["organizations", "memberships", "tenant_audit_event"]]
    );
    assert.equal(tableOwners.rows.length, 3);
    assert.equal(
      tableOwners.rows.some((row) => row.owner === runtimeRole),
      false
    );
    assert.ok(
      tableOwners.rows.every((row) => row.owner === adminRole.admin_role),
      "The privileged gate connection must own all RLS tables."
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
      [["memberships", "organizations", "tenant_audit_event"]]
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
        ["tenant_audit_event", true, true],
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
        "AND tablename = ANY($1::text[]) AND roles NOT IN ('{polaris_catalog_owner}', '{polaris_admin_owner}', '{polaris_privacy_owner}', '{polaris_purge_owner}', '{polaris_retention_owner}', '{polaris_closed_export_reader}', '{polaris_notice_recipient_owner}', '{polaris_unverified_user_owner}', '{polaris_authorization_epoch_owner}', '{polaris_onboarding_owner}', '{polaris_billing_audit_owner}') ORDER BY tablename, policyname",
      [["memberships", "organizations", "tenant_audit_event"]]
    );
    assert.deepEqual(
      policies.rows.map((policy) => policy.policy_name),
      [
        "memberships_current_user_select",
        "organizations_active_tenant_select",
        "tenant_audit_event_current_actor_insert",
      ]
    );
    assert.ok(
      policies.rows.every((policy) => policy.roles === `{${runtimeRole}}`)
    );
    const organizationReadPolicy = policies.rows.find(
      (policy) => policy.policy_name === "organizations_active_tenant_select"
    );
    assert.ok(organizationReadPolicy?.using_expression?.includes("active"));
    const tenantAuditInsertPolicy = policies.rows.find(
      (policy) =>
        policy.policy_name === "tenant_audit_event_current_actor_insert"
    );
    assert.equal(tenantAuditInsertPolicy?.command, "INSERT");
    assert.ok(tenantAuditInsertPolicy?.with_check?.includes("app.user_id"));
    assert.ok(
      tenantAuditInsertPolicy?.with_check?.includes("app.organization_id")
    );
    assert.ok(tenantAuditInsertPolicy?.with_check?.includes("active"));
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
      memberships_insert: false,
      memberships_select: true,
      memberships_update: false,
      organizations_delete: false,
      organizations_insert: false,
      organizations_select: true,
      organizations_update: false,
    });
    const tenantAuditGrants = await adminPool.query<{
      can_delete: boolean;
      can_insert: boolean;
      can_select: boolean;
      can_update: boolean;
    }>(
      "SELECT has_table_privilege($1, 'public.tenant_audit_event', 'SELECT') AS can_select, " +
        "has_table_privilege($1, 'public.tenant_audit_event', 'INSERT') AS can_insert, " +
        "has_table_privilege($1, 'public.tenant_audit_event', 'UPDATE') AS can_update, " +
        "has_table_privilege($1, 'public.tenant_audit_event', 'DELETE') AS can_delete",
      [runtimeRole]
    );
    assert.deepEqual(tenantAuditGrants.rows[0], {
      can_delete: false,
      can_insert: true,
      can_select: false,
      can_update: false,
    });
    const { adminRoleName: resolvedAdminRoleName, canSetRuntimeRole } =
      await ensureRuntimeRoleCanBeSet(adminPool, runtimeRole);
    adminRoleName = resolvedAdminRoleName;
    if (!canSetRuntimeRole) {
      runtimeRoleMembershipGrantAttempted = true;
      await adminPool.query(`GRANT "${runtimeRole}" TO "${adminRoleName}"`);
    }
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

    const onboardingAuditEvents = await adminPool.query<{
      actor_user_id: string;
      entity_id: string;
      entity_type: string;
      event_type: string;
      organization_id: string;
      request_id: string | null;
    }>(
      "SELECT organization_id, actor_user_id, event_type, entity_type, entity_id, request_id " +
        "FROM public.tenant_audit_event " +
        "WHERE event_type = 'organization.created' AND entity_id = ANY($1::text[]) " +
        "ORDER BY entity_id",
      [[initialA.organization.id, initialB.organization.id]]
    );
    const expectedOnboardingAuditEvents = [
      {
        actor_user_id: userA,
        entity_id: initialA.organization.id,
        entity_type: "organization",
        event_type: "organization.created",
        organization_id: initialA.organization.id,
      },
      {
        actor_user_id: userB,
        entity_id: initialB.organization.id,
        entity_type: "organization",
        event_type: "organization.created",
        organization_id: initialB.organization.id,
      },
    ].sort((left, right) => left.entity_id.localeCompare(right.entity_id));
    assert.equal(onboardingAuditEvents.rows.length, 2);
    assert.deepEqual(
      onboardingAuditEvents.rows.map(
        ({ request_id: _requestId, ...event }) => event
      ),
      expectedOnboardingAuditEvents
    );
    assert.ok(onboardingAuditEvents.rows.every((event) => event.request_id));
    const forgedOrganizationId = randomUUID();
    await expectForgedGucInsertDenied(
      runtimeClient,
      userA,
      initialB.organization.id,
      "INSERT INTO public.memberships (organization_id, user_id, role, status) " +
        "VALUES ($1, $2, 'owner', 'active')",
      [initialB.organization.id, userA],
      "runtime membership INSERT with forged GUCs"
    );
    await expectForgedGucInsertDenied(
      runtimeClient,
      userA,
      forgedOrganizationId,
      "INSERT INTO public.organizations (id, name, timezone) " +
        "VALUES ($1, $2, $3)",
      [forgedOrganizationId, "Forged organization", "America/Sao_Paulo"],
      "runtime organization INSERT with forged GUCs"
    );
    const contextlessOrganizations = await runtimeClient.query(
      "SELECT id FROM public.organizations"
    );
    const contextlessMemberships = await runtimeClient.query(
      "SELECT organization_id FROM public.memberships"
    );
    assert.deepEqual(contextlessOrganizations.rows, []);
    assert.deepEqual(contextlessMemberships.rows, []);
    await expectSqlState(
      runtimeClient.query("SELECT id FROM public.tenant_audit_event"),
      "42501",
      "runtime tenant audit SELECT"
    );
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

    const auditMutationToken = randomUUID();
    const auditRequestId = randomUUID();
    fixtureOperationTokens.push(auditMutationToken);
    await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "organization:manage",
        requestedOrganizationId: initialA.organization.id,
      },
      async (transaction, identity) => {
        await transaction.insert(rlsPocOperations).values({
          organizationId: initialA.organization.id,
          token: auditMutationToken,
          value: "mutation and audit commit together",
        });
        await recordTenantAuditEvent(transaction, identity, {
          entityId: auditMutationToken,
          entityType: "rls_poc_operation",
          eventType: "category.created",
          requestId: auditRequestId,
        });
      }
    );
    const committedAuditEvent = await adminPool.query<{
      actor_user_id: string;
      entity_id: string;
      organization_id: string;
      request_id: string | null;
    }>(
      "SELECT actor_user_id, entity_id, organization_id, request_id " +
        "FROM public.tenant_audit_event WHERE event_type = $1 AND entity_id = $2",
      ["category.created", auditMutationToken]
    );
    assert.deepEqual(committedAuditEvent.rows, [
      {
        actor_user_id: userA,
        entity_id: auditMutationToken,
        organization_id: initialA.organization.id,
        request_id: auditRequestId,
      },
    ]);
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
        memberships: await transaction
          .select({
            organizationId: memberships.organizationId,
            userId: memberships.userId,
          })
          .from(memberships),
        organizations: await transaction
          .select({ id: organizations.id })
          .from(organizations),
        otherMembership: await transaction
          .select({ organizationId: memberships.organizationId })
          .from(memberships)
          .where(eq(memberships.organizationId, initialB.organization.id)),
        otherOrganization: await transaction
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.id, initialB.organization.id)),
        otherPocRow: await transaction
          .select({ token: rlsPocOperations.token })
          .from(rlsPocOperations)
          .where(eq(rlsPocOperations.organizationId, initialB.organization.id)),
        ownPocRow: await transaction
          .select({ token: rlsPocOperations.token })
          .from(rlsPocOperations)
          .where(eq(rlsPocOperations.token, tokenA)),
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

    const crossTenantAuditToken = randomUUID();
    const invalidAuditEntityId = "owner@example.invalid";
    await expectSqlState(
      withAuthorizedTenantTransaction(
        runtimeDb,
        {
          authenticatedUserId: userA,
          capability: "organization:manage",
          requestedOrganizationId: initialA.organization.id,
        },
        async (transaction) => {
          await transaction.insert(tenantAuditEvents).values({
            actorUserId: userA,
            entityId: invalidAuditEntityId,
            entityType: "rls_poc_operation",
            eventType: "category.archived",
            organizationId: initialA.organization.id,
          });
        }
      ),
      "23514",
      "tenant audit entity ID format check"
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
          await transaction.insert(tenantAuditEvents).values({
            actorUserId: userA,
            entityId: crossTenantAuditToken,
            entityType: "rls_poc_operation",
            eventType: "category.deleted",
            organizationId: initialB.organization.id,
          });
        }
      ),
      "42501",
      "cross-tenant tenant audit INSERT"
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
    const rollbackToken = randomUUID();
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
          await recordTenantAuditEvent(
            transaction,
            { organizationId: initialA.organization.id, userId: userA },
            {
              entityId: rollbackToken,
              entityType: "rls_poc_operation",
              eventType: "category.renamed",
              requestId: randomUUID(),
            }
          );
          throw new Error("intentional PR23 rollback");
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

    const rolledBackAuditEvent = await adminPool.query(
      "SELECT id FROM public.tenant_audit_event " +
        "WHERE event_type = $1 AND entity_id = $2",
      ["category.renamed", rollbackToken]
    );
    assert.deepEqual(rolledBackAuditEvent.rows, []);

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
        memberships: await transaction
          .select({
            organizationId: memberships.organizationId,
            userId: memberships.userId,
          })
          .from(memberships),
        organizations: await transaction
          .select({ id: organizations.id })
          .from(organizations),
        otherPocRow: await transaction
          .select({ token: rlsPocOperations.token })
          .from(rlsPocOperations)
          .where(eq(rlsPocOperations.organizationId, initialA.organization.id)),
        ownPocRow: await transaction
          .select({ token: rlsPocOperations.token })
          .from(rlsPocOperations)
          .where(eq(rlsPocOperations.organizationId, initialB.organization.id)),
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
        adminRoleBypassRls: adminRole.bypass_rls,
        contextlessReads: "denied",
        crossTenantReadsAndWrites: "denied",
        onboardingOwnerOnly: "passed",
        ownMembershipAndOrganization: "allowed",
        pooledBackendContextReset: "passed",
        postgresMajorVersion: 18,
        postgresServerVersion,
        retryIdempotency: "passed",
        rlsTables: ["organizations", "memberships", "tenant_audit_event"],
        role: runtimeRole,
        roleBypassRls: false,
        runtimeOrganizationAndMembershipInsert: "denied_even_with_forged_gucs",
        runtimeRoleOwnsRlsTables: false,
        status: "passed",
        tenantAudit: {
          authorizedInsert: "passed",
          crossTenantInsert: "denied",
          insertOnlyGrant: "passed",
          onboardingEventSameTransaction: "passed",
          rollbackWithMutation: "passed",
          runtimeSelect: "denied",
          unsafeEntityId: "denied",
        },
        transactionRollback: "passed",
        updateAndDeleteGrants: "denied",
      })
    );
  } finally {
    const cleanupErrors = await cleanupTemporaryRuntimeRole({
      adminPool,
      adminRoleName,
      runtimeClient,
      runtimeClientConnected,
      runtimeRoleMembershipGrantAttempted,
      runtimeRoleName: runtimeRole,
    });
    const fixtureCleanupErrors = await cleanupTenantFixtures({
      adminPool,
      fixtureOperationTokens,
      fixtureOrganizationIds,
      fixtureUserIds,
    });
    cleanupErrors.push(...fixtureCleanupErrors);
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
