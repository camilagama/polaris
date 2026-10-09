import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { createDatabase } from "../src/client";
import {
  configureProductVariants,
  createProduct,
} from "../src/product-repository";
import {
  getInventoryBalance,
  recordStockMovement,
} from "../src/inventory-repository";
import { stockMovements } from "../src/schema/inventory";
import { productVariants } from "../src/schema/product";
import { InsufficientStockError } from "@polaris/domain/inventory/inventory";
import { ProductDefaultVariantStockHistoryConflictError } from "@polaris/domain/catalog/product";
import {
  withAuthorizedTenantTransaction,
  type TenantRequestIdentity,
  type TenantRequestTransaction,
} from "../src/tenant-transaction";

const runtimeRole = "polaris_pr11_runtime";
const sqlStatePattern = /^[0-9A-Z]{5}$/;
const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const poolerPattern = /pooler/i;
const disposableHostPattern =
  /^ep-[a-z-]+-[a-z0-9]+\.c-2\.sa-east-1\.aws\.neon\.tech$/;

type Database = ReturnType<typeof createDatabase>["db"];
type AdminPool = ReturnType<typeof createDatabase>["pool"];

interface RuntimeSession {
  client: Client;
  database: Database;
}

interface TenantFixture {
  organizationId: string;
  userId: string;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error("Missing PR28 inventory gate configuration.");
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

async function ensureRuntimeRoleCanBeSet(
  adminPool: AdminPool
): Promise<{ adminRoleName: string; canSetRuntimeRole: boolean }> {
  const result = await adminPool.query<{
    admin_role: string;
    can_set_runtime_role: boolean;
  }>(
    "SELECT current_user AS admin_role, " +
      "pg_has_role(current_user, $1, 'SET') AS can_set_runtime_role",
    [runtimeRole]
  );
  const [row] = result.rows;
  assert.ok(row);
  assert.match(row.admin_role, identifierPattern);
  return {
    adminRoleName: row.admin_role,
    canSetRuntimeRole: row.can_set_runtime_role,
  };
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
    [userId, `PR28 inventory gate ${label}`, `pr28-${userId}@example.invalid`]
  );
  await adminPool.query(
    "INSERT INTO public.organizations (id, name, timezone) VALUES ($1, $2, $3)",
    [organizationId, `PR28 inventory gate ${label}`, "America/Sao_Paulo"]
  );
  await adminPool.query(
    "INSERT INTO public.memberships (organization_id, user_id, role, status) " +
      "VALUES ($1, $2, 'owner', 'active')",
    [organizationId, userId]
  );
  return { organizationId, userId };
}

async function createRuntimeSession(
  connectionString: string
): Promise<RuntimeSession> {
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  await client.query("SET ROLE polaris_pr11_runtime");
  const role = await client.query("SELECT current_user AS role");
  assert.equal(role.rows[0]?.role, runtimeRole);
  return {
    client,
    database: drizzle({ client }) as unknown as Database,
  };
}

async function createTestProduct(
  database: Database,
  fixture: TenantFixture,
  label: string
): Promise<string> {
  const product = await withAuthorizedTenantTransaction(
    database,
    {
      authenticatedUserId: fixture.userId,
      capability: "product:create",
      requestedOrganizationId: fixture.organizationId,
    },
    (transaction, identity) =>
      createProduct(transaction, identity, {
        name: `PR28 ${label} ${randomUUID()}`,
        requestId: randomUUID(),
      })
  );
  return product.id;
}

