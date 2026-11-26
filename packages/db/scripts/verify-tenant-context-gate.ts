import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { createDatabase } from "../src/client";
import {
  type CreateInitialOrganizationInDatabaseResult,
  createInitialOrganizationInDatabase,
} from "../src/organization-repository";
import { rlsPocOperations } from "../src/rls-poc-client";
import { memberships, organizations } from "../src/schema/organization";
import { tenantAuditEvents } from "../src/schema/tenant-audit";
import { recordTenantAuditEvent } from "../src/tenant-audit";
import {
  LegalAcceptancePendingError,
  TENANT_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  TENANT_LOCK_TIMEOUT_MS,
  TENANT_STATEMENT_TIMEOUT_MS,
  TenantAuthorizationError,
  withAuthorizedTenantTransaction,
} from "../src/tenant-transaction";
import { assertAllowedGateUrl, disposableHostPattern } from "./gate-hosts";
import {
  becomeGateRole,
  inRolledBackTransaction,
  rollbackQuietly,
} from "./gate-roles";
import { dropRlsGateFixture, recreateRlsGateFixture } from "./rls-gate-fixture";
import { temporaryRuntimeUrl } from "./sales-gate-support";
import { deleteOrganizationsWithAudit } from "./teardown-support";
import {
  checkOtherRuntimeCannotEnter,
  checkTenantEntryCatalog,
  type EntryCall,
  entryOutcome,
  outcomeUnderMutant,
  outcomeWithoutPendingHelper,
  recordAcceptance,
} from "./tenant-entry-gate-checks";

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
  await inRolledBackTransaction(runtimeClient, async () => {
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
  });
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

