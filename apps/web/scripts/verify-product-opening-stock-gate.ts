import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createDatabase } from "@polaris/db/client";
import { organizationToday } from "@polaris/db/inventory-repository";
import {
  type TenantRequestIdentity,
  type TenantRequestTransaction,
  withAuthorizedTenantTransaction,
} from "@polaris/db/tenant-transaction";
import { ProductIdConflictError } from "@polaris/domain/catalog/product";
import { InventoryOccurredInFutureError } from "@polaris/domain/inventory/inventory";
import {
  type CreateProductWithOpeningStockInput,
  createProductWithOpeningStock,
  ProductCreateConflictError,
} from "../src/server/use-cases/create-product-with-opening-stock";
import { syncCommandHandlers } from "../src/server/sync/registry";

/**
 * A product with its price and its opening stock in ONE step (AC-24 of the Início, §3 of the design), run through the
 * real use case on the real schema: the product, the variant and the stock exist together or not at all; a quantity
 * with a cost is a receipt and a quantity with no cost is a count from zero with the cost unknown (a receipt always
 * carries a cost); a repeat after a lost answer writes nothing twice, and a repeat with other data is refused; two
 * calls at once with the same product ID write once; and the store of another organization never meets the
 * product. The sync command reaches the same use case, with the date the device wrote.
 *
 * The role that holds `product:create` but not `inventory:adjust` cannot exist in the database (the only role is
 * the owner, and `memberships_role_check` says so): that proof, with no write at all, is in the unit suite of the
 * use case.
 */
const neonHostPattern =
  /^ep-[a-z-]+-[a-z0-9]+\.c-2\.sa-east-1\.aws\.neon\.tech$/;
const branchPattern = /^pr\d+-[a-z0-9-]+-gate$/;
const localHostPattern = /^(localhost|127\.0\.0\.1|postgres)$/;
const poolerPattern = /pooler/i;
const runtimeRole = "polaris_pr11_runtime";
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";
const DAY = 86_400_000;
const ZONE = "America/Sao_Paulo";
const calendarDate = (offsetDays: number) =>
  // the organization's calendar (America/Sao_Paulo), not UTC's
  new Date(Date.now() + offsetDays * DAY).toLocaleDateString("en-CA", {
    timeZone: ZONE,
  });

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}.`);
  }
  return value;
}

/** The input of the RPC: the stock without a date, which the server reads as the store's today. */
type RpcProductInput = Omit<
  CreateProductWithOpeningStockInput,
  "initialStock"
> & {
  initialStock?: Omit<
    NonNullable<CreateProductWithOpeningStockInput["initialStock"]>,
    "occurredOn"
  > | null;
};

interface Tenant {
  organizationId: string;
  userId: string;
}

async function createTenant(
  pool: ReturnType<typeof createDatabase>["pool"],
  label: string
): Promise<Tenant> {
  const userId = randomUUID();
  const organizationId = randomUUID();
  await pool.query(
    'INSERT INTO public."user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)',
    [userId, `Opening stock ${label}`, `opening-${userId}@example.invalid`]
  );
  await pool.query(
    "INSERT INTO public.organizations (id, name, timezone) VALUES ($1, $2, $3)",
    [organizationId, `Opening stock ${label}`, ZONE]
  );
  await pool.query(
    "INSERT INTO public.memberships (organization_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')",
    [organizationId, userId]
  );
  await pool.query(
    "INSERT INTO public.organization_billing (organization_id, state, access_ends_at) VALUES ($1, 'active', now() + interval '365 days')",
    [organizationId]
  );
  return { organizationId, userId };
}

function redactedFailure(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`.replace(
      /postgres(?:ql)?:\/\/\S+/gi,
      "[redacted]"
    );
  }
  return "unknown failure";
}

