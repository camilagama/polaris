import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { CustomerNotFoundError } from "@polaris/domain/customers/customer";
import { SaleProductUnavailableError } from "@polaris/domain/sales/confirm-sale";
import {
  InvalidSaleCancellationError,
  SaleAlreadyCancelledError,
  SaleCancellationCommandConflictError,
} from "@polaris/domain/sales/sale-cancellation";
import { SaleNotFoundError } from "@polaris/domain/sales/sale-errors";
import { createDatabase } from "../src/client";
import { createCustomer } from "../src/customer-repository";
import { receiveStock } from "../src/inventory-repository";
import { archiveProduct, deleteProduct } from "../src/product-repository";
import {
  type CancelSaleRepositoryInput,
  cancelSale,
} from "../src/sale-cancellation-repository";
import { changeSaleCustomerLink } from "../src/sale-customer-link-repository";
import { getSale, listSales } from "../src/sale-query-repository";
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
const injectedFailureMessage = "pr45 gate injected failure";

type RuntimeDatabase = ReturnType<typeof createDatabase>;
type ErrorClass = abstract new (...args: never[]) => Error;

function organizationDate(date: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "America/Sao_Paulo",
    year: "numeric",
  }).format(date);
}

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
    assert.ok(Number(migrations.rows[0]?.count) >= 37);
    tests.push(
      "migrations 0000-0036 (and any later ones) were replayed from scratch"
    );

    const tenantA = await createTenantFixture(admin.pool, "A");
    const tenantB = await createTenantFixture(admin.pool, "B");
    const outsider = await createTenantFixture(admin.pool, "outsider");
    const loginSuffix = randomUUID().replaceAll("-", "");
    loginRole = `polaris_cancel_gate_${loginSuffix}`;
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
    const cancel = (
      tenant: TenantFixture,
      input: Omit<CancelSaleRepositoryInput, "commandVersion" | "requestId"> & {
        commandVersion?: number;
        requestId?: string;
      },
      database: RuntimeDatabase = runtimeDatabase
    ) =>
      withTenantAs(
        database.db,
        tenant,
        "sale:cancel",
        (transaction, identity) =>
          cancelSale(transaction, identity, { commandVersion: 1, ...input })
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
        occurred_on: string;
        quantity_delta: number;
        unit_cost: string | null;
      }>(
        "SELECT command_index, movement_type, occurred_on::text, quantity_delta, unit_cost::text FROM public.stock_movements WHERE organization_id = $1 AND command_id = $2 ORDER BY command_index",
        [tenant.organizationId, commandId]
      );
      return result.rows;
    };

    const cancellationCount = async (tenant: TenantFixture, saleId: string) => {
      const result = await admin.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM public.sale_cancellations WHERE organization_id = $1 AND sale_id = $2",
        [tenant.organizationId, saleId]
      );
      return Number(result.rows[0]?.count);
    };

    const auditCount = async (tenant: TenantFixture, requestId: string) => {
      const result = await admin.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM public.tenant_audit_event WHERE organization_id = $1 AND request_id = $2",
        [tenant.organizationId, requestId]
      );
      return Number(result.rows[0]?.count);
    };

    /** The sale rows and its original ledger movements: everything cancellation must not edit. */
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
      quantity: 20,
    });
    const a2 = await createSellableProduct(rt, tenantA, "A2 sem custo", {
      cost: null,
      quantity: 10,
    });

    // ------------------------------------------- 1. complete cancellation
    const sale1 = await confirmPlainSale(rt, tenantA, [
      { quantity: 3, variantId: a1.variantId },
      { quantity: 2, variantId: a2.variantId },
    ]);
    assert.equal((await balance(tenantA, a1.variantId)).quantity, 17);
    assert.equal((await balance(tenantA, a2.variantId)).quantity, 8);
    const economyBefore = await economicSnapshot(tenantA, sale1.sale.id);
    assert.ok(economyBefore?.includes(sale1.sale.id));

    const cancelCommand = randomUUID();
    const cancelRequest = randomUUID();
    const dateBefore = organizationDate(new Date());
    const cancelled = await cancel(tenantA, {
      commandId: cancelCommand,
      reasonCode: "customer_request",
      reasonNote: "Cliente desistiu da compra",
      requestId: cancelRequest,
      saleId: sale1.sale.id,
    });
    const dateAfter = organizationDate(new Date());
    assert.equal(cancelled.replayed, false);
    assert.equal(cancelled.cancellation.saleId, sale1.sale.id);
    assert.equal(cancelled.cancellation.cancelledBy, tenantA.userId);
    assert.equal(cancelled.cancellation.reasonCode, "customer_request");
    assert.deepEqual(
      cancelled.restocked.map((line) => [line.position, line.quantity]),
      [
        [0, 3],
        [1, 2],
      ]
    );
    const restock = await movementsOf(tenantA, cancelCommand);
    assert.deepEqual(
      restock.map((row) => [
        row.command_index,
        row.movement_type,
        row.quantity_delta,
        row.unit_cost,
      ]),
      [
        [0, "sale_cancellation", 3, "10.000000"],
        [1, "sale_cancellation", 2, null],
      ]
    );
    assert.ok(
      restock.every((row) => [dateBefore, dateAfter].includes(row.occurred_on)),
      "the ledger date is the organization's calendar date"
    );
    assert.deepEqual(await balance(tenantA, a1.variantId), {
      average: "10.000000",
      quantity: 20,
    });
    assert.deepEqual(await balance(tenantA, a2.variantId), {
      average: null,
      quantity: 10,
    });
    assert.equal(
      await economicSnapshot(tenantA, sale1.sale.id),
      economyBefore,
      "the confirmed sale and its original movements are untouched"
    );
    assert.equal(await auditCount(tenantA, cancelRequest), 3);
    const cancelAudit = await admin.pool.query<{ event_type: string }>(
      "SELECT event_type FROM public.tenant_audit_event WHERE organization_id = $1 AND request_id = $2 AND entity_type = 'sale_cancellation'",
      [tenantA.organizationId, cancelRequest]
    );
    assert.deepEqual(cancelAudit.rows, [{ event_type: "sale.cancelled" }]);
    tests.push(
      "cancelSale writes the cancellation, one inverse movement per item at its own cost snapshot, restored balances, and the audit event together; the sale and its original movements stay byte-identical"
    );

    // ----------------------------------------------------- 2. idempotency
    const replay = await cancel(tenantA, {
      commandId: cancelCommand,
      reasonCode: "customer_request",
      reasonNote: "Cliente desistiu da compra",
      saleId: sale1.sale.id,
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.cancellation.id, cancelled.cancellation.id);
    assert.equal((await movementsOf(tenantA, cancelCommand)).length, 2);
    assert.equal(await auditCount(tenantA, cancelRequest), 3);
    assert.equal((await balance(tenantA, a1.variantId)).quantity, 20);
    await expectRejected(
      () =>
        cancel(tenantA, {
          commandId: cancelCommand,
          reasonCode: "entry_error",
          saleId: sale1.sale.id,
        }),
      SaleCancellationCommandConflictError,
      "the same command with another reason conflicts"
    );
    await expectRejected(
      () => cancel(tenantA, { commandId: randomUUID(), saleId: sale1.sale.id }),
      SaleAlreadyCancelledError,
      "a cancelled sale cannot be cancelled again"
    );
    assert.equal(await cancellationCount(tenantA, sale1.sale.id), 1);
    assert.equal((await balance(tenantA, a1.variantId)).quantity, 20);
    tests.push(
      "repeating a cancellation command replays it without new rows, movements, audit, or stock; another reason conflicts; a second cancellation of the same sale is rejected"
    );

    // ------------------------------------------------- 3. cost valuation
    const costProduct = await createSellableProduct(rt, tenantA, "custo", {
      cost: "10.00",
      quantity: 20,
    });
    const costSale = await confirmPlainSale(rt, tenantA, [
      { quantity: 5, variantId: costProduct.variantId },
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
      average: "12.400000",
      quantity: 25,
    });
    await cancel(tenantA, {
      commandId: randomUUID(),
      saleId: costSale.sale.id,
    });
    // (25 x 12.40 + 5 x 10.00) / 30 = 12.00
    assert.deepEqual(await balance(tenantA, costProduct.variantId), {
      average: "12.000000",
      quantity: 30,
    });

    const emptiedProduct = await createSellableProduct(rt, tenantA, "zerado", {
      cost: "4.00",
      quantity: 3,
    });
    const emptiedSale = await confirmPlainSale(rt, tenantA, [
      { quantity: 3, variantId: emptiedProduct.variantId },
    ]);
    assert.equal(
      (await balance(tenantA, emptiedProduct.variantId)).quantity,
      0
    );
    await cancel(tenantA, {
      commandId: randomUUID(),
      saleId: emptiedSale.sale.id,
    });
    assert.deepEqual(await balance(tenantA, emptiedProduct.variantId), {
      average: "4.000000",
      quantity: 3,
    });
    tests.push(
      "restocked units are valued at their own snapshot: a weighted average after later receipts, the snapshot cost on an empty balance, and an unknown cost never turns into zero"
    );

    // ----------------------------------------- 4. lifecycle and isolation
    const archivedProduct = await createSellableProduct(
      rt,
      tenantA,
      "arquivado",
      {
        cost: "2.00",
        quantity: 5,
      }
    );
    const archivedSale = await confirmPlainSale(rt, tenantA, [
      { quantity: 2, variantId: archivedProduct.variantId },
    ]);
    await withTenantAs(
      runtimeDatabase.db,
      tenantA,
      "product:update",
      (transaction, identity) =>
        archiveProduct(transaction, identity, {
          expectedVersion: archivedProduct.version,
          id: archivedProduct.productId,
        })
    );
    await cancel(tenantA, {
      commandId: randomUUID(),
      saleId: archivedSale.sale.id,
    });
    assert.equal(
      (await balance(tenantA, archivedProduct.variantId)).quantity,
      5
    );

    const removedProduct = await createSellableProduct(
      rt,
      tenantA,
      "removido",
      {
        cost: "2.00",
        quantity: 2,
      }
    );
    const removedSale = await confirmPlainSale(rt, tenantA, [
      { quantity: 2, variantId: removedProduct.variantId },
    ]);
    await withTenantAs(
      runtimeDatabase.db,
      tenantA,
      "product:update",
      (transaction, identity) =>
        deleteProduct(transaction, identity, {
          expectedVersion: removedProduct.version,
          id: removedProduct.productId,
        })
    );
    const removedCommand = randomUUID();
    const removedRequest = randomUUID();
    await expectRejected(
      () =>
        cancel(tenantA, {
          commandId: removedCommand,
          requestId: removedRequest,
          saleId: removedSale.sale.id,
        }),
      SaleProductUnavailableError,
      "a removed product cannot take its units back"
    );
    assert.equal(await cancellationCount(tenantA, removedSale.sale.id), 0);
    assert.equal((await movementsOf(tenantA, removedCommand)).length, 0);
    assert.equal(await auditCount(tenantA, removedRequest), 0);

    const saleOfB = await (async () => {
      const productB = await createSellableProduct(rt, tenantB, "B", {
        cost: "3.00",
        quantity: 5,
      });
      return await confirmPlainSale(rt, tenantB, [
        { quantity: 1, variantId: productB.variantId },
      ]);
    })();
    await expectRejected(
      () =>
        cancel(tenantA, { commandId: randomUUID(), saleId: saleOfB.sale.id }),
      SaleNotFoundError,
      "another organization's sale is not found"
    );
    await expectRejected(
      () => cancel(tenantA, { commandId: randomUUID(), saleId: randomUUID() }),
      SaleNotFoundError,
      "an unknown sale is not found"
    );
    assert.equal(await cancellationCount(tenantB, saleOfB.sale.id), 0);
    await assert.rejects(
      () =>
        withTenantAs(
          runtimeDatabase.db,
          tenantA,
          "sale:create",
          (transaction, identity) =>
            cancelSale(transaction, identity, {
              commandId: randomUUID(),
              commandVersion: 1,
              saleId: sale1.sale.id,
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
          {
            organizationId: tenantA.organizationId,
            userId: outsider.userId,
          },
          "sale:cancel",
          (transaction, identity) =>
            cancelSale(transaction, identity, {
              commandId: randomUUID(),
              commandVersion: 1,
              saleId: sale1.sale.id,
            })
        ),
      (error: unknown) =>
        error instanceof TenantAuthorizationError &&
        error.code === "tenant_access_denied"
    );
    for (const [label, input] of [
      ["unknown reason", { reasonCode: "fraud" }],
      ["note without reason", { reasonNote: "sozinha" }],
      ["other without note", { reasonCode: "other" }],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: each probe is verified before the next one starts
      await expectRejected(
        () =>
          cancel(tenantA, {
            commandId: randomUUID(),
            saleId: saleOfB.sale.id,
            ...input,
          }),
        InvalidSaleCancellationError,
        `invalid ${label}`
      );
    }
    tests.push(
      "an archived product still takes units back, a removed product blocks the cancellation with nothing written, and unknown or cross-organization sales, missing capability, no membership, and invalid reasons are rejected"
    );

    // ------------------------------------------------ 5. injected failures
    await admin.pool.query(
      `CREATE FUNCTION public.pr45_gate_inject_failure() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION '${injectedFailureMessage}' USING ERRCODE = 'P0001'; END; $f$`
    );
    failureFunctionCreated = true;
    const injectionSale = await confirmPlainSale(rt, tenantA, [
      { quantity: 2, variantId: a1.variantId },
      { quantity: 1, variantId: a2.variantId },
    ]);
    const failurePoints: {
      event: "INSERT" | "UPDATE";
      label: string;
      table: string;
      when?: string;
    }[] = [
      {
        event: "INSERT",
        label: "cancellation row",
        table: "sale_cancellations",
      },
      {
        event: "INSERT",
        label: "restock movement",
        table: "stock_movements",
        when: "NEW.movement_type = 'sale_cancellation'",
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
        label: "cancellation audit",
        table: "tenant_audit_event",
        when: "NEW.event_type = 'sale.cancelled'",
      },
    ];
    for (const point of failurePoints) {
      const triggerName = `pr45_gate_fail_${point.table}`;
      // biome-ignore lint/performance/noAwaitInLoops: each probe is verified before the next one starts
      await admin.pool.query(
        `CREATE TRIGGER ${triggerName} BEFORE ${point.event} ON public.${point.table} FOR EACH ROW ${point.when ? `WHEN (${point.when})` : ""} EXECUTE FUNCTION public.pr45_gate_inject_failure()`
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
            cancel(tenantA, {
              commandId: command,
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
        assert.equal(
          await cancellationCount(tenantA, injectionSale.sale.id),
          0
        );
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
    await cancel(tenantA, {
      commandId: randomUUID(),
      saleId: injectionSale.sale.id,
    });
    tests.push(
      `a failure injected at each of ${failurePoints.length} write points (cancellation row, restock movement, balance, movement audit, cancellation audit) rolls back everything; the same sale then cancels cleanly`
    );

    // ----------------------------------------------------- 6. concurrency
    const raceSale = await confirmPlainSale(rt, tenantA, [
      { quantity: 1, variantId: a1.variantId },
    ]);
    const a1AfterSale = (await balance(tenantA, a1.variantId)).quantity;
    const race = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        cancel(
          tenantA,
          { commandId: randomUUID(), saleId: raceSale.sale.id },
          concurrentDatabase
        )
      )
    );
    assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
    assert.ok(
      race
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .every((r) => r.reason instanceof SaleAlreadyCancelledError),
      "every losing cancellation is classified as already cancelled"
    );
    assert.equal(
      (await balance(tenantA, a1.variantId)).quantity,
      a1AfterSale + 1,
      "the stock comes back once"
    );
    assert.equal(await cancellationCount(tenantA, raceSale.sale.id), 1);

    const sameCommandSale = await confirmPlainSale(rt, tenantA, [
      { quantity: 1, variantId: a1.variantId },
    ]);
    const sharedCommand = randomUUID();
    const sameCommand = await Promise.all(
      Array.from({ length: 5 }, () =>
        cancel(
          tenantA,
          { commandId: sharedCommand, saleId: sameCommandSale.sale.id },
          concurrentDatabase
        )
      )
    );
    assert.equal(sameCommand.filter((r) => !r.replayed).length, 1);
    assert.equal(new Set(sameCommand.map((r) => r.cancellation.id)).size, 1);
    assert.equal((await movementsOf(tenantA, sharedCommand)).length, 1);

    const mixedSale = await confirmPlainSale(rt, tenantA, [
      { quantity: 2, variantId: a1.variantId },
    ]);
    const mixed = await Promise.allSettled([
      cancel(
        tenantA,
        { commandId: randomUUID(), saleId: mixedSale.sale.id },
        concurrentDatabase
      ),
      ...Array.from({ length: 5 }, () =>
        confirmPlainSale(
          { adminPool: admin.pool, db: concurrentDatabase.db },
          tenantA,
          [{ quantity: 1, variantId: a1.variantId }]
        )
      ),
    ]);
    assert.ok(
      mixed.every((result) => result.status === "fulfilled"),
      "a cancellation and new sales over the same product never deadlock"
    );
    tests.push(
      "six concurrent cancellations of one sale produce one winner and restore stock once; five deliveries of one command ID produce one cancellation; a cancellation racing new sales of the same product never deadlocks"
    );

    // ------------------------------------------- 7. database-level guards
    const guardSale = await confirmPlainSale(rt, tenantA, [
      { quantity: 2, variantId: a1.variantId },
    ]);
    const cancellationInsert = (
      tenant: TenantFixture,
      values: {
        cancelledBy?: string;
        commandId?: string;
        orgId?: string;
        saleId: string;
      }
    ) =>
      withRuntimeSqlContext(runtimeUrl, tenant, (client) =>
        client.query(
          "INSERT INTO public.sale_cancellations (organization_id, sale_id, command_id, cancelled_by) VALUES ($1, $2, $3, $4)",
          [
            values.orgId ?? tenant.organizationId,
            values.saleId,
            values.commandId ?? randomUUID(),
            values.cancelledBy ?? tenant.userId,
          ]
        )
      );
    await expectSqlState(
      () => cancellationInsert(tenantA, { saleId: guardSale.sale.id }),
      "23514",
      "a cancellation without its inverse movements is rejected at commit",
      "sale_cancellations_stock_complete"
    );
    const guardSaleCommand = await admin.pool.query<{ command_id: string }>(
      "SELECT command_id FROM public.sales WHERE id = $1",
      [guardSale.sale.id]
    );
    const guardSaleCommandId = guardSaleCommand.rows[0]?.command_id;
    assert.ok(guardSaleCommandId);
    await expectSqlState(
      () =>
        cancellationInsert(tenantA, {
          commandId: guardSaleCommandId,
          saleId: guardSale.sale.id,
        }),
      "23514",
      "a cancellation cannot reuse the sale's command ID",
      "sale_cancellations_command_distinct"
    );
    await expectSqlState(
      () =>
        cancellationInsert(tenantA, {
          cancelledBy: tenantB.userId,
          saleId: guardSale.sale.id,
        }),
      "42501",
      "the actor recorded in a cancellation must be the authorized user"
    );
    await expectSqlState(
      () => cancellationInsert(tenantA, { saleId: sale1.sale.id }),
      "23505",
      "a sale can only be cancelled once"
    );
    await expectSqlState(
      () =>
        cancellationInsert(tenantA, {
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
            "INSERT INTO public.stock_movements (organization_id, command_id, command_index, command_version, occurred_on, movement_type, product_id, variant_id, quantity_delta) VALUES ($1, $2, 0, 1, '2026-10-13', 'sale_cancellation', $3, $4, 1)",
            [tenantA.organizationId, randomUUID(), a1.productId, a1.variantId]
          )
        ),
      "23514",
      "a cancellation movement without a cancellation is rejected",
      "stock_movements_sale_cancellation_requires_cancellation"
    );
    // A coherent graph written directly is accepted: the guard checks
    // completeness, it does not forbid the aggregate.
    const guardItems = await admin.pool.query<{
      position: number;
      product_id: string;
      quantity: number;
      unit_cost: string | null;
      variant_id: string;
    }>(
      "SELECT position, product_id, variant_id, quantity, unit_cost::text FROM public.sale_items WHERE sale_id = $1 ORDER BY position",
      [guardSale.sale.id]
    );
    const coherentCommand = randomUUID();
    await withRuntimeSqlContext(runtimeUrl, tenantA, async (client) => {
      await client.query(
        "INSERT INTO public.sale_cancellations (organization_id, sale_id, command_id, cancelled_by) VALUES ($1, $2, $3, $4)",
        [
          tenantA.organizationId,
          guardSale.sale.id,
          coherentCommand,
          tenantA.userId,
        ]
      );
      for (const item of guardItems.rows) {
        // biome-ignore lint/performance/noAwaitInLoops: each probe is verified before the next one starts
        await client.query(
          "INSERT INTO public.stock_movements (organization_id, command_id, command_index, command_version, occurred_on, movement_type, product_id, variant_id, quantity_delta, unit_cost) VALUES ($1, $2, $3, 1, '2026-10-13', 'sale_cancellation', $4, $5, $6, $7)",
          [
            tenantA.organizationId,
            coherentCommand,
            item.position,
            item.product_id,
            item.variant_id,
            item.quantity,
            item.unit_cost,
          ]
        );
      }
    });
    assert.equal(await cancellationCount(tenantA, guardSale.sale.id), 1);
    for (const statement of [
      "UPDATE public.sale_cancellations SET reason_code = 'other'",
      "DELETE FROM public.sale_cancellations",
      "TRUNCATE public.sale_cancellations",
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
      (client) => client.query("SELECT sale_id FROM public.sale_cancellations")
    );
    assert.deepEqual(visibleToB.rows, []);
    const acl = await admin.pool.query<{
      can_delete: boolean;
      can_insert: boolean;
      can_select: boolean;
      can_update: boolean;
      force_rls: boolean;
      public_execute: boolean;
    }>(
      "SELECT has_table_privilege($1, 'public.sale_cancellations', 'SELECT') AS can_select, has_table_privilege($1, 'public.sale_cancellations', 'INSERT') AS can_insert, has_table_privilege($1, 'public.sale_cancellations', 'UPDATE') AS can_update, has_table_privilege($1, 'public.sale_cancellations', 'DELETE') AS can_delete, (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'public.sale_cancellations'::regclass) AS force_rls, has_function_privilege('public', 'public.check_sale_cancellation_complete()', 'EXECUTE') AS public_execute",
      [runtimeRole]
    );
    assert.deepEqual(acl.rows, [
      {
        can_delete: false,
        can_insert: true,
        can_select: true,
        can_update: false,
        force_rls: true,
        public_execute: false,
      },
    ]);
    tests.push(
      "PostgreSQL rejects a cancellation without its inverse movements, a reused sale command, a forged actor, a second cancellation, a cross-organization claim, and an orphan cancellation movement; a coherent graph is accepted; the runtime has SELECT+INSERT only under FORCE RLS"
    );

    // ----------------------------- 8. reads, status and customer attribution
    const listed = await withTenantAs(
      runtimeDatabase.db,
      tenantA,
      "sale:read",
      (transaction, identity) =>
        listSales(transaction, identity, { limit: 100 })
    );
    const listedSale1 = listed.sales.find((sale) => sale.id === sale1.sale.id);
    assert.equal(listedSale1?.status, "cancelled");
    assert.equal(listedSale1?.totalDue, sale1.totals.totalDue);
    assert.ok(listedSale1?.cancelledAt instanceof Date);
    assert.ok(listed.sales.every((sale) => sale.id !== saleOfB.sale.id));
    const firstPage = await withTenantAs(
      runtimeDatabase.db,
      tenantA,
      "sale:read",
      (transaction, identity) =>
        listSales(transaction, identity, { limit: 1, offset: 0 })
    );
    assert.equal(firstPage.sales.length, 1);
    assert.equal(firstPage.hasMore, true);
    const detail = await withTenantAs(
      runtimeDatabase.db,
      tenantA,
      "sale:read",
      (transaction, identity) => getSale(transaction, identity, sale1.sale.id)
    );
    assert.equal(detail.cancellation?.id, cancelled.cancellation.id);
    assert.equal(detail.sale.totals.totalDue, sale1.totals.totalDue);
    assert.equal(detail.customer.customerId, null);
    await expectRejected(
      () =>
        withTenantAs(
          runtimeDatabase.db,
          tenantA,
          "sale:read",
          (transaction, identity) =>
            getSale(transaction, identity, saleOfB.sale.id)
        ),
      SaleNotFoundError,
      "another organization's sale cannot be read"
    );
    await assert.rejects(
      () =>
        withTenantAs(
          runtimeDatabase.db,
          tenantA,
          "catalog:read",
          (transaction, identity) => listSales(transaction, identity)
        ),
      (error: unknown) =>
        error instanceof TenantAuthorizationError &&
        error.code === "capability_denied"
    );
    const customer = await withTenantAs(
      runtimeDatabase.db,
      tenantA,
      "customer:update",
      (transaction, identity) =>
        createCustomer(transaction, identity, {
          name: "Cliente da venda cancelada",
          phone: "+55 11 90000-0000",
          requestId: randomUUID(),
        })
    );
    const attributionBefore = await economicSnapshot(tenantA, sale1.sale.id);
    const attributed = await withTenantAs(
      runtimeDatabase.db,
      tenantA,
      "sale:assign_customer",
      (transaction, identity) =>
        changeSaleCustomerLink(transaction, identity, {
          action: "assign",
          customerId: customer.id,
          expectedVersion: 0,
          saleId: sale1.sale.id,
        })
    );
    assert.equal(attributed.changed, true);
    assert.equal(
      await economicSnapshot(tenantA, sale1.sale.id),
      attributionBefore,
      "attributing a customer to a cancelled sale does not change its economy"
    );
    await expectRejected(
      () =>
        withTenantAs(
          runtimeDatabase.db,
          tenantA,
          "sale:assign_customer",
          (transaction, identity) =>
            changeSaleCustomerLink(transaction, identity, {
              action: "reassign",
              customerId: randomUUID(),
              expectedVersion: 1,
              saleId: sale1.sale.id,
            })
        ),
      CustomerNotFoundError,
      "unknown customer on a cancelled sale is rejected"
    );
    tests.push(
      "the sale list and detail report cancelled status without changing totals, are scoped to the organization and to sale:read, and a customer can still be attributed to a cancelled sale without touching its economy"
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
        "sale_cancellations",
        "stock_movements",
        "inventory_balances",
        "tenant_audit_event",
      ]) {
        // biome-ignore lint/performance/noAwaitInLoops: teardown drops one trigger at a time
        await admin.pool.query(
          `DROP TRIGGER IF EXISTS pr45_gate_fail_${table} ON public.${table}`
        );
      }
      await admin.pool.query(
        "DROP FUNCTION IF EXISTS public.pr45_gate_inject_failure()"
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
    `Sale cancellation PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
