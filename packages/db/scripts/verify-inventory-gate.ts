import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  ProductDefaultVariantStockHistoryConflictError,
  ProductDeletedError,
  ProductLifecycleError,
  ProductStockNotEmptyError,
} from "@polaris/domain/catalog/product";
import {
  InsufficientStockError,
  InvalidStockMovementError,
  InventoryVersionConflictError,
  StockCommandConflictError,
} from "@polaris/domain/inventory/inventory";
import { InvalidInventoryCountInputError } from "@polaris/domain/inventory/inventory-count";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { createDatabase } from "../src/client";
import {
  getInventoryBalance,
  inventoryCount,
  receiveStock,
  recordStockMovement,
  writeOffStock,
} from "../src/inventory-repository";
import {
  configureProductVariants,
  createProduct,
  deleteProduct,
  listProducts,
  restoreProduct,
  setProductVariantSku,
} from "../src/product-repository";
import { stockMovements } from "../src/schema/inventory";
import { productVariants } from "../src/schema/product";
import {
  type TenantRequestIdentity,
  type TenantRequestTransaction,
  withAuthorizedTenantTransaction,
} from "../src/tenant-transaction";

const gateDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

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
    throw new Error("Missing PR32 product tombstone gate configuration.");
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
    [userId, `PR31 inventory gate ${label}`, `pr31-${userId}@example.invalid`]
  );
  await adminPool.query(
    "INSERT INTO public.organizations (id, name, timezone) VALUES ($1, $2, $3)",
    [organizationId, `PR31 inventory gate ${label}`, "America/Sao_Paulo"]
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
  assert.equal(confirmation, "polaris-pr31-inventory-gate");

  const connection = new URL(connectionString);
  assert.equal(connection.protocol, "postgresql:");
  assert.equal(connection.pathname, `/${gateDatabase}`);
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
    assert.equal(server.current_database, gateDatabase);
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
    assert.ok((migrationCount.rows[0]?.count ?? 0) >= 3);
    const legacyReceiptConstraint = await admin.pool.query<{
      convalidated: boolean;
    }>(
      "SELECT convalidated FROM pg_catalog.pg_constraint " +
        "WHERE conname = $1 AND conrelid = 'public.stock_movements'::regclass",
      ["stock_movements_receipt_cost_and_command_required"]
    );
    assert.equal(legacyReceiptConstraint.rows.length, 1);
    assert.equal(legacyReceiptConstraint.rows[0]?.convalidated, false);

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
          writeOffStock(transaction, identity, {
            commandId: randomUUID(),
            commandVersion: 1,
            occurredOn: "2026-10-09",
            quantity: 1,
            reasonCode: "damaged",
            requestId: randomUUID(),
            variantId: emptyVariantId,
          }),
          InsufficientStockError
        );
        await assert.rejects(
          recordStockMovement(transaction, identity, {
            movementType: "write_off" as never,
            quantityDelta: -1,
            requestId: randomUUID(),
            variantId: emptyVariantId,
          }),
          InvalidStockMovementError
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
          receiveStock(transaction, identity, {
            commandId: randomUUID(),
            commandVersion: 1,
            occurredOn: "2026-10-09",
            quantity: 1,
            requestId: randomUUID(),
            unitCost: "1.00",
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
          receiveStock(transaction, identity, {
            commandId: randomUUID(),
            commandVersion: 1,
            occurredOn: "2026-10-09",
            quantity: 5,
            requestId: "invalid-request-id",
            unitCost: "1.00",
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

    const receiptProductId = await createTestProduct(
      runtime.database,
      fixtureA,
      "receipt-cost"
    );
    const receiptVariantId = await getDefaultVariantId(
      runtime.database,
      fixtureA,
      receiptProductId
    );
    const receiptInput = {
      commandId: randomUUID(),
      commandVersion: 1 as const,
      occurredOn: "2026-10-09",
      quantity: 2,
      unitCost: "10.00",
      variantId: receiptVariantId,
    };
    const firstReceipt = await withTenant(
      runtime.database,
      fixtureA,
      "inventory:adjust",
      (transaction, identity) =>
        receiveStock(transaction, identity, {
          ...receiptInput,
          requestId: randomUUID(),
        })
    );
    assert.equal(firstReceipt.replayed, false);
    assert.equal(firstReceipt.balance.quantity, 2);
    assert.equal(firstReceipt.balance.movingAverageCost, "10.000000");
    assert.equal(firstReceipt.movement.unitCost, "10.000000");
    assert.equal(firstReceipt.movement.occurredOn, receiptInput.occurredOn);
    assert.equal(firstReceipt.movement.commandId, receiptInput.commandId);

    const replayedReceipt = await withTenant(
      runtime.database,
      fixtureA,
      "inventory:adjust",
      (transaction, identity) =>
        receiveStock(transaction, identity, {
          ...receiptInput,
          requestId: randomUUID(),
        })
    );
    assert.equal(replayedReceipt.replayed, true);
    assert.equal(replayedReceipt.movement.id, firstReceipt.movement.id);
    assert.equal(replayedReceipt.balance.quantity, 2);

    await assert.rejects(
      withTenant(
        runtime.database,
        fixtureA,
        "inventory:adjust",
        (transaction, identity) =>
          receiveStock(transaction, identity, {
            ...receiptInput,
            quantity: 3,
            requestId: randomUUID(),
          })
      ),
      StockCommandConflictError
    );

    const secondReceipt = await withTenant(
      runtime.database,
      fixtureA,
      "inventory:adjust",
      (transaction, identity) =>
        receiveStock(transaction, identity, {
          commandId: randomUUID(),
          commandVersion: 1,
          occurredOn: "2026-10-09",
          quantity: 1,
          requestId: randomUUID(),
          unitCost: "10.000001",
          variantId: receiptVariantId,
        })
    );
    assert.equal(secondReceipt.balance.quantity, 3);
    assert.equal(secondReceipt.balance.movingAverageCost, "10.000000");

    const tieProductId = await createTestProduct(
      runtime.database,
      fixtureA,
      "receipt-rounding-tie"
    );
    const tieVariantId = await getDefaultVariantId(
      runtime.database,
      fixtureA,
      tieProductId
    );
    await withTenant(
      runtime.database,
      fixtureA,
      "inventory:adjust",
      (transaction, identity) =>
        receiveStock(transaction, identity, {
          commandId: randomUUID(),
          commandVersion: 1,
          occurredOn: "2026-10-09",
          quantity: 1,
          requestId: randomUUID(),
          unitCost: "0",
          variantId: tieVariantId,
        })
    );
    const roundedTie = await withTenant(
      runtime.database,
      fixtureA,
      "inventory:adjust",
      (transaction, identity) =>
        receiveStock(transaction, identity, {
          commandId: randomUUID(),
          commandVersion: 1,
          occurredOn: "2026-10-09",
          quantity: 1,
          requestId: randomUUID(),
          unitCost: "0.000001",
          variantId: tieVariantId,
        })
    );
    assert.equal(roundedTie.balance.movingAverageCost, "0.000001");

    await expectSqlState(
      withRuntimeGucs(
        runtime.client,
        fixtureA.userId,
        fixtureA.organizationId,
        () =>
          runtime.client.query(
            "INSERT INTO public.stock_movements " +
              "(organization_id, product_id, variant_id, movement_type, quantity_delta, unit_cost, command_id, command_version, occurred_on) " +
              "VALUES ($1, $2, $3, 'receipt', 1, 1.1234567, $4, 1, $5)",
            [
              fixtureA.organizationId,
              receiptProductId,
              receiptVariantId,
              randomUUID(),
              "2026-10-09",
            ]
          )
      ),
      "23514",
      "stock unit-cost scale check"
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
            [fixtureA.organizationId, receiptProductId, receiptVariantId]
          )
      ),
      "23514",
      "receipt cost and command metadata check"
    );
    const writeOffReasonConstraint = await runtime.client.query<{
      convalidated: boolean;
    }>(
      "SELECT convalidated FROM pg_constraint " +
        "WHERE conrelid = 'public.stock_movements'::regclass " +
        "AND conname = $1",
      ["stock_movements_write_off_reason_valid"]
    );
    assert.equal(writeOffReasonConstraint.rows.length, 1);
    assert.equal(writeOffReasonConstraint.rows[0]?.convalidated, false);
    await expectSqlState(
      withRuntimeGucs(
        runtime.client,
        fixtureA.userId,
        fixtureA.organizationId,
        () =>
          runtime.client.query(
            "INSERT INTO public.stock_movements " +
              "(organization_id, product_id, variant_id, movement_type, quantity_delta, command_id, command_version, occurred_on) " +
              "VALUES ($1, $2, $3, 'write_off', -1, $4, 1, $5)",
            [
              fixtureA.organizationId,
              receiptProductId,
              receiptVariantId,
              randomUUID(),
              "2026-10-09",
            ]
          )
      ),
      "23514",
      "new write-off requires a structured reason"
    );
    await expectSqlState(
      withRuntimeGucs(
        runtime.client,
        fixtureA.userId,
        fixtureA.organizationId,
        () =>
          runtime.client.query(
            "INSERT INTO public.stock_movements " +
              "(organization_id, product_id, variant_id, movement_type, quantity_delta, command_id, command_version, occurred_on, reason_code, reason_note) " +
              "VALUES ($1, $2, $3, 'write_off', -1, $4, 1, $5, 'damaged', repeat('x', 501))",
            [
              fixtureA.organizationId,
              receiptProductId,
              receiptVariantId,
              randomUUID(),
              "2026-10-09",
            ]
          )
      ),
      "23514",
      "write-off reason note code-point limit"
    );
    await expectSqlState(
      withRuntimeGucs(
        runtime.client,
        fixtureA.userId,
        fixtureA.organizationId,
        () =>
          runtime.client.query(
            "INSERT INTO public.stock_movements " +
              "(organization_id, product_id, variant_id, movement_type, quantity_delta, command_id, command_version, occurred_on, reason_code, reason_note) " +
              "VALUES ($1, $2, $3, 'write_off', -1, $4, 1, $5, 'damaged', chr(160))",
            [
              fixtureA.organizationId,
              receiptProductId,
              receiptVariantId,
              randomUUID(),
              "2026-10-09",
            ]
          )
      ),
      "23514",
      "write-off reason note whitespace normalization"
    );
    await expectSqlState(
      withRuntimeGucs(
        runtime.client,
        fixtureA.userId,
        fixtureA.organizationId,
        () =>
          runtime.client.query(
            "UPDATE public.inventory_balances " +
              "SET moving_average_cost = 1.1234567 " +
              "WHERE organization_id = $1 AND variant_id = $2",
            [fixtureA.organizationId, receiptVariantId]
          )
      ),
      "23514",
      "inventory average-cost scale check"
    );
    await expectSqlState(
      withRuntimeGucs(
        runtime.client,
        fixtureA.userId,
        fixtureA.organizationId,
        () =>
          runtime.client.query(
            "INSERT INTO public.stock_movements " +
              "(organization_id, product_id, variant_id, movement_type, quantity_delta, command_id, command_version, occurred_on) " +
              "VALUES ($1, $2, $3, 'inventory_count', 0, $4, 1, $5)",
            [
              fixtureA.organizationId,
              receiptProductId,
              receiptVariantId,
              randomUUID(),
              "2026-10-09",
            ]
          )
      ),
      "23514",
      "inventory count requires the absolute count and expected version"
    );
    await expectSqlState(
      withRuntimeGucs(
        runtime.client,
        fixtureA.userId,
        fixtureA.organizationId,
        () =>
          runtime.client.query(
            "INSERT INTO public.stock_movements " +
              "(organization_id, product_id, variant_id, movement_type, quantity_delta, command_id, command_version, occurred_on, expected_version, physical_quantity, valuation_unit_cost) " +
              "VALUES ($1, $2, $3, 'inventory_count', 0, $4, 1, $5, 0, 0, 1.00)",
            [
              fixtureA.organizationId,
              receiptProductId,
              receiptVariantId,
              randomUUID(),
              "2026-10-09",
            ]
          )
      ),
      "23514",
      "zero physical counts cannot set an explicit valuation"
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
        await receiveStock(transaction, identity, {
          commandId: randomUUID(),
          commandVersion: 1,
          occurredOn: "2026-10-09",
          quantity: 2,
          requestId: randomUUID(),
          unitCost: "10.00",
          variantId: historicalVariantId,
        });
      }
    );
    const writeOffInput = {
      commandId: randomUUID(),
      commandVersion: 1 as const,
      occurredOn: "2026-10-09",
      quantity: 1,
      reasonCode: "damaged" as const,
      reasonNote: "gate fixture damage",
      variantId: historicalVariantId,
    };
    const historicalWriteOff = await withTenant(
      runtime.database,
      fixtureA,
      "inventory:adjust",
      (transaction, identity) =>
        writeOffStock(transaction, identity, {
          ...writeOffInput,
          requestId: randomUUID(),
        })
    );
    assert.equal(historicalWriteOff.replayed, false);
    assert.equal(historicalWriteOff.movement.reasonCode, "damaged");
    assert.equal(historicalWriteOff.movement.reasonNote, "gate fixture damage");
    assert.equal(historicalWriteOff.movement.unitCost, "10.000000");
    assert.equal(historicalWriteOff.balance.movingAverageCost, "10.000000");
    assert.equal(historicalWriteOff.balance.quantity, 1);

    const replayedWriteOff = await withTenant(
      runtime.database,
      fixtureA,
      "inventory:adjust",
      (transaction, identity) =>
        writeOffStock(transaction, identity, {
          ...writeOffInput,
          requestId: randomUUID(),
        })
    );
    assert.equal(replayedWriteOff.replayed, true);
    assert.equal(replayedWriteOff.movement.id, historicalWriteOff.movement.id);
    assert.equal(replayedWriteOff.balance.quantity, 1);
    await assert.rejects(
      withTenant(
        runtime.database,
        fixtureA,
        "inventory:adjust",
        (transaction, identity) =>
          writeOffStock(transaction, identity, {
            ...writeOffInput,
            reasonNote: "different payload",
            requestId: randomUUID(),
          })
      ),
      StockCommandConflictError
    );

    const finalHistoricalWriteOff = await withTenant(
      runtime.database,
      fixtureA,
      "inventory:adjust",
      (transaction, identity) =>
        writeOffStock(transaction, identity, {
          ...writeOffInput,
          commandId: randomUUID(),
          quantity: 1,
          reasonCode: "expired",
          reasonNote: null,
          requestId: randomUUID(),
        })
    );
    assert.equal(finalHistoricalWriteOff.movement.reasonCode, "expired");
    assert.equal(finalHistoricalWriteOff.balance.quantity, 0);
    assert.equal(
      finalHistoricalWriteOff.balance.movingAverageCost,
      "10.000000"
    );
    const historicalBalance = await withTenant(
      runtime.database,
      fixtureA,
      "inventory:adjust",
      (transaction, identity) =>
        getInventoryBalance(transaction, identity, historicalVariantId)
    );
    assert.equal(historicalBalance.quantity, 0);

    const countedProductId = await createTestProduct(
      runtime.database,
      fixtureA,
      "inventory-count"
    );
    const countedVariantId = await getDefaultVariantId(
      runtime.database,
      fixtureA,
      countedProductId
    );
    const initialCountInput = {
      commandId: randomUUID(),
      commandVersion: 1 as const,
      expectedVersion: 0,
      occurredOn: "2026-10-09",
      physicalQuantity: 5,
      valuationUnitCost: "3.25",
      variantId: countedVariantId,
    };
    const initialCount = await withTenant(
      runtime.database,
      fixtureA,
      "inventory:adjust",
      (transaction, identity) =>
        inventoryCount(transaction, identity, {
          ...initialCountInput,
          requestId: randomUUID(),
        })
    );
    assert.equal(initialCount.replayed, false);
    assert.equal(initialCount.movement.quantityDelta, 5);
    assert.equal(initialCount.movement.physicalQuantity, 5);
    assert.equal(initialCount.movement.expectedVersion, 0);
    assert.equal(initialCount.movement.unitCost, "3.250000");
    assert.equal(initialCount.balance.quantity, 5);
    assert.equal(initialCount.balance.movingAverageCost, "3.250000");
    assert.equal(initialCount.balance.version, 1);

    const replayedInitialCount = await withTenant(
      runtime.database,
      fixtureA,
      "inventory:adjust",
      (transaction, identity) =>
        inventoryCount(transaction, identity, {
          ...initialCountInput,
          requestId: randomUUID(),
        })
    );
    assert.equal(replayedInitialCount.replayed, true);
    assert.equal(replayedInitialCount.movement.id, initialCount.movement.id);
    assert.equal(replayedInitialCount.balance.version, 1);
    await assert.rejects(
      withTenant(
        runtime.database,
        fixtureA,
        "inventory:adjust",
        (transaction, identity) =>
          inventoryCount(transaction, identity, {
            ...initialCountInput,
            requestId: randomUUID(),
            valuationUnitCost: null,
          })
      ),
      StockCommandConflictError
    );
    await assert.rejects(
      withTenant(
        runtime.database,
        fixtureA,
        "inventory:adjust",
        (transaction, identity) =>
          inventoryCount(transaction, identity, {
            ...initialCountInput,
            physicalQuantity: 4,
            requestId: randomUUID(),
          })
      ),
      StockCommandConflictError
    );

    const zeroDeltaCount = await withTenant(
      runtime.database,
      fixtureA,
      "inventory:adjust",
      (transaction, identity) =>
        inventoryCount(transaction, identity, {
          commandId: randomUUID(),
          commandVersion: 1,
          expectedVersion: 1,
          occurredOn: "2026-10-09",
          physicalQuantity: 5,
          requestId: randomUUID(),
          variantId: countedVariantId,
        })
    );
    assert.equal(zeroDeltaCount.movement.quantityDelta, 0);
    assert.equal(zeroDeltaCount.movement.unitCost, "3.250000");
    assert.equal(zeroDeltaCount.balance.version, 2);
    await assert.rejects(
      withTenant(
        runtime.database,
        fixtureA,
        "inventory:adjust",
        (transaction, identity) =>
          inventoryCount(transaction, identity, {
            commandId: randomUUID(),
            commandVersion: 1,
            expectedVersion: 1,
            occurredOn: "2026-10-09",
            physicalQuantity: 5,
            requestId: randomUUID(),
            variantId: countedVariantId,
          })
      ),
      InventoryVersionConflictError
    );

    const reducedCount = await withTenant(
      runtime.database,
      fixtureA,
      "inventory:adjust",
      (transaction, identity) =>
        inventoryCount(transaction, identity, {
          commandId: randomUUID(),
          commandVersion: 1,
          expectedVersion: 2,
          occurredOn: "2026-10-09",
          physicalQuantity: 3,
          requestId: randomUUID(),
          variantId: countedVariantId,
        })
    );
    assert.equal(reducedCount.movement.quantityDelta, -2);
    assert.equal(reducedCount.movement.unitCost, "3.250000");
    assert.equal(reducedCount.balance.quantity, 3);
    assert.equal(reducedCount.balance.movingAverageCost, "3.250000");
    assert.equal(reducedCount.balance.version, 3);

    const replayAfterLaterCount = await withTenant(
      runtime.database,
      fixtureA,
      "inventory:adjust",
      (transaction, identity) =>
        inventoryCount(transaction, identity, {
          ...initialCountInput,
          requestId: randomUUID(),
        })
    );
    assert.equal(replayAfterLaterCount.replayed, true);
    assert.equal(replayAfterLaterCount.balance.quantity, 3);
    assert.equal(replayAfterLaterCount.balance.version, 3);
    await assert.rejects(
      withTenant(
        runtime.database,
        fixtureA,
        "inventory:adjust",
        (transaction, identity) =>
          inventoryCount(transaction, identity, {
            commandId: randomUUID(),
            commandVersion: 1,
            expectedVersion: 3,
            occurredOn: "2026-10-09",
            physicalQuantity: 3,
            requestId: randomUUID(),
            valuationUnitCost: "4.00",
            variantId: countedVariantId,
          })
      ),
      InvalidInventoryCountInputError
    );

    const raceCountProductId = await createTestProduct(
      runtime.database,
      fixtureA,
      "inventory-count-race"
    );
    const raceCountVariantId = await getDefaultVariantId(
      runtime.database,
      fixtureA,
      raceCountProductId
    );
    await withTenant(
      runtime.database,
      fixtureA,
      "inventory:adjust",
      (transaction, identity) =>
        inventoryCount(transaction, identity, {
          commandId: randomUUID(),
          commandVersion: 1,
          expectedVersion: 0,
          occurredOn: "2026-10-09",
          physicalQuantity: 6,
          requestId: randomUUID(),
          variantId: raceCountVariantId,
        })
    );
    const countRaceSessions = await Promise.all([
      createRuntimeSession(connectionString),
      createRuntimeSession(connectionString),
    ]);
    runtimeSessions.push(...countRaceSessions);
    const countRaceResults = await Promise.allSettled(
      countRaceSessions.map((session) =>
        withAuthorizedTenantTransaction(
          session.database,
          {
            authenticatedUserId: fixtureA.userId,
            capability: "inventory:adjust",
            requestedOrganizationId: fixtureA.organizationId,
          },
          (transaction, identity) =>
            inventoryCount(transaction, identity, {
              commandId: randomUUID(),
              commandVersion: 1,
              expectedVersion: 1,
              occurredOn: "2026-10-09",
              physicalQuantity: 6,
              requestId: randomUUID(),
              variantId: raceCountVariantId,
            })
        )
      )
    );
    assert.equal(
      countRaceResults.filter((result) => result.status === "fulfilled").length,
      1
    );
    const staleCountResult = countRaceResults.find(
      (result) => result.status === "rejected"
    );
    assert.ok(staleCountResult && staleCountResult.status === "rejected");
    assert.ok(staleCountResult.reason instanceof InventoryVersionConflictError);

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

    const unknownCostProductId = await createTestProduct(
      runtime.database,
      fixtureA,
      "write-off-unknown-cost"
    );
    const unknownCostVariantId = await getDefaultVariantId(
      runtime.database,
      fixtureA,
      unknownCostProductId
    );
    await withTenant(
      runtime.database,
      fixtureA,
      "inventory:adjust",
      (transaction, identity) =>
        inventoryCount(transaction, identity, {
          commandId: randomUUID(),
          commandVersion: 1,
          expectedVersion: 0,
          occurredOn: "2026-10-09",
          physicalQuantity: 2,
          requestId: randomUUID(),
          variantId: unknownCostVariantId,
        })
    );
    const unknownCostWriteOff = await withTenant(
      runtime.database,
      fixtureA,
      "inventory:adjust",
      (transaction, identity) =>
        writeOffStock(transaction, identity, {
          commandId: randomUUID(),
          commandVersion: 1,
          occurredOn: "2026-10-09",
          quantity: 1,
          reasonCode: "lost",
          requestId: randomUUID(),
          variantId: unknownCostVariantId,
        })
    );
    assert.equal(unknownCostWriteOff.balance.quantity, 1);
    assert.equal(unknownCostWriteOff.balance.movingAverageCost, null);
    assert.equal(unknownCostWriteOff.movement.unitCost, null);

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
            receiveStock(transaction, identity, {
              commandId: randomUUID(),
              commandVersion: 1,
              occurredOn: "2026-10-09",
              quantity: 1,
              requestId: randomUUID(),
              unitCost: "10.00",
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
            writeOffStock(transaction, identity, {
              commandId: randomUUID(),
              commandVersion: 1,
              occurredOn: "2026-10-09",
              quantity: 6,
              reasonCode: "damaged",
              reasonNote: "concurrent gate write-off",
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
        const result = await receiveStock(transaction, identity, {
          commandId: randomUUID(),
          commandVersion: 1,
          occurredOn: "2026-10-09",
          quantity: 1,
          requestId: randomUUID(),
          unitCost: "1.00",
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
              "(organization_id, product_id, variant_id, movement_type, quantity_delta, unit_cost, command_id, command_version, occurred_on) " +
              "VALUES ($1, $2, $3, 'receipt', 1, 1.00, $4, 1, $5)",
            [
              fixtureB.organizationId,
              productB,
              variantB,
              randomUUID(),
              "2026-10-09",
            ]
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

    const tombstoneProductId = await createTestProduct(
      runtime.database,
      fixtureA,
      "zero-stock-tombstone"
    );
    const tombstoneVariantId = await getDefaultVariantId(
      runtime.database,
      fixtureA,
      tombstoneProductId
    );
    const tombstoneSku = `PR32-${randomUUID()}`;
    const skuUpdate = await withTenant(
      runtime.database,
      fixtureA,
      "product:update",
      (transaction, identity) =>
        setProductVariantSku(transaction, identity, {
          expectedVersion: 1,
          id: tombstoneProductId,
          requestId: randomUUID(),
          sku: tombstoneSku,
          variantId: tombstoneVariantId,
        })
    );
    assert.equal(skuUpdate.product.version, 2);

    const tombstoneReceiptCommandId = randomUUID();
    const tombstoneReceipt = {
      commandId: tombstoneReceiptCommandId,
      commandVersion: 1 as const,
      occurredOn: "2026-10-09",
      quantity: 2,
      unitCost: "10.00",
      variantId: tombstoneVariantId,
    };
    await withTenant(
      runtime.database,
      fixtureA,
      "inventory:adjust",
      (transaction, identity) =>
        receiveStock(transaction, identity, {
          ...tombstoneReceipt,
          requestId: randomUUID(),
        })
    );
    const tombstoneWriteOff = await withTenant(
      runtime.database,
      fixtureA,
      "inventory:adjust",
      (transaction, identity) =>
        writeOffStock(transaction, identity, {
          commandId: randomUUID(),
          commandVersion: 1,
          occurredOn: "2026-10-09",
          quantity: 2,
          reasonCode: "lost",
          requestId: randomUUID(),
          variantId: tombstoneVariantId,
        })
    );
    assert.equal(tombstoneWriteOff.balance.quantity, 0);

    const deletedProduct = await withTenant(
      runtime.database,
      fixtureA,
      "product:update",
      (transaction, identity) =>
        deleteProduct(transaction, identity, {
          expectedVersion: 2,
          id: tombstoneProductId,
          requestId: randomUUID(),
        })
    );
    assert.equal(deletedProduct.changed, true);
    assert.ok(deletedProduct.product.deletedAt instanceof Date);
    assert.equal(deletedProduct.product.version, 3);
    const repeatedDelete = await withTenant(
      runtime.database,
      fixtureA,
      "product:update",
      (transaction, identity) =>
        deleteProduct(transaction, identity, {
          expectedVersion: 2,
          id: tombstoneProductId,
          requestId: randomUUID(),
        })
    );
    assert.equal(repeatedDelete.changed, false);

    await assert.rejects(
      withTenant(
        runtime.database,
        fixtureA,
        "product:update",
        (transaction, identity) =>
          restoreProduct(transaction, identity, {
            expectedVersion: 3,
            id: tombstoneProductId,
            requestId: randomUUID(),
          })
      ),
      ProductLifecycleError
    );
    await assert.rejects(
      withTenant(
        runtime.database,
        fixtureA,
        "product:update",
        (transaction, identity) =>
          setProductVariantSku(transaction, identity, {
            expectedVersion: 3,
            id: tombstoneProductId,
            requestId: randomUUID(),
            sku: null,
            variantId: tombstoneVariantId,
          })
      ),
      ProductDeletedError
    );

    const activeProductsAfterTombstone = await withTenant(
      runtime.database,
      fixtureA,
      "catalog:read",
      (transaction, identity) => listProducts(transaction, identity)
    );
    const deletedProducts = await withTenant(
      runtime.database,
      fixtureA,
      "catalog:read",
      (transaction, identity) =>
        listProducts(transaction, identity, { status: "deleted" })
    );
    assert.equal(
      activeProductsAfterTombstone.some(
        (product) => product.id === tombstoneProductId
      ),
      false
    );
    assert.ok(
      deletedProducts.some((product) => product.id === tombstoneProductId)
    );

    const tombstoneBalance = await withTenant(
      runtime.database,
      fixtureA,
      "inventory:read",
      (transaction, identity) =>
        getInventoryBalance(transaction, identity, tombstoneVariantId)
    );
    assert.equal(tombstoneBalance.quantity, 0);
    const replayAfterTombstone = await withTenant(
      runtime.database,
      fixtureA,
      "inventory:adjust",
      (transaction, identity) =>
        receiveStock(transaction, identity, {
          ...tombstoneReceipt,
          requestId: randomUUID(),
        })
    );
    assert.equal(replayAfterTombstone.replayed, true);
    assert.equal(replayAfterTombstone.balance.quantity, 0);
    await assert.rejects(
      withTenant(
        runtime.database,
        fixtureA,
        "inventory:adjust",
        (transaction, identity) =>
          receiveStock(transaction, identity, {
            commandId: randomUUID(),
            commandVersion: 1,
            occurredOn: "2026-10-10",
            quantity: 1,
            requestId: randomUUID(),
            unitCost: "10.00",
            variantId: tombstoneVariantId,
          })
      ),
      ProductDeletedError
    );

    const retainedSku = await admin.pool.query<{ sku: string | null }>(
      "SELECT sku FROM public.product_variants WHERE id = $1",
      [tombstoneVariantId]
    );
    assert.equal(retainedSku.rows[0]?.sku, tombstoneSku);
    const retainedHistory = await admin.pool.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM public.stock_movements WHERE organization_id = $1 AND product_id = $2",
      [fixtureA.organizationId, tombstoneProductId]
    );
    assert.equal(retainedHistory.rows[0]?.count, 2);

    await withRuntimeGucs(
      runtime.client,
      fixtureA.userId,
      fixtureA.organizationId,
      () =>
        expectSqlState(
          runtime.client.query(
            "UPDATE public.inventory_balances SET quantity = 1 WHERE organization_id = $1 AND product_id = $2",
            [fixtureA.organizationId, tombstoneProductId]
          ),
          "23514",
          "runtime balance update after product tombstone"
        )
    );
    await withRuntimeGucs(
      runtime.client,
      fixtureA.userId,
      fixtureA.organizationId,
      () =>
        expectSqlState(
          runtime.client.query(
            "INSERT INTO public.stock_movements (organization_id, product_id, variant_id, movement_type, quantity_delta, command_id, command_version, occurred_on, reason_code) VALUES ($1, $2, $3, 'write_off', -1, $4, 1, $5, 'lost')",
            [
              fixtureA.organizationId,
              tombstoneProductId,
              tombstoneVariantId,
              randomUUID(),
              "2026-10-10",
            ]
          ),
          "23514",
          "runtime movement insert after product tombstone"
        )
    );
    await withRuntimeGucs(
      runtime.client,
      fixtureA.userId,
      fixtureA.organizationId,
      () =>
        expectSqlState(
          runtime.client.query(
            "UPDATE public.products SET name = $1 WHERE id = $2",
            ["Renamed tombstone", tombstoneProductId]
          ),
          "23514",
          "runtime update of tombstoned product"
        )
    );

    const positiveStockProductId = await createTestProduct(
      runtime.database,
      fixtureA,
      "positive-stock-tombstone"
    );
    const positiveStockVariantId = await getDefaultVariantId(
      runtime.database,
      fixtureA,
      positiveStockProductId
    );
    await withTenant(
      runtime.database,
      fixtureA,
      "inventory:adjust",
      (transaction, identity) =>
        receiveStock(transaction, identity, {
          commandId: randomUUID(),
          commandVersion: 1,
          occurredOn: "2026-10-09",
          quantity: 1,
          requestId: randomUUID(),
          unitCost: "10.00",
          variantId: positiveStockVariantId,
        })
    );
    await assert.rejects(
      withTenant(
        runtime.database,
        fixtureA,
        "product:update",
        (transaction, identity) =>
          deleteProduct(transaction, identity, {
            expectedVersion: 1,
            id: positiveStockProductId,
            requestId: randomUUID(),
          })
      ),
      ProductStockNotEmptyError
    );
    await withRuntimeGucs(
      runtime.client,
      fixtureA.userId,
      fixtureA.organizationId,
      () =>
        expectSqlState(
          runtime.client.query(
            "UPDATE public.products SET deleted_at = now(), version = version + 1, updated_at = now() WHERE id = $1",
            [positiveStockProductId]
          ),
          "23514",
          "database blocks direct tombstone while stock is positive"
        )
    );

    const racingProductId = await createTestProduct(
      runtime.database,
      fixtureA,
      "tombstone-race"
    );
    const racingVariantId = await getDefaultVariantId(
      runtime.database,
      fixtureA,
      racingProductId
    );
    const [raceDeleteSession, raceInventorySession] = await Promise.all([
      createRuntimeSession(connectionString),
      createRuntimeSession(connectionString),
    ]);
    runtimeSessions.push(raceDeleteSession, raceInventorySession);
    const raceResults = await Promise.allSettled([
      withAuthorizedTenantTransaction(
        raceDeleteSession.database,
        {
          authenticatedUserId: fixtureA.userId,
          capability: "product:update",
          requestedOrganizationId: fixtureA.organizationId,
        },
        (transaction, identity) =>
          deleteProduct(transaction, identity, {
            expectedVersion: 1,
            id: racingProductId,
            requestId: randomUUID(),
          })
      ),
      withAuthorizedTenantTransaction(
        raceInventorySession.database,
        {
          authenticatedUserId: fixtureA.userId,
          capability: "inventory:adjust",
          requestedOrganizationId: fixtureA.organizationId,
        },
        (transaction, identity) =>
          receiveStock(transaction, identity, {
            commandId: randomUUID(),
            commandVersion: 1,
            occurredOn: "2026-10-10",
            quantity: 1,
            requestId: randomUUID(),
            unitCost: "10.00",
            variantId: racingVariantId,
          })
      ),
    ]);
    const [deleteResult, receiptResult] = raceResults;
    assert.equal(
      [deleteResult, receiptResult].filter(
        (result) => result.status === "fulfilled"
      ).length,
      1
    );
    assert.equal(
      [deleteResult, receiptResult].filter(
        (result) => result.status === "rejected"
      ).length,
      1
    );
    const racingProduct = await withTenant(
      runtime.database,
      fixtureA,
      "catalog:read",
      async (transaction, identity) =>
        (await listProducts(transaction, identity, { status: "all" })).find(
          (product) => product.id === racingProductId
        )
    );
    assert.ok(racingProduct);
    const racingBalance = await withTenant(
      runtime.database,
      fixtureA,
      "inventory:read",
      (transaction, identity) =>
        getInventoryBalance(transaction, identity, racingVariantId)
    );
    if (racingProduct.deletedAt === null) {
      assert.equal(racingBalance.quantity, 1);
      assert.equal(deleteResult.status, "rejected");
      if (deleteResult.status === "rejected") {
        assert.ok(deleteResult.reason instanceof ProductStockNotEmptyError);
      }
    } else {
      assert.equal(racingBalance.quantity, 0);
      assert.equal(receiptResult.status, "rejected");
      if (receiptResult.status === "rejected") {
        assert.ok(receiptResult.reason instanceof ProductDeletedError);
      }
    }
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
          branch: "pr32-product-tombstone-gate",
          database: server.current_database,
          fixtures: "synthetic fixtures retained until branch auto-expiry",
          movementCount: movementCount.rows[0]?.count,
          serverVersion: server.server_version,
          status: "passed",
          tests: [
            "PostgreSQL 18 and PR28–32 catalog and inventory migrations applied",
            "FORCE RLS and least-privilege grants",
            "absent balance reads as zero",
            "negative stock rejected without ledger writes",
            "nested savepoint rolls ledger and balance back together",
            "inventory capability enforced at repository boundary",
            "receipt records normalized unit cost and organization date",
            "receipt replay is idempotent and payload mismatch conflicts",
            "moving average updates with six-place half-up rounding",
            "database rejects unit-cost and average-cost scales above six",
            "every receipt requires command identity and unit cost",
            "legacy receipt constraint is NOT VALID but enforced for new rows",
            "write-offs require structured reasons and reject invalid notes",
            "write-off notes enforce the 500-code-point limit and Unicode trimming",
            "writeOffStock persists occurrence date, reason, note, and known unit cost",
            "write-off replay is idempotent and payload mismatches conflict",
            "write-offs preserve average cost and allow unknown-cost balances",
            "inventoryCount stores absolute quantity, expected version, and signed delta",
            "inventory count replay is idempotent after later commands and payload mismatch conflicts",
            "valuationUnitCost input is included in the idempotent payload",
            "zero-delta counts persist as audit events and advance the balance version",
            "stale count versions conflict and concurrent counts serialize with one winner",
            "explicit valuation initializes an unknown average and known averages cannot be revalued by count",
            "explicit valuation cannot be attached to a zero physical count at the database boundary",
            "unknown-cost counts preserve null valuation without inventing zero cost",
            "database rejects new inventory_count rows without count payload metadata",
            "default variant configuration blocked after history even at zero",
            "concurrent receipts serialize into the materialized balance",
            "concurrent write-offs cannot commit a negative balance",
            "cross-tenant reads and writes denied",
            "runtime cannot update or delete ledger rows",
            "variant with ledger history cannot be hard-deleted",
            "product tombstones require zero balance but preserve SKU and movement history",
            "product tombstone is terminal, listed explicitly, and idempotent",
            "historical command replay remains idempotent after product tombstone",
            "new inventory and product writes are blocked after tombstone",
            "database blocks direct tombstone while stock is positive",
            "concurrent receipt and tombstone serialize to one valid outcome",
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
      console.error("Could not close every PR31 inventory gate connection.");
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
  console.error("PR31 inventory gate failed:", message);
  process.exitCode = 1;
});