async function run() {
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, branchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.ok(
    neonHostPattern.test(parsedAdminUrl.hostname) ||
      (process.env.CI === "true" &&
        localHostPattern.test(parsedAdminUrl.hostname))
  );
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
    assert.equal(serverRow.database_name, expectedDatabase);
    assert.ok(Number(serverRow.server_version_num) >= 180_000);
    tests.push(
      "disposable PostgreSQL 18 database with every migration applied"
    );

    const tenantA = await createTenant(admin.pool, "A");
    const tenantB = await createTenant(admin.pool, "B");
    const loginSuffix = randomUUID().replaceAll("-", "");
    loginRole = `polaris_opening_gate_${loginSuffix}`;
    const loginPassword = randomBytes(24).toString("hex");
    await admin.pool.query(
      `CREATE ROLE "${loginRole}" WITH LOGIN INHERIT PASSWORD '${loginPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
    );
    await admin.pool.query(`GRANT "${runtimeRole}" TO "${loginRole}"`);
    const runtimeUrl = new URL(adminUrl);
    runtimeUrl.username = loginRole;
    runtimeUrl.password = loginPassword;
    runtime = createDatabase(runtimeUrl.toString(), { maxConnections: 10 });
    const { db } = runtime;

    const asTenant = <T>(
      tenant: Tenant,
      capability: string,
      operation: (
        transaction: TenantRequestTransaction,
        identity: TenantRequestIdentity
      ) => Promise<T>
    ) =>
      withAuthorizedTenantTransaction(
        db,
        {
          authenticatedUserId: tenant.userId,
          capability,
          requestedOrganizationId: tenant.organizationId,
        },
        operation
      );

    const today = calendarDate(0);
    /** What the RPC does: `product:create`, the date read on the server. */
    const rpc = (tenant: Tenant, input: RpcProductInput, occurredOn?: string) =>
      asTenant(tenant, "product:create", async (transaction, identity) =>
        createProductWithOpeningStock(transaction, identity, {
          ...input,
          initialStock: input.initialStock
            ? {
                ...input.initialStock,
                occurredOn:
                  occurredOn ??
                  (await organizationToday(transaction, identity)),
              }
            : null,
        })
      );

    const ids = () => ({
      commandId: randomUUID(),
      productId: randomUUID(),
      variantId: randomUUID(),
    });
    const scalar = async (sql: string, ...params: unknown[]) =>
      Number(
        (await admin.pool.query<{ n: string }>(sql, params)).rows[0]?.n ?? "-1"
      );
    /** Everything the one creation can leave behind, by the product's ID. */
    const footprint = async (productId: string, variantId: string) => ({
      audit: await scalar(
        "SELECT count(*)::text AS n FROM public.tenant_audit_event WHERE entity_id = $1 OR entity_id IN (SELECT id::text FROM public.stock_movements WHERE variant_id = $2)",
        productId,
        variantId
      ),
      balances: await scalar(
        "SELECT count(*)::text AS n FROM public.inventory_balances WHERE variant_id = $1",
        variantId
      ),
      movements: await scalar(
        "SELECT count(*)::text AS n FROM public.stock_movements WHERE variant_id = $1",
        variantId
      ),
      products: await scalar(
        "SELECT count(*)::text AS n FROM public.products WHERE id = $1",
        productId
      ),
      variants: await scalar(
        "SELECT count(*)::text AS n FROM public.product_variants WHERE id = $1",
        variantId
      ),
    });
    const NOTHING = {
      audit: 0,
      balances: 0,
      movements: 0,
      products: 0,
      variants: 0,
    };

    // ======================================================================
    // 1. The three shapes of the opening stock, and the date of the server
    // ======================================================================
    const withCost = ids();
    const created = await rpc(tenantA, {
      initialStock: {
        commandId: withCost.commandId,
        quantity: 10,
        unitCost: "12.50",
      },
      listPrice: "59.90",
      name: "Camiseta básica",
      productId: withCost.productId,
      variantId: withCost.variantId,
    });
    assert.equal(created.repeated, false);
    assert.equal(created.initialQuantity, 10);
    assert.equal(created.variantId, withCost.variantId);
    const [receipt] = (
      await admin.pool.query<{
        average_cost: string;
        list_price: string;
        movement_type: string;
        occurred_on: string;
        quantity: number;
        quantity_delta: number;
        unit_cost: string;
        valuation_unit_cost: string | null;
      }>(
        `SELECT m.movement_type, m.quantity_delta, m.unit_cost::text AS unit_cost,
                m.valuation_unit_cost::text AS valuation_unit_cost, m.occurred_on::text AS occurred_on,
                b.quantity, b.moving_average_cost::text AS average_cost, v.list_price::text AS list_price
           FROM public.stock_movements m
           JOIN public.inventory_balances b ON b.variant_id = m.variant_id
           JOIN public.product_variants v ON v.id = m.variant_id
          WHERE m.variant_id = $1`,
        [withCost.variantId]
      )
    ).rows;
    assert.deepEqual(receipt, {
      average_cost: "12.500000",
      list_price: "59.90",
      movement_type: "receipt",
      occurred_on: today,
      quantity: 10,
      quantity_delta: 10,
      unit_cost: "12.500000",
      valuation_unit_cost: null,
    });
    assert.deepEqual(await footprint(withCost.productId, withCost.variantId), {
      audit: 2,
      balances: 1,
      movements: 1,
      products: 1,
      variants: 1,
    });
    tests.push(
      "a quantity with a cost creates the product, the variant with its price, a receipt with the cost dated today in the store's zone, the balance and the average cost, with a product event and a movement event of audit"
    );

    const unknownCost = ids();
    await rpc(tenantA, {
      initialStock: {
        commandId: unknownCost.commandId,
        quantity: 3,
        unitCost: null,
      },
      name: "Caneca esmaltada",
      productId: unknownCost.productId,
      variantId: unknownCost.variantId,
    });
    const [count] = (
      await admin.pool.query<{
        average_cost: string | null;
        movement_type: string;
        physical_quantity: number;
        quantity: number;
        unit_cost: string | null;
        valuation_unit_cost: string | null;
      }>(
        `SELECT m.movement_type, m.physical_quantity, m.unit_cost::text AS unit_cost,
                m.valuation_unit_cost::text AS valuation_unit_cost, b.quantity,
                b.moving_average_cost::text AS average_cost
           FROM public.stock_movements m
           JOIN public.inventory_balances b ON b.variant_id = m.variant_id
          WHERE m.variant_id = $1`,
        [unknownCost.variantId]
      )
    ).rows;
    assert.deepEqual(count, {
      average_cost: null,
      movement_type: "inventory_count",
      physical_quantity: 3,
      quantity: 3,
      unit_cost: null,
      valuation_unit_cost: null,
    });
    tests.push(
      "a quantity with no cost opens the stock as a count from zero: the balance is the quantity, and the unit cost, the valuation cost and the average cost stay null (the cost is unknown, never zero)"
    );

    const zeroCost = ids();
    await rpc(tenantA, {
      initialStock: {
        commandId: zeroCost.commandId,
        quantity: 2,
        unitCost: "0",
      },
      name: "Brinde",
      productId: zeroCost.productId,
      variantId: zeroCost.variantId,
    });
    const [zero] = (
      await admin.pool.query<{ average_cost: string; unit_cost: string }>(
        `SELECT m.unit_cost::text AS unit_cost, b.moving_average_cost::text AS average_cost
           FROM public.stock_movements m
           JOIN public.inventory_balances b ON b.variant_id = m.variant_id
          WHERE m.variant_id = $1 AND m.movement_type = 'receipt'`,
        [zeroCost.variantId]
      )
    ).rows;
    assert.deepEqual(zero, { average_cost: "0.000000", unit_cost: "0.000000" });
    tests.push("a cost of zero is a known cost: a receipt with cost 0");

    const bare = ids();
    await rpc(tenantA, {
      name: "Meia",
      productId: bare.productId,
      variantId: bare.variantId,
    });
    assert.deepEqual(await footprint(bare.productId, bare.variantId), {
      audit: 1,
      balances: 0,
      movements: 0,
      products: 1,
      variants: 1,
    });
    tests.push(
      "no quantity creates only the product and its variant: no balance, no movement"
    );

    // ======================================================================
    // 2. A failure of the stock leaves nothing, not even the product
    // ======================================================================
    for (const unitCost of ["8.00", null]) {
      const doomed = ids();
      // biome-ignore lint/performance/noAwaitInLoops: each failure is verified on its own
      await assert.rejects(
        rpc(
          tenantA,
          {
            initialStock: {
              commandId: doomed.commandId,
              quantity: 5,
              unitCost,
            },
            name: "Nunca existiu",
            productId: doomed.productId,
            variantId: doomed.variantId,
          },
          // after the store's today: the product is written first and the stock then refuses
          calendarDate(2)
        ),
        InventoryOccurredInFutureError
      );
      assert.deepEqual(
        await footprint(doomed.productId, doomed.variantId),
        NOTHING
      );
    }
    tests.push(
      "a failure of the stock, after the product and the variant were written, leaves no product, variant, balance, movement or audit event, with a receipt and with a count"
    );

    // ======================================================================
    // 3. A repeat after a lost answer
    // ======================================================================
    const before = await footprint(withCost.productId, withCost.variantId);
    const again = await rpc(tenantA, {
      initialStock: {
        commandId: withCost.commandId,
        quantity: 10,
        unitCost: "12.50",
      },
      listPrice: "59.90",
      name: "Camiseta básica",
      productId: withCost.productId,
      variantId: withCost.variantId,
    });
    assert.equal(again.repeated, true);
    assert.equal(again.product.id, withCost.productId);
    assert.deepEqual(
      await footprint(withCost.productId, withCost.variantId),
      before
    );
    const otherCommand = await rpc(tenantA, {
      initialStock: {
        commandId: randomUUID(),
        quantity: 10,
        unitCost: "12.5",
      },
      listPrice: "59.90",
      name: "Camiseta básica",
      productId: withCost.productId,
      variantId: withCost.variantId,
    });
    assert.equal(otherCommand.repeated, true);
    assert.deepEqual(
      await footprint(withCost.productId, withCost.variantId),
      before
    );
    const again0 = await rpc(tenantA, {
      name: "Meia",
      productId: bare.productId,
      variantId: bare.variantId,
    });
    assert.equal(again0.repeated, true);
    const againCount = await rpc(tenantA, {
      initialStock: {
        commandId: unknownCost.commandId,
        quantity: 3,
        unitCost: null,
      },
      name: "Caneca esmaltada",
      productId: unknownCost.productId,
      variantId: unknownCost.variantId,
    });
    assert.equal(againCount.repeated, true);
    assert.equal(
      await scalar(
        "SELECT count(*)::text AS n FROM public.stock_movements WHERE variant_id = $1",
        unknownCost.variantId
      ),
      1
    );
    tests.push(
      "the same creation again (same command, another command with the same stock, none, and the count with an unknown cost) is a repeat: it writes nothing and answers the stored product"
    );

    const conflicts: RpcProductInput[] = [
      {
        initialStock: {
          commandId: withCost.commandId,
          quantity: 11,
          unitCost: "12.50",
        },
        listPrice: "59.90",
        name: "Camiseta básica",
      },
      {
        initialStock: {
          commandId: randomUUID(),
          quantity: 10,
          unitCost: "13.00",
        },
        listPrice: "59.90",
        name: "Camiseta básica",
      },
      { listPrice: "59.90", name: "Camiseta básica" },
      {
        initialStock: {
          commandId: withCost.commandId,
          quantity: 10,
          unitCost: "12.50",
        },
        listPrice: "49.90",
        name: "Camiseta básica",
      },
      {
        initialStock: {
          commandId: withCost.commandId,
          quantity: 10,
          unitCost: "12.50",
        },
        listPrice: "59.90",
        name: "Outro nome",
      },
    ];
    for (const conflict of conflicts) {
      // biome-ignore lint/performance/noAwaitInLoops: each conflict is verified on its own
      await assert.rejects(
        rpc(tenantA, {
          ...conflict,
          productId: withCost.productId,
          variantId: withCost.variantId,
        }),
        ProductCreateConflictError
      );
    }
    // stock now, none before
    await assert.rejects(
      rpc(tenantA, {
        initialStock: {
          commandId: randomUUID(),
          quantity: 1,
          unitCost: null,
        },
        name: "Meia",
        productId: bare.productId,
        variantId: bare.variantId,
      }),
      ProductCreateConflictError
    );
    assert.deepEqual(
      await footprint(withCost.productId, withCost.variantId),
      before
    );
    assert.equal(
      await scalar(
        "SELECT count(*)::text AS n FROM public.stock_movements WHERE variant_id = $1",
        bare.variantId
      ),
      0
    );
    tests.push(
      "the same product ID with another quantity, cost, price, name, or with stock that was not there, is refused as product_create_conflict and writes nothing"
    );

    // ======================================================================
    // 4. Two calls at once
    // ======================================================================
    const racing = ids();
    const racingInput: RpcProductInput = {
      initialStock: {
        commandId: racing.commandId,
        quantity: 7,
        unitCost: "5.00",
      },
      name: "Corrida",
      productId: racing.productId,
      variantId: racing.variantId,
    };
    const results = await Promise.allSettled([
      rpc(tenantA, racingInput),
      rpc(tenantA, racingInput),
    ]);
    assert.deepEqual(
      results.map((settled) => settled.status),
      ["fulfilled", "fulfilled"]
    );
    assert.deepEqual(
      results
        .map((settled) =>
          settled.status === "fulfilled" ? settled.value.repeated : null
        )
        .sort(),
      [false, true]
    );
    assert.deepEqual(await footprint(racing.productId, racing.variantId), {
      audit: 2,
      balances: 1,
      movements: 1,
      products: 1,
      variants: 1,
    });
    const racingConflict = ids();
    const conflictResults = await Promise.allSettled([
      rpc(tenantA, {
        initialStock: {
          commandId: racingConflict.commandId,
          quantity: 7,
          unitCost: "5.00",
        },
        name: "Corrida 2",
        productId: racingConflict.productId,
        variantId: racingConflict.variantId,
      }),
      rpc(tenantA, {
        initialStock: {
          commandId: racingConflict.commandId,
          quantity: 8,
          unitCost: "5.00",
        },
        name: "Corrida 2",
        productId: racingConflict.productId,
        variantId: racingConflict.variantId,
      }),
    ]);
    assert.deepEqual(conflictResults.map((settled) => settled.status).sort(), [
      "fulfilled",
      "rejected",
    ]);
    const refused = conflictResults.find(
      (settled) => settled.status === "rejected"
    );
    assert.ok(
      refused?.status === "rejected" &&
        refused.reason instanceof ProductCreateConflictError
    );
    assert.equal(
      (await footprint(racingConflict.productId, racingConflict.variantId))
        .movements,
      1
    );
    tests.push(
      "two calls at once with the same product ID write once (one creates, the other repeats), and with different data one is refused"
    );

    // ======================================================================
    // 5. Another organization never meets the product
    // ======================================================================
    await assert.rejects(
      rpc(tenantB, {
        initialStock: {
          commandId: randomUUID(),
          quantity: 1,
          unitCost: "1.00",
        },
        name: "Camiseta básica",
        productId: withCost.productId,
        variantId: randomUUID(),
      }),
      ProductIdConflictError
    );
    assert.equal(
      await scalar(
        "SELECT count(*)::text AS n FROM public.products WHERE organization_id = $1",
        tenantB.organizationId
      ),
      0
    );
    tests.push(
      "a product ID that belongs to another store is the conflict of today (product_id_conflict), never a repeat, and creates nothing"
    );

    // ======================================================================
    // 6. The sync command reaches the same use case
    // ======================================================================
    const handler = syncCommandHandlers.find(
      (candidate) => candidate.type === "product.create"
    );
    assert.ok(handler);
    const synced = ids();
    const payload = handler.parse({
      categoryId: null,
      description: null,
      initialStock: { occurredOn: today, quantity: 6, unitCost: null },
      listPrice: "19.90",
      name: "Do aparelho",
      productId: synced.productId,
      sku: null,
      variantId: synced.variantId,
    });
    assert.deepEqual(handler.extraCapabilities?.(payload), [
      "inventory:adjust",
    ]);
    const result = await asTenant(
      tenantA,
      "sync:push",
      (transaction, identity) =>
        handler.execute(transaction, identity, payload, {
          baseVersion: null,
          commandId: synced.commandId,
        })
    );
    assert.deepEqual(result, {
      initialQuantity: 6,
      productId: synced.productId,
      variantId: synced.variantId,
      version: 1,
    });
    const [syncedCount] = (
      await admin.pool.query<{
        command_id: string;
        movement_type: string;
        occurred_on: string;
        unit_cost: string | null;
      }>(
        "SELECT movement_type, command_id::text AS command_id, occurred_on::text AS occurred_on, unit_cost::text AS unit_cost FROM public.stock_movements WHERE variant_id = $1",
        [synced.variantId]
      )
    ).rows;
    assert.deepEqual(syncedCount, {
      command_id: synced.commandId,
      movement_type: "inventory_count",
      occurred_on: today,
      unit_cost: null,
    });
    tests.push(
      "the sync command product.create runs the same use case: an unknown cost opens the stock as a count under the command's own ID, dated as the device wrote"
    );

    // the books still balance
    const negative = await scalar(
      "SELECT count(*)::text AS n FROM public.inventory_balances WHERE organization_id = $1 AND quantity < 0",
      tenantA.organizationId
    );
    assert.equal(negative, 0);
    const reconciled = await admin.pool.query<{ ok: boolean }>(
      `SELECT bool_and(b.quantity = coalesce((SELECT sum(m.quantity_delta) FROM public.stock_movements m WHERE m.variant_id = b.variant_id), 0)) AS ok
         FROM public.inventory_balances b WHERE b.organization_id = $1`,
      [tenantA.organizationId]
    );
    assert.equal(reconciled.rows[0]?.ok, true);
    tests.push(
      "afterwards no balance is negative and the ledger explains every balance"
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
      await admin.pool.query(`DROP ROLE IF EXISTS "${loginRole}"`);
    }
    await admin.pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    `Product opening stock gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
