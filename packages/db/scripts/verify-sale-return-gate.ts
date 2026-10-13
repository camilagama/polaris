import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { SaleProductUnavailableError } from "@polaris/domain/sales/confirm-sale";
import { SaleNotFoundError } from "@polaris/domain/sales/sale-errors";
import {
  InvalidSaleReturnError,
  SaleHasReturnsError,
  SaleNotReturnableError,
  SaleReturnCommandConflictError,
  SaleReturnExceedsAvailableError,
} from "@polaris/domain/sales/sale-return";
import { createDatabase } from "../src/client";
import { receiveStock } from "../src/inventory-repository";
import { deleteProduct } from "../src/product-repository";
import { cancelSale } from "../src/sale-cancellation-repository";
import { getSale, listSales } from "../src/sale-query-repository";
import {
  type CreateSaleReturnRepositoryInput,
  createSaleReturn,
} from "../src/sale-return-repository";
import { TenantAuthorizationError } from "../src/tenant-transaction";
import {
  confirmPlainSale,
  createSellableProduct,
  createTenantFixture,
  disposableHostPattern,
  expectSqlState,
  gateBranchPattern,
  poolerPattern,
  redactedFailure,
  requiredEnvironment,
  runtimeRole,
  type TenantFixture,
  temporaryRuntimeUrl,
  withRuntimeSqlContext,
  withTenantAs,
} from "./sales-gate-support";

const expectedDatabase = process.env.POLARIS_SALES_GATE_DATABASE ?? "neondb";
const injectedFailureMessage = "pr46 gate injected failure";

type RuntimeDatabase = ReturnType<typeof createDatabase>;
type ErrorClass = abstract new (...args: never[]) => Error;
interface Line {
  position: number;
  restockedQuantity: number;
  returnedQuantity: number;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the gate is one linear list of independent scenarios
async function run() {
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, gateBranchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);

  const admin = createDatabase(adminUrl, { maxConnections: 2 });
  let runtime: RuntimeDatabase | undefined;
  let concurrent: RuntimeDatabase | undefined;
  let loginRole: string | undefined;
  let loginRoleCreated = false;
  let failureFunctionCreated = false;
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
    tests.push("disposable direct Neon connection is PostgreSQL 18");

