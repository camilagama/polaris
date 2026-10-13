import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { createDatabase } from "../src/client";
import { createMediaCleanupClient } from "../src/media-cleanup";
import { createProduct } from "../src/product-repository";
import {
  type TenantRequestIdentity,
  type TenantRequestTransaction,
  withAuthorizedTenantTransaction,
} from "../src/tenant-transaction";

const gateDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const allowedGateBranches = new Set([
  "pr35-media-derivatives-gate",
  "pr36-customers-gate",
]);
const tenantRole = "polaris_pr11_runtime";
const cleanupLoginRole = "polaris_media_cleanup_gate_login";
const cleanupRuntimeRole = "polaris_media_cleanup_runtime";
const cleanupOwnerRole = "polaris_media_cleanup_owner";
const disposableHostPattern =
  /^ep-[a-z0-9-]+\.c-2\.sa-east-1\.aws\.neon\.tech$/;
const poolerPattern = /pooler/i;

type Database = ReturnType<typeof createDatabase>["db"];
type AdminPool = ReturnType<typeof createDatabase>["pool"];

interface TenantFixture {
  organizationId: string;
  userId: string;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error("Missing PR35 media derivatives gate configuration.");
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

function validateGateConnection(
  connectionString: string,
  expectedRole: string
): URL {
  const connection = new URL(connectionString);
  assert.equal(connection.protocol, "postgresql:");
  assert.match(connection.hostname, disposableHostPattern);
  assert.equal(connection.pathname, `/${gateDatabase}`);
  assert.equal(connection.searchParams.get("sslmode"), "verify-full");
  assert.doesNotMatch(connection.hostname, poolerPattern);
  assert.equal(decodeURIComponent(connection.username), expectedRole);
  return connection;
}

async function createTenantFixture(
  adminPool: AdminPool,
  label: string
): Promise<TenantFixture> {
  const userId = randomUUID();
  const organizationId = randomUUID();
  await adminPool.query(
    'INSERT INTO public."user" (id, name, email, email_verified) ' +
      "VALUES ($1, $2, $3, true)",
    [
      userId,
      `PR35 media derivatives ${label}`,
      `pr35-${userId}@example.invalid`,
    ]
  );
  await adminPool.query(
    "INSERT INTO public.organizations (id, name, timezone) VALUES ($1, $2, $3)",
    [organizationId, `PR35 media derivatives ${label}`, "America/Sao_Paulo"]
  );
  await adminPool.query(
    "INSERT INTO public.memberships (organization_id, user_id, role, status) " +
      "VALUES ($1, $2, 'owner', 'active')",
    [organizationId, userId]
  );
  return { organizationId, userId };
}

async function withTenant<T>(
  database: Database,
  fixture: TenantFixture,
  capability: string,
  operation: (
    transaction: TenantRequestTransaction,
    identity: TenantRequestIdentity
  ) => Promise<T>
): Promise<T> {
  return await withAuthorizedTenantTransaction(
    database,
    {
      authenticatedUserId: fixture.userId,
      capability,
      requestedOrganizationId: fixture.organizationId,
    },
    operation
  );
}

async function createTestProduct(
  database: Database,
  fixture: TenantFixture
): Promise<string> {
  const product = await withTenant(
    database,
    fixture,
    "product:create",
    (transaction, identity) =>
      createProduct(transaction, identity, {
        name: `PR35 cleanup gate ${randomUUID()}`,
        requestId: randomUUID(),
      })
  );
  return product.id;
}

function mediaStorageKey(input: {
  organizationId: string;
  productId: string;
  uploadCommandId?: string;
  attemptId?: string;
}): string {
  const uploadCommandId = input.uploadCommandId ?? randomUUID();
  const attemptId = input.attemptId ?? randomUUID();
  const fingerprint = createHash("sha256").update(randomUUID()).digest("hex");
  return `media/v2/${encodeURIComponent(input.organizationId)}/${input.productId}/${uploadCommandId}/${fingerprint}/${attemptId}.webp`;
}

async function insertAndLinkAsset(input: {
  client: Client;
  fixture: TenantFixture;
  productId: string;
  storageKey: string;
}): Promise<string> {
  const uploadCommandId = randomUUID();
  const result = await input.client.query<{ id: string }>(
    "INSERT INTO public.media_assets " +
      "(organization_id, byte_size, content_type, height, input_fingerprint, storage_key, upload_command_id, width) " +
      "VALUES ($1, 4, 'image/webp', 2, $2, $3, $4, 2) RETURNING id",
    [
      input.fixture.organizationId,
      createHash("sha256").update(randomUUID()).digest("hex"),
      input.storageKey,
      uploadCommandId,
    ]
  );
  const assetId = result.rows[0]?.id;
  assert.ok(assetId);
  await input.client.query(
    "INSERT INTO public.product_media " +
      "(organization_id, product_id, media_asset_id, position) VALUES ($1, $2, $3, 0)",
    [input.fixture.organizationId, input.productId, assetId]
  );
  return assetId;
}

async function setTenantContext(
  client: Client,
  fixture: TenantFixture
): Promise<void> {
  await client.query(
    "SELECT set_config('app.organization_id', $1, true), " +
      "set_config('app.user_id', $2, true)",
    [fixture.organizationId, fixture.userId]
  );
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main(): Promise<void> {
  const branchName = requiredEnvironment(
    "POLARIS_MEDIA_DERIVATIVES_GATE_BRANCH"
  );
  assert.ok(allowedGateBranches.has(branchName));
  const adminConnectionString = requiredEnvironment(
    "POLARIS_MEDIA_DERIVATIVES_GATE_DATABASE_URL"
  );
  const tenantConnectionString = requiredEnvironment(
    "POLARIS_MEDIA_DERIVATIVES_GATE_TENANT_DATABASE_URL"
  );
  const cleanupConnectionString = requiredEnvironment(
    "POLARIS_MEDIA_DERIVATIVES_GATE_CLEANUP_DATABASE_URL"
  );
  const adminConnection = validateGateConnection(
    adminConnectionString,
    "neondb_owner"
  );
  const tenantConnection = validateGateConnection(
    tenantConnectionString,
    tenantRole
  );
  const cleanupConnection = validateGateConnection(
    cleanupConnectionString,
    cleanupLoginRole
  );
  assert.equal(adminConnection.hostname, tenantConnection.hostname);
  assert.equal(adminConnection.hostname, cleanupConnection.hostname);

  const admin = createDatabase(adminConnectionString, { maxConnections: 8 });
  const tenantDatabase = createDatabase(tenantConnectionString, {
    maxConnections: 4,
  });
  const tenantClient = new Client({
    connectionString: tenantConnectionString,
    connectionTimeoutMillis: 5000,
  });
  const cleanup = createMediaCleanupClient(cleanupConnectionString);

  try {
    await tenantClient.connect();
    const server = await admin.pool.query<{
      server_version: string;
      server_version_num: number;
    }>(
      "SELECT current_setting('server_version') AS server_version, " +
        "current_setting('server_version_num')::integer AS server_version_num"
    );
    const [serverInfo] = server.rows;
    assert.ok(serverInfo);
    assert.equal(Math.floor(serverInfo.server_version_num / 10_000), 18);

    const branchSchema = await admin.pool.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      "SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity " +
        "FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace " +
        "WHERE n.nspname = 'public' AND c.relname = 'media_cleanup_claims'"
    );
    assert.deepEqual(branchSchema.rows, [
      {
        relforcerowsecurity: true,
        relname: "media_cleanup_claims",
        relrowsecurity: true,
      },
    ]);

    await admin.pool.query(
      "GRANT polaris_media_cleanup_runtime TO polaris_media_cleanup_gate_login"
    );
    const functionInfo = await admin.pool.query<{
      function_owner: string;
      security_definer: boolean;
      function_config: string[] | null;
      cleanup_can_execute: boolean;
      tenant_can_execute: boolean;
      cleanup_can_read_claims: boolean;
      cleanup_can_read_media_keys: boolean;
      cleanup_group_member: boolean;
      cleanup_login_superuser: boolean;
      cleanup_login_bypass_rls: boolean;
      cleanup_login_can_create_roles: boolean;
      migration_owner_is_cleanup_member: boolean;
      migration_owner_inherits_cleanup: boolean;
      migration_owner_can_set_cleanup: boolean;
    }>(
      "SELECT owner.rolname AS function_owner, " +
        "function.prosecdef AS security_definer, function.proconfig AS function_config, " +
        "has_function_privilege($1, function.oid, 'EXECUTE') AS cleanup_can_execute, " +
        "has_function_privilege($2, function.oid, 'EXECUTE') AS tenant_can_execute, " +
        "has_table_privilege($1, 'public.media_cleanup_claims', 'SELECT') AS cleanup_can_read_claims, " +
        "has_column_privilege($1, 'public.media_assets', 'storage_key', 'SELECT') AS cleanup_can_read_media_keys, " +
        "pg_has_role($1, $3, 'MEMBER') AS cleanup_group_member, " +
        "(SELECT rolsuper FROM pg_roles WHERE rolname = $1) AS cleanup_login_superuser, " +
        "(SELECT rolbypassrls FROM pg_roles WHERE rolname = $1) AS cleanup_login_bypass_rls, " +
        "(SELECT rolcreaterole FROM pg_roles WHERE rolname = $1) AS cleanup_login_can_create_roles, " +
        "pg_has_role('neondb_owner', $4, 'MEMBER') AS migration_owner_is_cleanup_member, " +
        "(SELECT membership.inherit_option FROM pg_auth_members AS membership " +
        "JOIN pg_roles AS member ON member.oid = membership.member " +
        "JOIN pg_roles AS granted ON granted.oid = membership.roleid " +
        "WHERE member.rolname = 'neondb_owner' AND granted.rolname = $4) AS migration_owner_inherits_cleanup, " +
        "(SELECT membership.set_option FROM pg_auth_members AS membership " +
        "JOIN pg_roles AS member ON member.oid = membership.member " +
        "JOIN pg_roles AS granted ON granted.oid = membership.roleid " +
        "WHERE member.rolname = 'neondb_owner' AND granted.rolname = $4) AS migration_owner_can_set_cleanup " +
        "FROM pg_proc AS function " +
        "JOIN pg_roles AS owner ON owner.oid = function.proowner " +
        "WHERE function.oid = 'public.claim_media_storage_key_for_cleanup(text)'::regprocedure",
      [cleanupLoginRole, tenantRole, cleanupRuntimeRole, cleanupOwnerRole]
    );
    const [functionRow] = functionInfo.rows;
    assert.ok(functionRow);
    assert.equal(functionRow.function_owner, cleanupOwnerRole);
    assert.equal(functionRow.security_definer, true);
    assert.ok(
      functionRow.function_config?.some((value) =>
        value.startsWith("search_path=")
      )
    );
    assert.equal(functionRow.cleanup_can_execute, true);
    assert.equal(functionRow.cleanup_group_member, true);
    assert.equal(functionRow.cleanup_login_superuser, false);
    assert.equal(functionRow.cleanup_login_bypass_rls, false);
    assert.equal(functionRow.cleanup_login_can_create_roles, false);
    assert.equal(functionRow.migration_owner_is_cleanup_member, true);
    assert.equal(functionRow.migration_owner_inherits_cleanup, false);
    assert.equal(functionRow.migration_owner_can_set_cleanup, false);
    assert.equal(functionRow.tenant_can_execute, false);
    assert.equal(functionRow.cleanup_can_read_claims, false);
    assert.equal(functionRow.cleanup_can_read_media_keys, false);

    const triggerFunctionInfo = await admin.pool.query<{
      function_owner: string;
      public_can_execute: boolean;
      tenant_can_execute: boolean;
      cleanup_login_can_execute: boolean;
      cleanup_runtime_can_execute: boolean;
    }>(
      "SELECT owner.rolname AS function_owner, " +
        "EXISTS (SELECT 1 FROM aclexplode(COALESCE(function.proacl, acldefault('f', function.proowner))) AS acl " +
        "WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE') AS public_can_execute, " +
        "has_function_privilege($1, function.oid, 'EXECUTE') AS tenant_can_execute, " +
        "has_function_privilege($2, function.oid, 'EXECUTE') AS cleanup_login_can_execute, " +
        "has_function_privilege($3, function.oid, 'EXECUTE') AS cleanup_runtime_can_execute " +
        "FROM pg_proc AS function " +
        "JOIN pg_roles AS owner ON owner.oid = function.proowner " +
        "WHERE function.oid = 'public.guard_media_storage_key_cleanup_claim()'::regprocedure",
      [tenantRole, cleanupLoginRole, cleanupRuntimeRole]
    );
    const [triggerFunctionRow] = triggerFunctionInfo.rows;
    assert.ok(triggerFunctionRow);
    assert.equal(triggerFunctionRow.function_owner, cleanupOwnerRole);
    assert.equal(triggerFunctionRow.public_can_execute, false);
    assert.equal(triggerFunctionRow.tenant_can_execute, false);
    assert.equal(triggerFunctionRow.cleanup_login_can_execute, false);
    assert.equal(triggerFunctionRow.cleanup_runtime_can_execute, false);

    const fixture = await createTenantFixture(admin.pool, "race");
    const productId = await createTestProduct(admin.db, fixture);
    const orphanKey = mediaStorageKey({
      organizationId: fixture.organizationId,
      productId,
    });
    assert.equal(await cleanup.claimOrphan(orphanKey), true);
    assert.equal(await cleanup.claimOrphan(orphanKey), true);

    await tenantClient.query("BEGIN");
    try {
      await setTenantContext(tenantClient, fixture);
      await expectSqlState(
        () =>
          tenantClient.query(
            "INSERT INTO public.media_assets " +
              "(organization_id, byte_size, content_type, height, input_fingerprint, storage_key, upload_command_id, width) " +
              "VALUES ($1, 4, 'image/webp', 2, $2, $3, $4, 2)",
            [
              fixture.organizationId,
              createHash("sha256").update(randomUUID()).digest("hex"),
              orphanKey,
              randomUUID(),
            ]
          ),
        "23514",
        "cleanup-claimed media key cannot be inserted"
      );
    } finally {
      await tenantClient.query("ROLLBACK");
    }

    const raceKey = mediaStorageKey({
      organizationId: fixture.organizationId,
      productId,
    });
    let releaseCommit: (() => void) | undefined;
    let announceInsert: (() => void) | undefined;
    const insertionReady = new Promise<void>((resolve) => {
      announceInsert = resolve;
    });
    const allowCommit = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const inserting = (async () => {
      await tenantClient.query("BEGIN");
      await setTenantContext(tenantClient, fixture);
      const assetId = await insertAndLinkAsset({
        client: tenantClient,
        fixture,
        productId,
        storageKey: raceKey,
      });
      announceInsert?.();
      await allowCommit;
      await tenantClient.query("COMMIT");
      return assetId;
    })();

    await insertionReady;
    let cleanupSettled = false;
    const claiming = cleanup.claimOrphan(raceKey).then((claimed) => {
      cleanupSettled = true;
      return claimed;
    });
    await pause(250);
    assert.equal(
      cleanupSettled,
      false,
      "cleanup must wait for the in-flight media_assets insert"
    );
    releaseCommit?.();
    const insertedAssetId = await inserting;
    const claimedReferencedKey = await claiming;
    assert.ok(insertedAssetId);
    assert.equal(
      claimedReferencedKey,
      false,
      "cleanup must observe the committed asset after acquiring its key lock"
    );

    await expectSqlState(
      () =>
        tenantClient.query(
          "SELECT public.claim_media_storage_key_for_cleanup($1)",
          [
            mediaStorageKey({
              organizationId: fixture.organizationId,
              productId,
            }),
          ]
        ),
      "42501",
      "tenant runtime cannot call the privileged cleanup function"
    );

    console.log(
      JSON.stringify({
        branch: branchName,
        database: gateDatabase,
        movement: "synthetic fixtures retained until branch auto-expiry",
        serverVersion: serverInfo.server_version,
        status: "passed",
        tests: [
          "PostgreSQL 18 and migration 0026",
          "FORCE RLS on the cleanup claim table",
          "SECURITY DEFINER owner and fixed search_path",
          "trigger guard has no EXECUTE for PUBLIC, tenant, or cleanup roles",
          "cleanup login can execute only the claim function",
          "cleanup login cannot read claim or media tables",
          "tenant runtime cannot execute the cleanup function",
          "cleanup claim is idempotent for unreferenced keys",
          "cleanup claim blocks a later media asset insert",
          "an in-flight asset insert holds the same advisory lock",
          "a committed asset is visible to cleanup after lock acquisition",
        ],
      })
    );
  } finally {
    await cleanup.close();
    await tenantClient.end();
    await tenantDatabase.pool.end();
    await admin.pool.end();
  }
}

await main();