async function getDefaultVariantId(
  database: Database,
  fixture: TenantFixture,
  productId: string
): Promise<string> {
  const variants = await withAuthorizedTenantTransaction(
    database,
    {
      authenticatedUserId: fixture.userId,
      capability: "catalog:read",
      requestedOrganizationId: fixture.organizationId,
    },
    (transaction) =>
      transaction
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(
          and(
            eq(productVariants.organizationId, fixture.organizationId),
            eq(productVariants.productId, productId),
            eq(productVariants.isDefault, true)
          )
        )
  );
  assert.equal(variants.length, 1);
  const [variant] = variants;
  assert.ok(variant);
  return variant.id;
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

async function withRuntimeGucs<T>(
  client: Client,
  userId: string,
  organizationId: string,
  operation: () => Promise<T>
): Promise<T> {
  await client.query("BEGIN");
  try {
    await client.query(
      "SELECT set_config('app.user_id', $1, true), " +
        "set_config('app.organization_id', $2, true)",
      [userId, organizationId]
    );
    return await operation();
  } finally {
    await client.query("ROLLBACK");
  }
}

async function main(): Promise<void> {
  const connectionString = requiredEnvironment(
    "POLARIS_INVENTORY_GATE_DATABASE_URL"
  );
  const confirmation = requiredEnvironment(
    "POLARIS_INVENTORY_GATE_CONFIRM_DISPOSABLE"
  );
  const expectedHostname = requiredEnvironment(
    "POLARIS_INVENTORY_GATE_EXPECTED_HOSTNAME"
  );
  assert.equal(confirmation, "polaris-pr28-inventory-gate");

  const connection = new URL(connectionString);
  assert.equal(connection.protocol, "postgresql:");
  assert.equal(connection.pathname, "/neondb");
  assert.equal(connection.hostname, expectedHostname);
  assert.match(connection.hostname, disposableHostPattern);
  assert.doesNotMatch(connection.hostname, poolerPattern);

  const admin = createDatabase(connectionString, { maxConnections: 8 });
  const runtimeSessions: RuntimeSession[] = [];
  let adminRoleName: string | undefined;
  let runtimeRoleMembershipGrantAttempted = false;

  try {
    const [server] = await admin.pool
      .query<{
        current_database: string;
        server_version: string;
        server_version_num: number;
      }>(
        "SELECT current_database(), current_setting('server_version') AS server_version, " +
          "current_setting('server_version_num')::integer AS server_version_num"
      )
      .then((result) => result.rows);
    assert.ok(server);
    assert.equal(server.current_database, "neondb");
    assert.equal(Math.floor(server.server_version_num / 10_000), 18);

    const roles = await admin.pool.query<{
      rolbypassrls: boolean;
      rolsuper: boolean;
    }>(
      "SELECT rolbypassrls, rolsuper FROM pg_catalog.pg_roles WHERE rolname = $1",
      [runtimeRole]
    );
    assert.equal(roles.rows.length, 1);
    assert.equal(roles.rows[0]?.rolbypassrls, false);
    assert.equal(roles.rows[0]?.rolsuper, false);

    const tableSecurity = await admin.pool.query<{
      relname: string;
      relforcerowsecurity: boolean;
      relowner: string;
      relrowsecurity: boolean;
    }>(
      "SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, " +
        "pg_catalog.pg_get_userbyid(c.relowner) AS relowner " +
        "FROM pg_catalog.pg_class AS c " +
        "JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace " +
        "WHERE n.nspname = 'public' " +
        "AND c.relname = ANY($1::text[]) ORDER BY c.relname",
      [["inventory_balances", "stock_movements"]]
    );
    assert.equal(tableSecurity.rows.length, 2);
    for (const table of tableSecurity.rows) {
      assert.equal(table.relrowsecurity, true);
      assert.equal(table.relforcerowsecurity, true);
      assert.notEqual(table.relowner, runtimeRole);
    }

    const privileges = await admin.pool.query<{
      balance_delete: boolean;
      balance_insert: boolean;
      balance_select: boolean;
      balance_update: boolean;
      movement_delete: boolean;
      movement_insert: boolean;
      movement_select: boolean;
      movement_update: boolean;
    }>(
      "SELECT " +
        "has_table_privilege($1, 'public.inventory_balances', 'SELECT') AS balance_select, " +
        "has_table_privilege($1, 'public.inventory_balances', 'INSERT') AS balance_insert, " +
        "has_column_privilege($1, 'public.inventory_balances', 'quantity', 'UPDATE') AS balance_update, " +
        "has_table_privilege($1, 'public.inventory_balances', 'DELETE') AS balance_delete, " +
        "has_table_privilege($1, 'public.stock_movements', 'SELECT') AS movement_select, " +
        "has_table_privilege($1, 'public.stock_movements', 'INSERT') AS movement_insert, " +
        "has_table_privilege($1, 'public.stock_movements', 'UPDATE') AS movement_update, " +
        "has_table_privilege($1, 'public.stock_movements', 'DELETE') AS movement_delete",
      [runtimeRole]
    );
    assert.deepEqual(privileges.rows[0], {
      balance_delete: false,
      balance_insert: true,
      balance_select: true,
      balance_update: true,
      movement_delete: false,
      movement_insert: true,
      movement_select: true,
      movement_update: false,
    });

    const migrationCount = await admin.pool.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM drizzle.__drizzle_migrations"
    );
    assert.ok((migrationCount.rows[0]?.count ?? 0) >= 19);

    const { adminRoleName: resolvedAdminRoleName, canSetRuntimeRole } =
      await ensureRuntimeRoleCanBeSet(admin.pool);
    adminRoleName = resolvedAdminRoleName;
    if (!canSetRuntimeRole) {
      runtimeRoleMembershipGrantAttempted = true;
      await admin.pool.query(`GRANT "${runtimeRole}" TO "${adminRoleName}"`);
    }

    const runtime = await createRuntimeSession(connectionString);
    runtimeSessions.push(runtime);

    const fixtureA = await createTenantFixture(admin.pool, "A");
    const fixtureB = await createTenantFixture(admin.pool, "B");
    const emptyProductId = await createTestProduct(
      runtime.database,
      fixtureA,
      "empty-balance"
    );
    const emptyVariantId = await getDefaultVariantId(
      runtime.database,
      fixtureA,
      emptyProductId
    );

    await withTenant(
      runtime.database,
      fixtureA,
      "inventory:adjust",
      async (transaction, identity) => {
        const empty = await getInventoryBalance(
          transaction,
          identity,
          emptyVariantId
        );
        assert.deepEqual(empty, {
          movingAverageCost: null,
          quantity: 0,
          variantId: emptyVariantId,
          version: 0,
        });

        await assert.rejects(
          recordStockMovement(transaction, identity, {
            movementType: "write_off",
            quantityDelta: -1,
            requestId: randomUUID(),
            variantId: emptyVariantId,
          }),
          InsufficientStockError
        );
        const noMovement = await transaction
          .select({ id: stockMovements.id })
          .from(stockMovements)
          .where(eq(stockMovements.variantId, emptyVariantId));
        assert.deepEqual(noMovement, []);
      }
    );

    await withTenant(
      runtime.database,
      fixtureA,
      "product:update",
      async (transaction, identity) => {
        await assert.rejects(
          recordStockMovement(transaction, identity, {
            movementType: "receipt",
            quantityDelta: 1,
            requestId: randomUUID(),
            variantId: emptyVariantId,
          }),
          (error: unknown) =>
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "capability_denied"
        );
      }
    );

    await withTenant(
      runtime.database,
      fixtureA,
      "inventory:adjust",
      async (transaction, identity) => {
        await assert.rejects(
          recordStockMovement(transaction, identity, {
            movementType: "receipt",
            quantityDelta: 5,
            requestId: "invalid-request-id",
            variantId: emptyVariantId,
          }),
          (error: unknown) =>
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "invalid_tenant_audit_event"
        );
        const balanceAfterRollback = await getInventoryBalance(
          transaction,
          identity,
          emptyVariantId
        );
        const movementsAfterRollback = await transaction
          .select({ id: stockMovements.id })
          .from(stockMovements)
          .where(eq(stockMovements.variantId, emptyVariantId));
        assert.equal(balanceAfterRollback.quantity, 0);
        assert.deepEqual(movementsAfterRollback, []);
      }
    );

    const historicalProductId = await createTestProduct(
      runtime.database,
      fixtureA,
      "historical-default"
    );
    const historicalVariantId = await getDefaultVariantId(
      runtime.database,
      fixtureA,
      historicalProductId
    );
    await withTenant(
      runtime.database,
      fixtureA,
      "inventory:adjust",
      async (transaction, identity) => {
        await recordStockMovement(transaction, identity, {
          movementType: "receipt",
          quantityDelta: 2,
          requestId: randomUUID(),
          variantId: historicalVariantId,
        });
      }
    );
    await withTenant(
      runtime.database,
      fixtureA,
      "inventory:adjust",
      async (transaction, identity) => {
        await recordStockMovement(transaction, identity, {
          movementType: "write_off",
          quantityDelta: -2,
          requestId: randomUUID(),
          variantId: historicalVariantId,
        });
      }
    );
    const historicalBalance = await withTenant(
      runtime.database,
      fixtureA,
      "inventory:adjust",
      (transaction, identity) =>
        getInventoryBalance(transaction, identity, historicalVariantId)
    );
    assert.equal(historicalBalance.quantity, 0);
    await assert.rejects(
      withTenant(
        runtime.database,
        fixtureA,
        "product:update",
        (transaction, identity) =>
          configureProductVariants(transaction, identity, {
            expectedVersion: 1,
            id: historicalProductId,
            options: [{ name: "color", values: ["Azul"] }],
            requestId: randomUUID(),
            variants: [{ values: { color: "Azul" } }],
          })
      ),
      ProductDefaultVariantStockHistoryConflictError
    );

    const concurrentProductId = await createTestProduct(
      runtime.database,
      fixtureA,
      "concurrent-balance"
    );
    const concurrentVariantId = await getDefaultVariantId(
      runtime.database,
      fixtureA,
      concurrentProductId
    );
    const positiveSessions = await Promise.all(
      Array.from({ length: 8 }, () => createRuntimeSession(connectionString))
    );
    runtimeSessions.push(...positiveSessions);
    const positiveResults = await Promise.allSettled(
      positiveSessions.map((session) =>
        withAuthorizedTenantTransaction(
          session.database,
          {
            authenticatedUserId: fixtureA.userId,
            capability: "inventory:adjust",
            requestedOrganizationId: fixtureA.organizationId,
          },
          (transaction, identity) =>
            recordStockMovement(transaction, identity, {
              movementType: "receipt",
              quantityDelta: 1,
              requestId: randomUUID(),
              variantId: concurrentVariantId,
            })
        )
      )
    );
    assert.equal(
      positiveResults.filter((result) => result.status === "fulfilled").length,
      8
    );

    const negativeSessions = await Promise.all(
      Array.from({ length: 2 }, () => createRuntimeSession(connectionString))
    );
    runtimeSessions.push(...negativeSessions);
    const negativeResults = await Promise.allSettled(
      negativeSessions.map((session) =>
        withAuthorizedTenantTransaction(
          session.database,
          {
            authenticatedUserId: fixtureA.userId,
            capability: "inventory:adjust",
            requestedOrganizationId: fixtureA.organizationId,
          },
          (transaction, identity) =>
            recordStockMovement(transaction, identity, {
              movementType: "write_off",
              quantityDelta: -6,
              requestId: randomUUID(),
              variantId: concurrentVariantId,
            })
        )
      )
    );
    assert.equal(
      negativeResults.filter((result) => result.status === "fulfilled").length,
      1
    );
    const rejectedNegative = negativeResults.find(
      (result) => result.status === "rejected"
    );
    assert.ok(rejectedNegative && rejectedNegative.status === "rejected");
    assert.ok(rejectedNegative.reason instanceof InsufficientStockError);

    const concurrentBalance = await withTenant(
      runtime.database,
      fixtureA,
      "inventory:adjust",
      (transaction, identity) =>
        getInventoryBalance(transaction, identity, concurrentVariantId)
    );
    assert.equal(concurrentBalance.quantity, 2);

    const productB = await createTestProduct(
      runtime.database,
      fixtureB,
      "cross-tenant"
    );
    const variantB = await getDefaultVariantId(
      runtime.database,
      fixtureB,
      productB
    );
    const movementB = await withTenant(
      runtime.database,
      fixtureB,
      "inventory:adjust",
      async (transaction, identity) => {
        const result = await recordStockMovement(transaction, identity, {
          movementType: "receipt",
          quantityDelta: 1,
          requestId: randomUUID(),
          variantId: variantB,
        });
        return result.movement.id;
      }
    );

    await withRuntimeGucs(
      runtime.client,
      fixtureA.userId,
      fixtureB.organizationId,
      async () => {
        const visible = await runtime.client.query(
          "SELECT id FROM public.stock_movements WHERE id = $1",
          [movementB]
        );
        assert.deepEqual(visible.rows, []);
      }
    );
    await expectSqlState(
      withRuntimeGucs(
        runtime.client,
        fixtureA.userId,
        fixtureA.organizationId,
        () =>
          runtime.client.query(
            "INSERT INTO public.stock_movements " +
              "(organization_id, product_id, variant_id, movement_type, quantity_delta) " +
              "VALUES ($1, $2, $3, 'receipt', 1)",
            [fixtureB.organizationId, productB, variantB]
          )
      ),
      "42501",
      "cross-tenant inventory movement insert"
    );

    await withRuntimeGucs(
      runtime.client,
      fixtureA.userId,
      fixtureA.organizationId,
      () =>
        expectSqlState(
          runtime.client.query(
            "UPDATE public.stock_movements SET quantity_delta = 2 WHERE id = $1",
            [movementB]
          ),
          "42501",
          "runtime movement update"
        )
    );
    await withRuntimeGucs(
      runtime.client,
      fixtureA.userId,
      fixtureA.organizationId,
      () =>
        expectSqlState(
          runtime.client.query(
            "DELETE FROM public.stock_movements WHERE id = $1",
            [movementB]
          ),
          "42501",
          "runtime movement delete"
        )
    );
    await withRuntimeGucs(
      runtime.client,
      fixtureA.userId,
      fixtureA.organizationId,
      () =>
        expectSqlState(
          runtime.client.query(
            "DELETE FROM public.product_variants WHERE id = $1",
            [historicalVariantId]
          ),
          "23001",
          "variant with stock history hard-delete"
        )
    );

    const auditCount = await admin.pool.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM public.tenant_audit_event " +
        "WHERE organization_id = $1 AND event_type = 'inventory.movement_recorded'",
      [fixtureA.organizationId]
    );
    const movementCount = await admin.pool.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM public.stock_movements " +
        "WHERE organization_id = $1",
      [fixtureA.organizationId]
    );
    assert.equal(auditCount.rows[0]?.count, movementCount.rows[0]?.count);

    console.log(
      JSON.stringify(
        {
          branch: "pr28-inventory-gate",
          database: server.current_database,
          fixtures: "synthetic fixtures retained until branch auto-expiry",
          movementCount: movementCount.rows[0]?.count,
          serverVersion: server.server_version,
          status: "passed",
          tests: [
            "PostgreSQL 18 and Drizzle migrations applied",
            "FORCE RLS and least-privilege grants",
            "absent balance reads as zero",
            "negative stock rejected without ledger writes",
            "nested savepoint rolls ledger and balance back together",
            "inventory capability enforced at repository boundary",
            "default variant configuration blocked after history even at zero",
            "concurrent receipts serialize into the materialized balance",
            "concurrent write-offs cannot commit a negative balance",
            "cross-tenant reads and writes denied",
            "runtime cannot update or delete ledger rows",
            "variant with ledger history cannot be hard-deleted",
            "inventory movement audit is written for each committed movement",
          ],
        },
        null,
        2
      )
    );
  } finally {
    const closeResults = await Promise.allSettled([
      ...runtimeSessions.map((session) => session.client.end()),
      admin.pool.end(),
    ]);
    const closeErrors = closeResults
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (closeErrors.length > 0) {
      console.error("Could not close every PR28 inventory gate connection.");
      process.exitCode = 1;
    }
    if (runtimeRoleMembershipGrantAttempted && adminRoleName) {
      const cleanup = createDatabase(connectionString);
      try {
        await cleanup.pool.query(
          `REVOKE "${runtimeRole}" FROM "${adminRoleName}"`
        );
        const membership = await cleanup.pool.query<{
          can_set_runtime_role: boolean;
        }>(
          "SELECT pg_has_role(current_user, $1, 'SET') AS can_set_runtime_role",
          [runtimeRole]
        );
        if (membership.rows[0]?.can_set_runtime_role !== false) {
          console.error("Temporary runtime-role membership was not restored.");
          process.exitCode = 1;
        }
      } catch {
        console.error("Could not restore temporary runtime-role membership.");
        process.exitCode = 1;
      } finally {
        await cleanup.pool.end();
      }
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown error";
  console.error("PR28 inventory gate failed:", message);
  process.exitCode = 1;
});