    const migrations = await admin.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations"
    );
    assert.ok(Number(migrations.rows[0]?.count) >= 38);
    tests.push(
      "migrations 0000-0037 (and any later ones) were replayed from scratch"
    );

    const tenantA = await createTenantFixture(admin.pool, "A");
    const tenantB = await createTenantFixture(admin.pool, "B");
    const outsider = await createTenantFixture(admin.pool, "outsider");
    const loginSuffix = randomUUID().replaceAll("-", "");
    loginRole = `polaris_return_gate_${loginSuffix}`;
    const loginPassword = randomBytes(24).toString("hex");
    await admin.pool.query(
      `CREATE ROLE "${loginRole}" WITH LOGIN INHERIT PASSWORD '${loginPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
    );
    loginRoleCreated = true;
    await admin.pool.query(`GRANT "${runtimeRole}" TO "${loginRole}"`);
    const runtimeUrl = temporaryRuntimeUrl(adminUrl, loginRole, loginPassword);
    const runtimeDatabase = createDatabase(runtimeUrl, { maxConnections: 1 });
    runtime = runtimeDatabase;
    const concurrentDatabase = createDatabase(runtimeUrl, {
      maxConnections: 16,
    });
    concurrent = concurrentDatabase;
    const rt = { adminPool: admin.pool, db: runtimeDatabase.db };

    // ---------------------------------------------------------------- helpers
    const giveBack = (
      tenant: TenantFixture,
      input: Omit<
        CreateSaleReturnRepositoryInput,
        "commandId" | "commandVersion"
      > & { commandId?: string; commandVersion?: number },
      database: RuntimeDatabase = runtimeDatabase
    ) =>
      withTenantAs(
        database.db,
        tenant,
        "sale:return",
        (transaction, identity) =>
          createSaleReturn(transaction, identity, {
            commandId: randomUUID(),
            commandVersion: 1,
            ...input,
          })
      );

    const cancel = (
      tenant: TenantFixture,
      saleId: string,
      database: RuntimeDatabase = runtimeDatabase
    ) =>
      withTenantAs(
        database.db,
        tenant,
        "sale:cancel",
        (transaction, identity) =>
          cancelSale(transaction, identity, {
            commandId: randomUUID(),
            commandVersion: 1,
            saleId,
          })
      );

    const balance = async (tenant: TenantFixture, variantId: string) => {
      const result = await admin.pool.query<{
        average: string | null;
        quantity: number;
      }>(
        "SELECT quantity, moving_average_cost::text AS average FROM public.inventory_balances WHERE organization_id = $1 AND variant_id = $2",
        [tenant.organizationId, variantId]
      );
      return result.rows[0] ?? { average: null, quantity: 0 };
    };

    const movementsOf = async (tenant: TenantFixture, commandId: string) => {
      const result = await admin.pool.query<{
        command_index: number;
        movement_type: string;
        quantity_delta: number;
        unit_cost: string | null;
      }>(
        "SELECT command_index, movement_type, quantity_delta, unit_cost::text FROM public.stock_movements WHERE organization_id = $1 AND command_id = $2 ORDER BY command_index",
        [tenant.organizationId, commandId]
      );
      return result.rows;
    };

    const returnCount = async (tenant: TenantFixture, saleId: string) => {
      const result = await admin.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM public.sale_returns WHERE organization_id = $1 AND sale_id = $2",
        [tenant.organizationId, saleId]
      );
      return Number(result.rows[0]?.count);
    };

    const returnedSum = async (tenant: TenantFixture, saleId: string) => {
      const result = await admin.pool.query<{
        position: number;
        restocked: string;
        returned: string;
      }>(
        "SELECT item_position AS position, sum(returned_quantity)::text AS returned, sum(restocked_quantity)::text AS restocked FROM public.sale_return_items WHERE organization_id = $1 AND sale_id = $2 GROUP BY item_position ORDER BY item_position",
        [tenant.organizationId, saleId]
      );
      return result.rows.map((row) => ({
        position: row.position,
        restocked: Number(row.restocked),
        returned: Number(row.returned),
      }));
    };

    const auditCount = async (tenant: TenantFixture, requestId: string) => {
      const result = await admin.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM public.tenant_audit_event WHERE organization_id = $1 AND request_id = $2",
        [tenant.organizationId, requestId]
      );
      return Number(result.rows[0]?.count);
    };

    /** The sale rows and its original movements: everything a return must not edit. */
    async function economicSnapshot(tenant: TenantFixture, saleId: string) {
      const result = await admin.pool.query<{ snapshot: string }>(
        `SELECT concat_ws('|',
          (SELECT row_to_json(s)::text FROM public.sales s WHERE s.id = $2 AND s.organization_id = $1),
          (SELECT COALESCE(json_agg(i ORDER BY i.position)::text, '') FROM public.sale_items i WHERE i.sale_id = $2 AND i.organization_id = $1),
          (SELECT COALESCE(json_agg(a ORDER BY a.position)::text, '') FROM public.sale_adjustments a WHERE a.sale_id = $2 AND a.organization_id = $1),
          (SELECT COALESCE(json_agg(p)::text, '') FROM public.sale_payments p WHERE p.sale_id = $2 AND p.organization_id = $1),
          (SELECT COALESCE(json_agg(m ORDER BY m.command_index)::text, '') FROM public.stock_movements m WHERE m.organization_id = $1 AND m.command_id = (SELECT command_id FROM public.sales WHERE id = $2 AND organization_id = $1))
        ) AS snapshot`,
        [tenant.organizationId, saleId]
      );
      return result.rows[0]?.snapshot;
    }

    async function expectRejected(
      operation: () => Promise<unknown>,
      expected: ErrorClass,
      label: string
    ) {
      await assert.rejects(operation, expected, label);
    }

    // --------------------------------------------------------------- fixtures
    const a1 = await createSellableProduct(rt, tenantA, "A1", {
      cost: "10.00",
      quantity: 30,
    });
    const a2 = await createSellableProduct(rt, tenantA, "A2 sem custo", {
      cost: null,
      quantity: 10,
    });

    // -------------------------------------------- 1. a partial return
    const sale1 = await confirmPlainSale(rt, tenantA, [
      { quantity: 5, variantId: a1.variantId },
      { quantity: 3, variantId: a2.variantId },
    ]);
    assert.equal((await balance(tenantA, a1.variantId)).quantity, 25);
    assert.equal((await balance(tenantA, a2.variantId)).quantity, 7);
    const economyBefore = await economicSnapshot(tenantA, sale1.sale.id);
    assert.ok(economyBefore?.includes(sale1.sale.id));

    const return1Command = randomUUID();
    const return1Request = randomUUID();
    const return1 = await giveBack(tenantA, {
      commandId: return1Command,
      items: [
        { position: 0, restockedQuantity: 1, returnedQuantity: 2 },
        { position: 1, restockedQuantity: 1, returnedQuantity: 1 },
      ],
      reasonCode: "defective",
      requestId: return1Request,
      saleId: sale1.sale.id,
    });
    assert.equal(return1.replayed, false);
    assert.equal(return1.saleReturn.returnedBy, tenantA.userId);
    assert.deepEqual(return1.lines, [
      { position: 0, restockedQuantity: 1, returnedQuantity: 2 },
      { position: 1, restockedQuantity: 1, returnedQuantity: 1 },
    ]);
    assert.deepEqual(
      (await movementsOf(tenantA, return1Command)).map((row) => [
        row.command_index,
        row.movement_type,
        row.quantity_delta,
        row.unit_cost,
      ]),
      [
        [0, "sale_return", 1, "10.000000"],
        [1, "sale_return", 1, null],
      ]
    );
    assert.deepEqual(await balance(tenantA, a1.variantId), {
      average: "10.000000",
      quantity: 26,
    });
    assert.deepEqual(await balance(tenantA, a2.variantId), {
      average: null,
      quantity: 8,
    });
    assert.equal(await economicSnapshot(tenantA, sale1.sale.id), economyBefore);
    assert.equal(await auditCount(tenantA, return1Request), 3);
    const returnAudit = await admin.pool.query<{ event_type: string }>(
      "SELECT event_type FROM public.tenant_audit_event WHERE organization_id = $1 AND request_id = $2 AND entity_type = 'sale_return'",
      [tenantA.organizationId, return1Request]
    );
    assert.deepEqual(returnAudit.rows, [{ event_type: "sale.returned" }]);
    tests.push(
      "a partial return records returned and restocked quantities, restocks only the restocked units at each item's own cost, restores balances, and audits together; the sale and its original movements stay byte-identical"
    );

    // a return that restocks nothing writes no movement and changes no balance
    const return2Command = randomUUID();
    const return2Request = randomUUID();
    await giveBack(tenantA, {
      commandId: return2Command,
      items: [{ position: 0, restockedQuantity: 0, returnedQuantity: 1 }],
      requestId: return2Request,
      saleId: sale1.sale.id,
    });
    assert.equal((await movementsOf(tenantA, return2Command)).length, 0);
    assert.equal((await balance(tenantA, a1.variantId)).quantity, 26);
    assert.equal(await auditCount(tenantA, return2Request), 1);
    assert.deepEqual(await returnedSum(tenantA, sale1.sale.id), [
      { position: 0, restocked: 1, returned: 3 },
      { position: 1, restocked: 1, returned: 1 },
    ]);
    tests.push(
      "a return with restocked 0 (the unit came back damaged) records the return and its audit but writes no ledger movement and leaves the balance alone"
    );

    // ------------------------------------------------- 2. rules
    const noEffect = async (
      saleId: string,
      lines: Line[],
      expected: ErrorClass,
      label: string
    ) => {
      const before = [
        await balance(tenantA, a1.variantId),
        await balance(tenantA, a2.variantId),
      ];
      const countBefore = await returnCount(tenantA, saleId);
      const request = randomUUID();
      await expectRejected(
        () => giveBack(tenantA, { items: lines, requestId: request, saleId }),
        expected,
        label
      );
      assert.equal(await returnCount(tenantA, saleId), countBefore, label);
      assert.equal(await auditCount(tenantA, request), 0, label);
      assert.deepEqual(
        [
          await balance(tenantA, a1.variantId),
          await balance(tenantA, a2.variantId),
        ],
        before,
        label
      );
    };
    await noEffect(
      sale1.sale.id,
      [{ position: 0, restockedQuantity: 0, returnedQuantity: 3 }],
      SaleReturnExceedsAvailableError,
      "returning more than is still available (5 sold, 3 returned, 3 asked)"
    );
    await noEffect(
      sale1.sale.id,
      [
        { position: 1, restockedQuantity: 0, returnedQuantity: 1 },
        { position: 0, restockedQuantity: 0, returnedQuantity: 3 },
      ],
      SaleReturnExceedsAvailableError,
      "one bad line rejects the whole return"
    );
    await noEffect(
      sale1.sale.id,
      [{ position: 0, restockedQuantity: 2, returnedQuantity: 1 }],
      InvalidSaleReturnError,
      "restocked above returned"
    );
    await noEffect(
      sale1.sale.id,
      [{ position: 9, restockedQuantity: 0, returnedQuantity: 1 }],
      InvalidSaleReturnError,
      "an unknown item position"
    );
    await noEffect(
      sale1.sale.id,
      [
        { position: 0, restockedQuantity: 0, returnedQuantity: 1 },
        { position: 0, restockedQuantity: 0, returnedQuantity: 1 },
      ],
      InvalidSaleReturnError,
      "the same item twice in one return"
    );
    await noEffect(
      sale1.sale.id,
      [{ position: 0, restockedQuantity: 0, returnedQuantity: 0 }],
      InvalidSaleReturnError,
      "a zero returned quantity"
    );
    await giveBack(tenantA, {
      items: [{ position: 0, restockedQuantity: 2, returnedQuantity: 2 }],
      saleId: sale1.sale.id,
    });
    await noEffect(
      sale1.sale.id,
      [{ position: 0, restockedQuantity: 0, returnedQuantity: 1 }],
      SaleReturnExceedsAvailableError,
      "everything already returned"
    );
    assert.deepEqual(await returnedSum(tenantA, sale1.sale.id), [
      { position: 0, restocked: 3, returned: 5 },
      { position: 1, restocked: 1, returned: 1 },
    ]);
    tests.push(
      "returned <= available_to_return and restocked <= returned hold across sequential returns; rejected returns leave no rows, audit, or stock behind, and the last available unit can be returned exactly once"
    );

    // ------------------------------------------- 3. idempotency
    const replay = await giveBack(tenantA, {
      commandId: return1Command,
      items: [
        { position: 0, restockedQuantity: 1, returnedQuantity: 2 },
        { position: 1, restockedQuantity: 1, returnedQuantity: 1 },
      ],
      reasonCode: "defective",
      saleId: sale1.sale.id,
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.saleReturn.id, return1.saleReturn.id);
    assert.equal((await movementsOf(tenantA, return1Command)).length, 2);
    assert.equal(await auditCount(tenantA, return1Request), 3);
    for (const [label, input] of [
      [
        "different quantities",
        {
          items: [{ position: 0, restockedQuantity: 1, returnedQuantity: 1 }],
          reasonCode: "defective" as const,
        },
      ],
      [
        "a different reason",
        {
          items: [
            { position: 0, restockedQuantity: 1, returnedQuantity: 2 },
            { position: 1, restockedQuantity: 1, returnedQuantity: 1 },
          ],
          reasonCode: "wrong_item" as const,
        },
      ],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: each probe is verified before the next one starts
      await expectRejected(
        () =>
          giveBack(tenantA, {
            commandId: return1Command,
            saleId: sale1.sale.id,
            ...input,
          }),
        SaleReturnCommandConflictError,
        `the same command with ${label} conflicts`
      );
    }
    const saleCommand = await admin.pool.query<{ command_id: string }>(
      "SELECT command_id FROM public.sales WHERE id = $1",
      [sale1.sale.id]
    );
    const saleCommandId = saleCommand.rows[0]?.command_id;
    assert.ok(saleCommandId);
    await expectRejected(
      () =>
        giveBack(tenantA, {
          commandId: saleCommandId,
          items: [{ position: 1, restockedQuantity: 0, returnedQuantity: 1 }],
          saleId: sale1.sale.id,
        }),
      SaleReturnCommandConflictError,
      "a return cannot reuse the sale's command ID"
    );
    tests.push(
      "repeating a return command replays it even after the sale is fully returned, without new rows, movements, audit, or stock; another payload or the sale's own command ID conflicts"
    );

    // ----------------------------- 4. cancellation and returns exclude each other
    const sale2 = await confirmPlainSale(rt, tenantA, [
      { quantity: 2, variantId: a1.variantId },
    ]);
    await giveBack(tenantA, {
      items: [{ position: 0, restockedQuantity: 1, returnedQuantity: 1 }],
      saleId: sale2.sale.id,
    });
    await expectRejected(
      () => cancel(tenantA, sale2.sale.id),
      SaleHasReturnsError,
      "a sale with returns cannot be cancelled as a whole"
    );
    const sale3 = await confirmPlainSale(rt, tenantA, [
      { quantity: 2, variantId: a1.variantId },
    ]);
    await cancel(tenantA, sale3.sale.id);
    const stockAfterCancel = (await balance(tenantA, a1.variantId)).quantity;
    await expectRejected(
      () =>
        giveBack(tenantA, {
          items: [{ position: 0, restockedQuantity: 1, returnedQuantity: 1 }],
          saleId: sale3.sale.id,
        }),
      SaleNotReturnableError,
      "a cancelled sale cannot receive returns"
    );
    assert.equal(await returnCount(tenantA, sale3.sale.id), 0);
    assert.equal(
      (await balance(tenantA, a1.variantId)).quantity,
      stockAfterCancel
    );
    tests.push(
      "a sale with returns cannot be cancelled and a cancelled sale cannot be returned, so the same units are never restocked twice"
    );

    // ------------------------------------------------- 5. valuation
    const costProduct = await createSellableProduct(rt, tenantA, "custo", {
      cost: "10.00",
      quantity: 10,
    });
    const costSale = await confirmPlainSale(rt, tenantA, [
      { quantity: 4, variantId: costProduct.variantId },
    ]);
    await withTenantAs(
      runtimeDatabase.db,
      tenantA,
      "inventory:adjust",
      (transaction, identity) =>
        receiveStock(transaction, identity, {
          commandId: randomUUID(),
          commandVersion: 1,
          occurredOn: "2026-10-12",
          quantity: 10,
          unitCost: "16.00",
          variantId: costProduct.variantId,
        })
    );
    assert.deepEqual(await balance(tenantA, costProduct.variantId), {
      average: "13.750000",
      quantity: 16,
    });
    await giveBack(tenantA, {
      items: [{ position: 0, restockedQuantity: 2, returnedQuantity: 3 }],
      saleId: costSale.sale.id,
    });
    // (16 x 13.75 + 2 x 10.00) / 18 = 13.333333...
    assert.deepEqual(await balance(tenantA, costProduct.variantId), {
      average: "13.333333",
      quantity: 18,
    });
    tests.push(
      "restocked units return at their own snapshot cost: the weighted average follows the receipt rule and only the restocked quantity (not the returned one) enters the balance"
    );

    // --------------------------------------------- 6. removed products
    const removed = await createSellableProduct(rt, tenantA, "removido", {
      cost: "2.00",
      quantity: 2,
    });
    const removedSale = await confirmPlainSale(rt, tenantA, [
      { quantity: 2, variantId: removed.variantId },
    ]);
    await withTenantAs(
      runtimeDatabase.db,
      tenantA,
      "product:update",
      (transaction, identity) =>
        deleteProduct(transaction, identity, {
          expectedVersion: removed.version,
          id: removed.productId,
        })
    );
    await expectRejected(
      () =>
        giveBack(tenantA, {
          items: [{ position: 0, restockedQuantity: 1, returnedQuantity: 1 }],
          saleId: removedSale.sale.id,
        }),
      SaleProductUnavailableError,
      "restocking into a removed product is refused"
    );
    assert.equal(await returnCount(tenantA, removedSale.sale.id), 0);
    const unstocked = await giveBack(tenantA, {
      items: [{ position: 0, restockedQuantity: 0, returnedQuantity: 1 }],
      saleId: removedSale.sale.id,
    });
    assert.equal(unstocked.replayed, false);
    tests.push(
      "a removed product refuses restocked units with nothing written, but a return that restocks nothing is still recorded"
    );

    // ------------------------------------------ 7. isolation and capability
    const productB = await createSellableProduct(rt, tenantB, "B", {
      cost: "3.00",
      quantity: 5,
    });
    const saleOfB = await confirmPlainSale(rt, tenantB, [
      { quantity: 2, variantId: productB.variantId },
    ]);
    await expectRejected(
      () =>
        giveBack(tenantA, {
          items: [{ position: 0, restockedQuantity: 0, returnedQuantity: 1 }],
          saleId: saleOfB.sale.id,
        }),
      SaleNotFoundError,
      "another organization's sale is not found"
    );
    await expectRejected(
      () =>
        giveBack(tenantA, {
          items: [{ position: 0, restockedQuantity: 0, returnedQuantity: 1 }],
          saleId: randomUUID(),
        }),
      SaleNotFoundError,
      "an unknown sale is not found"
    );
    await assert.rejects(
      () =>
        withTenantAs(
          runtimeDatabase.db,
          tenantA,
          "sale:cancel",
          (transaction, identity) =>
            createSaleReturn(transaction, identity, {
              commandId: randomUUID(),
              commandVersion: 1,
              items: [
                { position: 0, restockedQuantity: 0, returnedQuantity: 1 },
              ],
              saleId: sale2.sale.id,
            })
        ),
      (error: unknown) =>
        error instanceof TenantAuthorizationError &&
        error.code === "capability_denied"
    );
    await assert.rejects(
      () =>
        withTenantAs(
          runtimeDatabase.db,
          { organizationId: tenantA.organizationId, userId: outsider.userId },
          "sale:return",
          (transaction, identity) =>
            createSaleReturn(transaction, identity, {
              commandId: randomUUID(),
              commandVersion: 1,
              items: [
                { position: 0, restockedQuantity: 0, returnedQuantity: 1 },
              ],
              saleId: sale2.sale.id,
            })
        ),
      (error: unknown) =>
        error instanceof TenantAuthorizationError &&
        error.code === "tenant_access_denied"
    );
    assert.equal(await returnCount(tenantB, saleOfB.sale.id), 0);
    tests.push(
      "unknown and cross-organization sales are not found, and a missing capability or membership is denied, with nothing written"
    );

    // ------------------------------------------------ 8. injected failures
    await admin.pool.query(
      `CREATE FUNCTION public.pr46_gate_inject_failure() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION '${injectedFailureMessage}' USING ERRCODE = 'P0001'; END; $f$`
    );
    failureFunctionCreated = true;
    const injectionSale = await confirmPlainSale(rt, tenantA, [
      { quantity: 4, variantId: a1.variantId },
      { quantity: 2, variantId: a2.variantId },
    ]);
    const failurePoints: {
      event: "INSERT" | "UPDATE";
      label: string;
      table: string;
      when?: string;
    }[] = [
      { event: "INSERT", label: "return row", table: "sale_returns" },
      { event: "INSERT", label: "return items", table: "sale_return_items" },
      {
        event: "INSERT",
        label: "restock movement",
        table: "stock_movements",
        when: "NEW.movement_type = 'sale_return'",
      },
      { event: "UPDATE", label: "balance update", table: "inventory_balances" },
      {
        event: "INSERT",
        label: "movement audit",
        table: "tenant_audit_event",
        when: "NEW.event_type = 'inventory.movement_recorded'",
      },
      {
        event: "INSERT",
        label: "return audit",
        table: "tenant_audit_event",
        when: "NEW.event_type = 'sale.returned'",
      },
    ];
    for (const point of failurePoints) {
      const triggerName = `pr46_gate_fail_${point.table}`;
      // biome-ignore lint/performance/noAwaitInLoops: each probe is verified before the next one starts
      await admin.pool.query(
        `CREATE TRIGGER ${triggerName} BEFORE ${point.event} ON public.${point.table} FOR EACH ROW ${point.when ? `WHEN (${point.when})` : ""} EXECUTE FUNCTION public.pr46_gate_inject_failure()`
      );
      try {
        const command = randomUUID();
        const request = randomUUID();
        const before = [
          await balance(tenantA, a1.variantId),
          await balance(tenantA, a2.variantId),
        ];
        await assert.rejects(
          () =>
            giveBack(tenantA, {
              commandId: command,
              items: [
                { position: 0, restockedQuantity: 2, returnedQuantity: 2 },
                { position: 1, restockedQuantity: 1, returnedQuantity: 1 },
              ],
              requestId: request,
              saleId: injectionSale.sale.id,
            }),
          (error: unknown) => {
            assert.match(
              String((error as Error).message) +
                String(((error as Error).cause as Error | undefined)?.message),
              new RegExp(injectedFailureMessage)
            );
            return true;
          },
          `failure injected at ${point.label} surfaces`
        );
        assert.equal(await returnCount(tenantA, injectionSale.sale.id), 0);
        assert.equal((await movementsOf(tenantA, command)).length, 0);
        assert.equal(await auditCount(tenantA, request), 0);
        assert.deepEqual(
          [
            await balance(tenantA, a1.variantId),
            await balance(tenantA, a2.variantId),
          ],
          before,
          `balances restored after ${point.label}`
        );
      } finally {
        await admin.pool.query(
          `DROP TRIGGER IF EXISTS ${triggerName} ON public.${point.table}`
        );
      }
    }
    await giveBack(tenantA, {
      items: [{ position: 0, restockedQuantity: 1, returnedQuantity: 1 }],
      saleId: injectionSale.sale.id,
    });
    tests.push(
      `a failure injected at each of ${failurePoints.length} write points (return row, items, restock movement, balance, movement audit, return audit) rolls back everything; the same sale then accepts a return cleanly`
    );

    // ----------------------------------------------------- 9. concurrency
    const raceProduct = await createSellableProduct(rt, tenantA, "corrida", {
      cost: "5.00",
      quantity: 40,
    });
    const raceSale = await confirmPlainSale(rt, tenantA, [
      { quantity: 10, variantId: raceProduct.variantId },
    ]);
    const stockBeforeRace = (await balance(tenantA, raceProduct.variantId))
      .quantity;
    const race = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        giveBack(
          tenantA,
          {
            items: [{ position: 0, restockedQuantity: 3, returnedQuantity: 3 }],
            saleId: raceSale.sale.id,
          },
          concurrentDatabase
        )
      )
    );
    assert.equal(race.filter((r) => r.status === "fulfilled").length, 3);
    assert.ok(
      race
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .every((r) => r.reason instanceof SaleReturnExceedsAvailableError),
      "every losing return fails on availability, not with a database error"
    );
    assert.deepEqual(await returnedSum(tenantA, raceSale.sale.id), [
      { position: 0, restocked: 9, returned: 9 },
    ]);
    assert.equal(
      (await balance(tenantA, raceProduct.variantId)).quantity,
      stockBeforeRace + 9
    );

    const sameCommandSale = await confirmPlainSale(rt, tenantA, [
      { quantity: 4, variantId: raceProduct.variantId },
    ]);
    const sharedCommand = randomUUID();
    const sameCommand = await Promise.all(
      Array.from({ length: 5 }, () =>
        giveBack(
          tenantA,
          {
            commandId: sharedCommand,
            items: [{ position: 0, restockedQuantity: 2, returnedQuantity: 2 }],
            saleId: sameCommandSale.sale.id,
          },
          concurrentDatabase
        )
      )
    );
    assert.equal(sameCommand.filter((r) => !r.replayed).length, 1);
    assert.equal(new Set(sameCommand.map((r) => r.saleReturn.id)).size, 1);
    assert.equal((await movementsOf(tenantA, sharedCommand)).length, 1);

    // return racing cancellation: exactly one of them wins, never both
    const duels: {
      cancelled: number;
      outcome: PromiseSettledResult<unknown>[];
      returns: number;
    }[] = [];
    for (let round = 0; round < 5; round += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each duel needs its own sale and a quiet pool
      const duelSale = await confirmPlainSale(rt, tenantA, [
        { quantity: 2, variantId: raceProduct.variantId },
      ]);
      const outcome = await Promise.allSettled([
        giveBack(
          tenantA,
          {
            items: [{ position: 0, restockedQuantity: 1, returnedQuantity: 1 }],
            saleId: duelSale.sale.id,
          },
          concurrentDatabase
        ),
        cancel(tenantA, duelSale.sale.id, concurrentDatabase),
      ]);
      const cancelled = await admin.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM public.sale_cancellations WHERE sale_id = $1",
        [duelSale.sale.id]
      );
      duels.push({
        cancelled: Number(cancelled.rows[0]?.count),
        outcome,
        returns: await returnCount(tenantA, duelSale.sale.id),
      });
    }
    for (const duel of duels) {
      assert.equal(
        duel.cancelled + duel.returns,
        1,
        "a return and a cancellation of one sale never both commit"
      );
      assert.equal(
        duel.outcome.filter((r) => r.status === "fulfilled").length,
        1
      );
      const loser = duel.outcome.find(
        (r): r is PromiseRejectedResult => r.status === "rejected"
      );
      assert.ok(
        loser?.reason instanceof SaleHasReturnsError ||
          loser?.reason instanceof SaleNotReturnableError,
        "the loser fails with a domain conflict"
      );
    }

    const mixed = await Promise.allSettled([
      giveBack(
        tenantA,
        {
          items: [{ position: 0, restockedQuantity: 1, returnedQuantity: 1 }],
          saleId: sameCommandSale.sale.id,
        },
        concurrentDatabase
      ),
      ...Array.from({ length: 5 }, () =>
        confirmPlainSale(
          { adminPool: admin.pool, db: concurrentDatabase.db },
          tenantA,
          [{ quantity: 1, variantId: raceProduct.variantId }]
        )
      ),
    ]);
    assert.ok(
      mixed.every((result) => result.status === "fulfilled"),
      "a return and new sales over the same product never deadlock"
    );
    tests.push(
      "eight racing returns of 3 units over 10 sold produce exactly three successes (9 units) and restore stock once; five deliveries of one command produce one return; a return racing a cancellation of the same sale never both commit; returns racing new sales never deadlock"
    );

    // ---------------------- 10. randomized sequence against an in-memory model
    const modelSale = await confirmPlainSale(rt, tenantA, [
      { quantity: 7, variantId: raceProduct.variantId },
      { quantity: 4, variantId: a1.variantId },
    ]);
    const stockAtModelStart = [
      (await balance(tenantA, raceProduct.variantId)).quantity,
      (await balance(tenantA, a1.variantId)).quantity,
    ];
    const sold = [7, 4];
    const modelReturned = [0, 0];
    let modelRestocked = [0, 0];
    let seed = 20_261_013;
    const next = (bound: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % bound;
    };
    let accepted = 0;
    let rejected = 0;
    for (let round = 0; round < 24; round += 1) {
      const position = next(2);
      const returnedQuantity = 1 + next(4);
      const restockedQuantity = next(returnedQuantity + 2);
      const available = (sold[position] ?? 0) - (modelReturned[position] ?? 0);
      const valid =
        restockedQuantity <= returnedQuantity && returnedQuantity <= available;
      try {
        // biome-ignore lint/performance/noAwaitInLoops: each attempt depends on the previous state
        await giveBack(tenantA, {
          items: [{ position, restockedQuantity, returnedQuantity }],
          saleId: modelSale.sale.id,
        });
        assert.ok(valid, "the model says this return must be rejected");
        modelReturned[position] =
          (modelReturned[position] ?? 0) + returnedQuantity;
        modelRestocked = modelRestocked.map((value, index) =>
          index === position ? value + restockedQuantity : value
        );
        accepted += 1;
      } catch (error) {
        assert.ok(
          !valid,
          `the model says this return is valid: ${redactedFailure(error)}`
        );
        assert.ok(
          error instanceof SaleReturnExceedsAvailableError ||
            error instanceof InvalidSaleReturnError
        );
        rejected += 1;
      }
    }
    assert.ok(
      accepted > 0 && rejected > 0,
      "the sequence exercises both outcomes"
    );
    const sums = await returnedSum(tenantA, modelSale.sale.id);
    for (const position of [0, 1]) {
      const row = sums.find((entry) => entry.position === position);
      assert.equal(row?.returned ?? 0, modelReturned[position]);
      assert.equal(row?.restocked ?? 0, modelRestocked[position]);
      assert.ok((row?.returned ?? 0) <= (sold[position] ?? 0));
    }
    assert.equal(
      (await balance(tenantA, raceProduct.variantId)).quantity,
      (stockAtModelStart[0] ?? 0) + (modelRestocked[0] ?? 0)
    );
    assert.equal(
      (await balance(tenantA, a1.variantId)).quantity,
      (stockAtModelStart[1] ?? 0) + (modelRestocked[1] ?? 0)
    );
    tests.push(
      `a randomized sequence of 24 return attempts (${accepted} accepted, ${rejected} rejected) matches an in-memory model of returned, restocked, and stock quantities exactly`
    );

    // ---------------------------------------- 11. database-level guards
    const guardSale = await confirmPlainSale(rt, tenantA, [
      { quantity: 3, variantId: a1.variantId },
    ]);
    const guardItem = await admin.pool.query<{
      product_id: string;
      unit_cost: string | null;
      variant_id: string;
    }>(
      "SELECT product_id, variant_id, unit_cost::text FROM public.sale_items WHERE sale_id = $1 AND position = 0",
      [guardSale.sale.id]
    );
    const [guardRow] = guardItem.rows;
    assert.ok(guardRow);
    const insertReturn = async (
      tenant: TenantFixture,
      options: {
        cancelledSaleId?: string;
        items?: {
          position: number;
          restocked: number;
          returned: number;
        }[];
        movements?: { index: number; quantity: number }[];
        orgId?: string;
        returnedBy?: string;
        saleId: string;
      }
    ) =>
      withRuntimeSqlContext(runtimeUrl, tenant, async (client) => {
        const command = randomUUID();
        const inserted = await client.query<{ id: string }>(
          "INSERT INTO public.sale_returns (organization_id, sale_id, command_id, returned_by) VALUES ($1, $2, $3, $4) RETURNING id",
          [
            options.orgId ?? tenant.organizationId,
            options.saleId,
            command,
            options.returnedBy ?? tenant.userId,
          ]
        );
        const id = inserted.rows[0]?.id;
        for (const line of options.items ?? []) {
          // biome-ignore lint/performance/noAwaitInLoops: statements share one transaction
          await client.query(
            "INSERT INTO public.sale_return_items (organization_id, return_id, sale_id, item_position, returned_quantity, restocked_quantity) VALUES ($1, $2, $3, $4, $5, $6)",
            [
              tenant.organizationId,
              id,
              options.saleId,
              line.position,
              line.returned,
              line.restocked,
            ]
          );
        }
        for (const movement of options.movements ?? []) {
          // biome-ignore lint/performance/noAwaitInLoops: statements share one transaction
          await client.query(
            "INSERT INTO public.stock_movements (organization_id, command_id, command_index, command_version, occurred_on, movement_type, product_id, variant_id, quantity_delta, unit_cost) VALUES ($1, $2, $3, 1, '2026-10-13', 'sale_return', $4, $5, $6, $7)",
            [
              tenant.organizationId,
              command,
              movement.index,
              guardRow.product_id,
              guardRow.variant_id,
              movement.quantity,
              guardRow.unit_cost,
            ]
          );
        }
      });
    await expectSqlState(
      () => insertReturn(tenantA, { saleId: guardSale.sale.id }),
      "23514",
      "a return without lines is rejected at commit",
      "sale_returns_items_complete"
    );
    await expectSqlState(
      () =>
        insertReturn(tenantA, {
          items: [{ position: 0, restocked: 2, returned: 2 }],
          saleId: guardSale.sale.id,
        }),
      "23514",
      "a restocked line without its movement is rejected at commit",
      "sale_returns_stock_complete"
    );
    await expectSqlState(
      () =>
        insertReturn(tenantA, {
          items: [{ position: 0, restocked: 2, returned: 2 }],
          movements: [{ index: 0, quantity: 1 }],
          saleId: guardSale.sale.id,
        }),
      "23514",
      "a movement with the wrong quantity is rejected at commit",
      "sale_returns_stock_complete"
    );
    await expectSqlState(
      () =>
        insertReturn(tenantA, {
          items: [{ position: 0, restocked: 0, returned: 4 }],
          saleId: guardSale.sale.id,
        }),
      "23514",
      "returning more than was sold is rejected at commit",
      "sale_returns_quantity_valid"
    );
    await expectSqlState(
      () =>
        insertReturn(tenantA, {
          items: [{ position: 0, restocked: 3, returned: 2 }],
          saleId: guardSale.sale.id,
        }),
      "23514",
      "restocked above returned is rejected immediately",
      "sale_return_items_restocked_within_returned"
    );
    await expectSqlState(
      () =>
        insertReturn(tenantA, {
          items: [{ position: 7, restocked: 0, returned: 1 }],
          saleId: guardSale.sale.id,
        }),
      "23503",
      "a line for a position the sale does not have is rejected"
    );
    await expectSqlState(
      () =>
        insertReturn(tenantA, {
          items: [{ position: 0, restocked: 0, returned: 1 }],
          returnedBy: tenantB.userId,
          saleId: guardSale.sale.id,
        }),
      "42501",
      "the actor recorded in a return must be the authorized user"
    );
    await expectSqlState(
      () =>
        insertReturn(tenantA, {
          items: [{ position: 0, restocked: 0, returned: 1 }],
          orgId: tenantB.organizationId,
          saleId: saleOfB.sale.id,
        }),
      "42501",
      "INSERT cannot claim another organization"
    );
    await expectSqlState(
      () =>
        withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
          client.query(
            "INSERT INTO public.stock_movements (organization_id, command_id, command_index, command_version, occurred_on, movement_type, product_id, variant_id, quantity_delta) VALUES ($1, $2, 0, 1, '2026-10-13', 'sale_return', $3, $4, 1)",
            [
              tenantA.organizationId,
              randomUUID(),
              guardRow.product_id,
              guardRow.variant_id,
            ]
          )
        ),
      "23514",
      "a return movement without a return is rejected",
      "stock_movements_sale_return_requires_return"
    );
    // a return on a cancelled sale, and a cancellation of a returned sale
    await expectSqlState(
      () =>
        insertReturn(tenantA, {
          items: [{ position: 0, restocked: 0, returned: 1 }],
          saleId: sale3.sale.id,
        }),
      "23514",
      "the database refuses a return on a cancelled sale",
      "sale_returns_sale_not_cancelled"
    );
    await expectSqlState(
      () =>
        withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
          client.query(
            "INSERT INTO public.sale_cancellations (organization_id, sale_id, command_id, cancelled_by) VALUES ($1, $2, $3, $4)",
            [
              tenantA.organizationId,
              sale2.sale.id,
              randomUUID(),
              tenantA.userId,
            ]
          )
        ),
      "23514",
      "the database refuses to cancel a sale that has returns",
      "sale_cancellations_sale_has_no_returns"
    );
    // coherent graphs written directly are accepted
    await insertReturn(tenantA, {
      items: [{ position: 0, restocked: 0, returned: 1 }],
      saleId: guardSale.sale.id,
    });
    await insertReturn(tenantA, {
      items: [{ position: 0, restocked: 2, returned: 2 }],
      movements: [{ index: 0, quantity: 2 }],
      saleId: guardSale.sale.id,
    });
    assert.equal(await returnCount(tenantA, guardSale.sale.id), 2);
    for (const statement of [
      "UPDATE public.sale_returns SET reason_code = 'other'",
      "DELETE FROM public.sale_returns",
      "TRUNCATE public.sale_returns CASCADE",
      "UPDATE public.sale_return_items SET returned_quantity = 1",
      "DELETE FROM public.sale_return_items",
      "TRUNCATE public.sale_return_items",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each probe is verified before the next one starts
      await expectSqlState(
        () =>
          withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
            client.query(statement)
          ),
        "42501",
        `runtime cannot run: ${statement}`
      );
    }
    const visibleToB = await withRuntimeSqlContext(
      runtimeUrl,
      tenantB,
      (client) => client.query("SELECT sale_id FROM public.sale_returns")
    );
    assert.deepEqual(visibleToB.rows, []);
    const acl = await admin.pool.query<{
      returns_delete: boolean;
      returns_insert: boolean;
      returns_update: boolean;
      items_delete: boolean;
      items_insert: boolean;
      items_update: boolean;
      force_rls: boolean;
      public_execute: boolean;
    }>(
      "SELECT has_table_privilege($1, 'public.sale_returns', 'DELETE') AS returns_delete, has_table_privilege($1, 'public.sale_returns', 'INSERT') AS returns_insert, has_table_privilege($1, 'public.sale_returns', 'UPDATE') AS returns_update, has_table_privilege($1, 'public.sale_return_items', 'DELETE') AS items_delete, has_table_privilege($1, 'public.sale_return_items', 'INSERT') AS items_insert, has_table_privilege($1, 'public.sale_return_items', 'UPDATE') AS items_update, (SELECT bool_and(relforcerowsecurity) FROM pg_class WHERE oid IN ('public.sale_returns'::regclass, 'public.sale_return_items'::regclass)) AS force_rls, has_function_privilege('public', 'public.check_sale_return_complete()', 'EXECUTE') AS public_execute",
      [runtimeRole]
    );
    assert.deepEqual(acl.rows, [
      {
        force_rls: true,
        items_delete: false,
        items_insert: true,
        items_update: false,
        public_execute: false,
        returns_delete: false,
        returns_insert: true,
        returns_update: false,
      },
    ]);
    tests.push(
      "PostgreSQL rejects a return without lines, without its movements, with a wrong movement quantity, above the quantity sold, with restocked above returned, for a position the sale lacks, with a forged actor, across organizations, with an orphan movement, on a cancelled sale, and a cancellation of a returned sale; coherent graphs are accepted; the runtime has SELECT+INSERT only under FORCE RLS"
    );

    // ----------------------------------------------- 12. reads
    const detail = await withTenantAs(
      runtimeDatabase.db,
      tenantA,
      "sale:read",
      (transaction, identity) => getSale(transaction, identity, sale1.sale.id)
    );
    assert.equal(detail.returns.length, 3);
    assert.deepEqual(
      detail.returnSummary.map((line) => [
        line.position,
        line.sold,
        line.returnedQuantity,
        line.restockedQuantity,
        line.availableToReturn,
      ]),
      [
        [0, 5, 5, 3, 0],
        [1, 3, 1, 1, 2],
      ]
    );
    assert.equal(detail.returns[0]?.returnedBy, tenantA.userId);
    assert.equal(detail.cancellation, null);
    const listed = await withTenantAs(
      runtimeDatabase.db,
      tenantA,
      "sale:read",
      (transaction, identity) =>
        listSales(transaction, identity, { limit: 100 })
    );
    assert.equal(
      listed.sales.find((sale) => sale.id === sale1.sale.id)?.hasReturns,
      true
    );
    assert.equal(
      listed.sales.find((sale) => sale.id === sale3.sale.id)?.hasReturns,
      false
    );
    assert.equal(
      listed.sales.find((sale) => sale.id === sale1.sale.id)?.totalDue,
      sale1.totals.totalDue
    );
    tests.push(
      "sale.get reports every return with its lines and the per-item sold, returned, restocked, and still-available quantities; sale.list flags sales with returns without changing totals"
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
    if (failureFunctionCreated) {
      for (const table of [
        "sale_returns",
        "sale_return_items",
        "stock_movements",
        "inventory_balances",
        "tenant_audit_event",
      ]) {
        // biome-ignore lint/performance/noAwaitInLoops: teardown drops one trigger at a time
        await admin.pool.query(
          `DROP TRIGGER IF EXISTS pr46_gate_fail_${table} ON public.${table}`
        );
      }
      await admin.pool.query(
        "DROP FUNCTION IF EXISTS public.pr46_gate_inject_failure()"
      );
    }
    if (runtime) {
      await runtime.pool.end();
    }
    if (concurrent) {
      await concurrent.pool.end();
    }
    if (loginRole && loginRoleCreated) {
      await admin.pool.query(`REVOKE "${runtimeRole}" FROM "${loginRole}"`);
      await admin.pool.query(`DROP ROLE "${loginRole}"`);
    }
    await admin.pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    `Sale return PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