async function cleanupTemporaryRuntimeRole(input: {
  adminPool: ReturnType<typeof createDatabase>["pool"];
  onboarding: { login: string; pool: { end: () => Promise<void> } } | undefined;
  releaseRuntimeRole: ((failed?: boolean) => Promise<void>) | undefined;
}): Promise<unknown[]> {
  const errors: unknown[] = [];
  if (input.releaseRuntimeRole) {
    try {
      await input.releaseRuntimeRole();
    } catch (error) {
      errors.push(error);
    }
  }
  if (input.onboarding) {
    try {
      await input.onboarding.pool.end();
    } catch (error) {
      errors.push(error);
    }
    try {
      await input.adminPool.query(
        `DROP ROLE IF EXISTS "${input.onboarding.login}"`
      );
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
  let releaseRuntimeRole: ((failed?: boolean) => Promise<void>) | undefined;
  // the onboarding is the product's: the real function through a login of the onboarding runtime, never the owner
  let onboarding:
    | {
        db: ReturnType<typeof createDatabase>["db"];
        login: string;
        pool: ReturnType<typeof createDatabase>["pool"];
      }
    | undefined;
  let pocFixtureCreated = false;

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
    if (!onboarding) {
      const login = `polaris_tctx_onboarding_${randomBytes(6).toString("hex")}`;
      const password = randomBytes(24).toString("hex");
      // the pool connects lazily: registered before the CREATE ROLE, the login is dropped by the cleanup however far
      // the setup got
      const created = createDatabase(
        temporaryRuntimeUrl(connectionString, login, password),
        { maxConnections: 1 }
      );
      onboarding = { ...created, login };
      await adminPool.query(
        `CREATE ROLE "${login}" WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`
      );
      await adminPool.query(`GRANT polaris_onboarding_runtime TO "${login}"`);
    }
    const result = await createInitialOrganizationInDatabase(onboarding.db, {
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
        "AND tablename = ANY($1::text[]) AND roles NOT IN ('{polaris_catalog_owner}', '{polaris_admin_owner}', '{polaris_privacy_owner}', '{polaris_purge_owner}', '{polaris_retention_owner}', '{polaris_closed_export_reader}', '{polaris_notice_recipient_owner}', '{polaris_unverified_user_owner}', '{polaris_authorization_epoch_owner}', '{polaris_onboarding_owner}', '{polaris_billing_audit_owner}', '{polaris_billing_owner}', '{polaris_activation_notice_owner}', '{polaris_activation_owner}', '{polaris_activation_recipient_owner}') ORDER BY tablename, policyname",
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
    pocFixtureCreated = true;
    await recreateRlsGateFixture(adminPool);
    await runtimeClient.connect();
    runtimeClientConnected = true;
    // the owner's session acts as the runtime group for the rest of the gate (current_user is asserted below)
    releaseRuntimeRole = await becomeGateRole(runtimeClient, runtimeRole);
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
      await rollbackQuietly(runtimeClient);
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
        requireLegalAcceptance: false,
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
        requireLegalAcceptance: false,
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
        requireLegalAcceptance: false,
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
        requireLegalAcceptance: false,
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
          requireLegalAcceptance: false,
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
          requireLegalAcceptance: false,
        },
        async () => "must not execute"
      ),
      "capability_denied"
    );

    // ------------------------------------------- the entry in one statement (begin_tenant_request)
    await checkTenantEntryCatalog(adminPool);
    const ownCall = {
      organization: initialA.organization.id,
      roles: ["owner"],
      user: userA,
    };
    await checkOtherRuntimeCannotEnter(adminPool, ownCall);
    const directOutcomes = await inRolledBackTransaction(
      runtimeClient,
      async () => {
        const outcomes: Record<string, string> = {};
        const cases: [string, EntryCall][] = [
          ["owner", ownCall],
          ["empty roles", { ...ownCall, roles: [] }],
          ["null roles", { ...ownCall, roles: null }],
          ["null role in the list", { ...ownCall, roles: [null] }],
          ["role without the capability", { ...ownCall, roles: ["manager"] }],
          ["empty user", { ...ownCall, user: "" }],
          ["null user", { ...ownCall, user: null }],
          ["null organization", { ...ownCall, organization: null }],
          [
            "not a member, no role",
            { ...ownCall, organization: initialB.organization.id, roles: [] },
          ],
        ];
        for (const invalid of [null, 0, -1]) {
          for (const [slot, setting] of [
            "statement",
            "lock",
            "idle",
          ].entries()) {
            const timeouts: [number | null, number | null, number | null] = [
              TENANT_STATEMENT_TIMEOUT_MS,
              TENANT_LOCK_TIMEOUT_MS,
              TENANT_IDLE_IN_TRANSACTION_TIMEOUT_MS,
            ];
            timeouts[slot] = invalid;
            cases.push([
              `${setting} timeout ${String(invalid)}`,
              { ...ownCall, timeouts },
            ]);
          }
        }
        for (const [name, call] of cases) {
          // biome-ignore lint/performance/noAwaitInLoops: one savepoint at a time on the one connection
          outcomes[name] = await entryOutcome(runtimeClient, call);
        }
        return outcomes;
      }
    );
    const invalidTimeout = "22023:invalid_tenant_timeout";
    assert.deepEqual(directOutcomes, {
      "empty roles": "42501:capability_denied",
      "empty user": "42501:tenant_access_denied",
      "not a member, no role": "42501:tenant_access_denied",
      "null organization": "42501:tenant_access_denied",
      "null role in the list": "42501:capability_denied",
      "null roles": "42501:capability_denied",
      "null user": "42501:tenant_access_denied",
      owner: "ok:owner",
      "role without the capability": "42501:capability_denied",
      ...Object.fromEntries(
        ["statement", "lock", "idle"].flatMap((setting) =>
          ["null", "0", "-1"].map((invalid) => [
            `${setting} timeout ${invalid}`,
            invalidTimeout,
          ])
        )
      ),
    });

    // the legal acceptance at the entry: no default (a null flag or minimum, or one out of 1-1000, raises whether or
    // not the check is asked for), checked first (a pending document comes before the membership and the capability),
    // with the pending documents in the DETAIL, and the helper without EXECUTE fails closed
    const userLegal = await createUser("PR22 tenant context legal");
    const initialLegal = await createInitialOrganization(
      userLegal,
      "PR22 tenant context legal"
    );
    const legalCall: EntryCall = {
      organization: initialLegal.organization.id,
      requireLegal: true,
      roles: ["owner"],
      user: userLegal,
    };
    const legalOutcomes = async () =>
      await inRolledBackTransaction(runtimeClient, async () => {
        const outcomes: Record<string, string> = {};
        const cases: [string, EntryCall][] = [
          ["required", legalCall],
          ["not required", { ...legalCall, requireLegal: false }],
          [
            "required, not a member",
            { ...legalCall, organization: initialA.organization.id },
          ],
          [
            "required, without the capability",
            { ...legalCall, roles: ["manager"] },
          ],
          ["required, terms raised to 2", { ...legalCall, minimums: [2, 1] }],
          ["null flag", { ...legalCall, requireLegal: null }],
          [
            "not required, null minimum",
            { ...legalCall, minimums: [null, 1], requireLegal: false },
          ],
          ["null terms minimum", { ...legalCall, minimums: [null, 1] }],
          ["null privacy minimum", { ...legalCall, minimums: [1, null] }],
          ["zero minimum", { ...legalCall, minimums: [0, 1] }],
          ["minimum 1001", { ...legalCall, minimums: [1, 1001] }],
        ];
        for (const [name, call] of cases) {
          // biome-ignore lint/performance/noAwaitInLoops: one savepoint at a time on the one connection
          outcomes[name] = await entryOutcome(runtimeClient, call);
        }
        return outcomes;
      });
    const invalidLegal = "22023:invalid_legal_acceptance_check";
    const invalidLegalCases = {
      "minimum 1001": invalidLegal,
      "not required, null minimum": invalidLegal,
      "null flag": invalidLegal,
      "null privacy minimum": invalidLegal,
      "null terms minimum": invalidLegal,
      "zero minimum": invalidLegal,
    };
    const pendingBoth = "42501:legal_acceptance_required:terms,privacy";
    assert.deepEqual(await legalOutcomes(), {
      ...invalidLegalCases,
      "not required": "ok:owner",
      required: pendingBoth,
      "required, not a member": pendingBoth,
      "required, terms raised to 2": pendingBoth,
      "required, without the capability": pendingBoth,
    });
    await recordAcceptance(adminPool, userLegal, "terms", 1);
    const pendingPrivacy = "42501:legal_acceptance_required:privacy";
    assert.deepEqual(await legalOutcomes(), {
      ...invalidLegalCases,
      "not required": "ok:owner",
      required: pendingPrivacy,
      "required, not a member": pendingPrivacy,
      "required, terms raised to 2": pendingBoth,
      "required, without the capability": pendingPrivacy,
    });
    await recordAcceptance(adminPool, userLegal, "privacy", 1);
    assert.deepEqual(await legalOutcomes(), {
      ...invalidLegalCases,
      "not required": "ok:owner",
      required: "ok:owner",
      "required, not a member": "42501:tenant_access_denied",
      "required, terms raised to 2": "42501:legal_acceptance_required:terms",
      "required, without the capability": "42501:capability_denied",
    });
    const pendingThroughTheEntry = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "catalog:read",
        requestedOrganizationId: initialA.organization.id,
        requireLegalAcceptance: true,
      },
      async () => "must not execute"
    ).then(
      () => undefined,
      (error: unknown) => error
    );
    assert.ok(
      pendingThroughTheEntry instanceof LegalAcceptancePendingError,
      "a pending acceptance reaches the Worker as LegalAcceptancePendingError, not as a refusal of the authorization"
    );
    assert.deepEqual(pendingThroughTheEntry.documents, ["terms", "privacy"]);
    assert.equal(
      await withAuthorizedTenantTransaction(
        runtimeDb,
        {
          authenticatedUserId: userLegal,
          capability: "catalog:read",
          requestedOrganizationId: initialLegal.organization.id,
          requireLegalAcceptance: true,
        },
        async () => "entered"
      ),
      "entered"
    );
    assert.equal(
      await outcomeWithoutPendingHelper(adminPool, legalCall),
      "42501:permission denied for function legal_acceptance_pending",
      "without EXECUTE on the helper the entry fails closed, with the privilege error"
    );
    assert.equal(
      await outcomeWithoutPendingHelper(adminPool, {
        ...legalCall,
        requireLegal: false,
      }),
      "ok:owner",
      "with the check off the entry reads nothing of the acceptance"
    );

    // a refusal aborts the transaction: nothing runs after it, and the organization context never stays
    await inRolledBackTransaction(runtimeClient, async () => {
      await expectSqlState(
        runtimeClient.query(
          "SELECT member_role FROM public.begin_tenant_request($1, $2, '{}'::text[], false, 1, 1, 30000, 20000, 60000)",
          [userA, initialA.organization.id]
        ),
        "42501",
        "the entry without roles"
      );
      await expectSqlState(
        runtimeClient.query("SELECT 1"),
        "25P02",
        "a statement after a refused entry"
      );
    });

    const sessionSettings = async () =>
      (
        await runtimeClient.query<Record<string, string | null>>(
          `SELECT (SELECT setting FROM pg_settings WHERE name = 'statement_timeout') AS statement_timeout,
                  (SELECT setting FROM pg_settings WHERE name = 'lock_timeout') AS lock_timeout,
                  (SELECT setting FROM pg_settings WHERE name = 'idle_in_transaction_session_timeout') AS idle_timeout,
                  NULLIF(current_setting('app.user_id', true), '') AS user_id,
                  NULLIF(current_setting('app.organization_id', true), '') AS organization_id,
                  current_setting('search_path') AS search_path`
        )
      ).rows[0];
    const before = await sessionSettings();
    assert.equal(before?.user_id, null);
    assert.equal(before?.organization_id, null);
    const inside = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "catalog:read",
        requestedOrganizationId: initialA.organization.id,
        requireLegalAcceptance: false,
      },
      () => sessionSettings()
    );
    assert.deepEqual(inside, {
      idle_timeout: String(TENANT_IDLE_IN_TRANSACTION_TIMEOUT_MS),
      lock_timeout: String(TENANT_LOCK_TIMEOUT_MS),
      organization_id: initialA.organization.id,
      // the pinned search_path of the function is given back on return; the work runs with the session's
      search_path: before?.search_path,
      statement_timeout: String(TENANT_STATEMENT_TIMEOUT_MS),
      user_id: userA,
    });
    assert.deepEqual(await sessionSettings(), before);

    await expectTenantAuthorizationError(
      withAuthorizedTenantTransaction(
        runtimeDb,
        {
          authenticatedUserId: userA,
          capability: "__proto__",
          requestedOrganizationId: initialB.organization.id,
          requireLegalAcceptance: false,
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
          capability: "catalog:read",
          requestedOrganizationId: randomUUID(),
          requireLegalAcceptance: false,
        },
        async () => "must not execute"
      ),
      "tenant_access_denied"
    );

    // a member removed after a call that passed: the next call is refused
    const userRemoved = await createUser("PR22 tenant context removed");
    const initialRemoved = await createInitialOrganization(
      userRemoved,
      "PR22 tenant context removed"
    );
    const removedCall = {
      authenticatedUserId: userRemoved,
      capability: "catalog:read",
      requestedOrganizationId: initialRemoved.organization.id,
      requireLegalAcceptance: false,
    };
    assert.equal(
      await withAuthorizedTenantTransaction(runtimeDb, removedCall, () =>
        Promise.resolve("entered")
      ),
      "entered"
    );
    await adminPool.query(
      "DELETE FROM public.memberships WHERE organization_id = $1 AND user_id = $2",
      [initialRemoved.organization.id, userRemoved]
    );
    await expectTenantAuthorizationError(
      withAuthorizedTenantTransaction(
        runtimeDb,
        removedCall,
        async () => "must not execute"
      ),
      "tenant_access_denied"
    );

    // a suspended organization: refused, and the capability is still checked before the status of the organization
    const userSuspended = await createUser("PR22 tenant context suspended");
    const initialSuspended = await createInitialOrganization(
      userSuspended,
      "PR22 tenant context suspended"
    );
    await adminPool.query(
      "UPDATE public.organizations SET status = 'suspended' WHERE id = $1",
      [initialSuspended.organization.id]
    );
    for (const [capability, code] of [
      ["catalog:read", "tenant_access_denied"],
      ["__proto__", "capability_denied"],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: one transaction at a time on the one connection
      await expectTenantAuthorizationError(
        withAuthorizedTenantTransaction(
          runtimeDb,
          {
            authenticatedUserId: userSuspended,
            capability,
            requestedOrganizationId: initialSuspended.organization.id,
            requireLegalAcceptance: false,
          },
          async () => "must not execute"
        ),
        code
      );
    }

    // each probe tells the real body from one without its check (the definition replaced and rolled back)
    const mutants: [string, string, EntryCall, string, string][] = [
      [
        "IF p_require_legal THEN",
        "IF FALSE THEN",
        { ...ownCall, requireLegal: true },
        "42501:legal_acceptance_required:terms,privacy",
        "ok:owner",
      ],
      [
        "IF v_pending IS NOT NULL THEN",
        "IF FALSE THEN",
        { ...ownCall, requireLegal: true },
        "42501:legal_acceptance_required:terms,privacy",
        "ok:owner",
      ],
      [
        "IF v_status IS DISTINCT FROM 'active' THEN",
        "IF FALSE THEN",
        { ...ownCall, organization: initialB.organization.id },
        "42501:tenant_access_denied",
        // without C1 the hidden membership of the other organization reads as no role
        "42501:capability_denied",
      ],
      [
        "IF (v_role = ANY (p_roles)) IS NOT TRUE THEN",
        "IF FALSE THEN",
        { ...ownCall, roles: [] },
        "42501:capability_denied",
        "ok:owner",
      ],
      [
        "IF NOT EXISTS (",
        "IF FALSE AND NOT EXISTS (",
        {
          organization: initialSuspended.organization.id,
          roles: ["owner"],
          user: userSuspended,
        },
        "42501:tenant_access_denied",
        "ok:owner",
      ],
    ];
    for (const [fragment, replacement, call, real, mutated] of mutants) {
      // biome-ignore lint/performance/noAwaitInLoops: one replaced definition at a time
      const realOutcome = await inRolledBackTransaction(runtimeClient, () =>
        entryOutcome(runtimeClient, call)
      );
      assert.equal(realOutcome, real, fragment);
      assert.equal(
        await outcomeUnderMutant(adminPool, fragment, replacement, call),
        mutated,
        `without ${fragment} the probe answers what that check stopped`
      );
    }

    const crossTenantToken = `pr22-${randomUUID()}`;
    fixtureOperationTokens.push(crossTenantToken);
    await expectSqlState(
      withAuthorizedTenantTransaction(
        runtimeDb,
        {
          authenticatedUserId: userA,
          capability: "organization:manage",
          requestedOrganizationId: initialA.organization.id,
          requireLegalAcceptance: false,
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
          requireLegalAcceptance: false,
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
          requireLegalAcceptance: false,
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
          requireLegalAcceptance: false,
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
          requireLegalAcceptance: false,
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
          requireLegalAcceptance: false,
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
        requireLegalAcceptance: false,
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
          requireLegalAcceptance: false,
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
        tenantEntry: {
          catalog: "invoker_pinned_runtime_only",
          directRefusals: "passed",
          mutantsCaught: mutants.length,
          refusalAbortsTransaction: "passed",
          removedMember: "denied",
          settingsLocalToTransaction: "passed",
          suspendedOrganization: "denied_after_capability",
        },
        transactionRollback: "passed",
        updateAndDeleteGrants: "denied",
      })
    );
  } finally {
    const cleanupErrors = await cleanupTemporaryRuntimeRole({
      adminPool,
      onboarding,
      releaseRuntimeRole: runtimeClientConnected
        ? releaseRuntimeRole
        : undefined,
    });
    const fixtureCleanupErrors = await cleanupTenantFixtures({
      adminPool,
      fixtureOperationTokens,
      fixtureOrganizationIds,
      fixtureUserIds,
    });
    cleanupErrors.push(...fixtureCleanupErrors);
    if (pocFixtureCreated) {
      try {
        await dropRlsGateFixture(adminPool);
      } catch (error) {
        cleanupErrors.push(error);
      }
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
