import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { InsufficientStockError } from "@polaris/domain/inventory/inventory";
import {
  SaleHasReturnsError,
  SaleNotReturnableError,
} from "@polaris/domain/sales/sale-return";
import { createDatabase } from "../src/client";
import { createCustomer } from "../src/customer-repository";
import { receiveStock } from "../src/inventory-repository";
import { cancelSale } from "../src/sale-cancellation-repository";
import { changeSaleCustomerLink } from "../src/sale-customer-link-repository";
import { getSale } from "../src/sale-query-repository";
import { confirmSale } from "../src/sale-repository";
import { createSaleReturn } from "../src/sale-return-repository";
import { runClock, shiftDay, storeDay } from "./gate-clock";
import {
  createSellableProduct,
  createTenantFixture,
  disposableHostPattern,
  gateBranchPattern,
  journalMigrationCount,
  poolerPattern,
  redactedFailure,
  requiredEnvironment,
  runtimeRole,
  temporaryRuntimeUrl,
  withTenantAs,
} from "./sales-gate-support";

/**
 * Gate 4 (Fase 4, clientes e vendas online): one end-to-end scenario over the
 * real repositories and PostgreSQL, checked against an independent oracle, that
 * proves the six properties of the gate:
 * atomic sale, correct stock, correct money, correct cancellation, correct
 * returns, and customer reconciliation that never changes the economy.
 * The per-stage gates (poc:sales:*:verify) prove each mechanism in depth; this
 * script proves they compose.
 */
const expectedDatabase = process.env.POLARIS_SALES_GATE_DATABASE ?? "neondb";
const saoPaulo = "America/Sao_Paulo";

type RuntimeDatabase = ReturnType<typeof createDatabase>;

/** Exact money in cents, half-up, independent of the production decimal code. */
function cents(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  // The oracle is exact only for BRL amounts: refuse more than two places
  // instead of silently truncating them.
  assert.ok(fraction.length <= 2, `not a BRL amount: ${value}`);
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}

/** Half-up (ties away from zero) integer division of non-negative numbers. */
function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (2n * numerator + denominator) / (2n * denominator);
}

function formatCents(value: bigint): string {
  const whole = value / 100n;
  const fraction = (value % 100n).toString().padStart(2, "0");
  return `${whole}.${fraction}`;
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
  let loginRole: string | undefined;
  let loginRoleCreated = false;
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
    assert.equal(Number(migrations.rows[0]?.count), journalMigrationCount());
    tests.push("all migrations were replayed from scratch");

    const tenant = await createTenantFixture(admin.pool, "gate4", saoPaulo);
    const loginSuffix = randomUUID().replaceAll("-", "");
    loginRole = `polaris_gate4_${loginSuffix}`;
    const loginPassword = randomBytes(24).toString("hex");
    await admin.pool.query(
      `CREATE ROLE "${loginRole}" WITH LOGIN INHERIT PASSWORD '${loginPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
    );
    loginRoleCreated = true;
    await admin.pool.query(`GRANT "${runtimeRole}" TO "${loginRole}"`);
    const runtimeUrl = temporaryRuntimeUrl(adminUrl, loginRole, loginPassword);
    const runtimeDatabase = createDatabase(runtimeUrl, { maxConnections: 1 });
    runtime = runtimeDatabase;
    const rt = { adminPool: admin.pool, db: runtimeDatabase.db };
    const as = <T>(
      capability: string,
      operation: Parameters<typeof withTenantAs<T>>[3]
    ) => withTenantAs(runtimeDatabase.db, tenant, capability, operation);

    // ---------------------------------------------------------------- oracle
    /** Everything an operation must not touch, as one digest per table family. */
    const digest = async (label: "economy" | "ledger") => {
      const sql =
        label === "economy"
          ? `SELECT md5(concat_ws('|',
              (SELECT COALESCE(string_agg(row_to_json(s)::text, ',' ORDER BY s.id), '') FROM public.sales s WHERE s.organization_id = $1),
              (SELECT COALESCE(string_agg(row_to_json(i)::text, ',' ORDER BY i.sale_id, i.position), '') FROM public.sale_items i WHERE i.organization_id = $1),
              (SELECT COALESCE(string_agg(row_to_json(a)::text, ',' ORDER BY a.sale_id, a.position), '') FROM public.sale_adjustments a WHERE a.organization_id = $1),
              (SELECT COALESCE(string_agg(row_to_json(p)::text, ',' ORDER BY p.sale_id), '') FROM public.sale_payments p WHERE p.organization_id = $1)
            )) AS digest`
          : `SELECT md5(concat_ws('|',
              (SELECT COALESCE(string_agg(row_to_json(m)::text, ',' ORDER BY m.command_id, m.command_index), '') FROM public.stock_movements m WHERE m.organization_id = $1),
              (SELECT COALESCE(string_agg(row_to_json(b)::text, ',' ORDER BY b.variant_id), '') FROM public.inventory_balances b WHERE b.organization_id = $1)
            )) AS digest`;
      const result = await admin.pool.query<{ digest: string }>(sql, [
        tenant.organizationId,
      ]);
      return result.rows[0]?.digest;
    };

    const stock = async (variantId: string) => {
      const result = await admin.pool.query<{
        average: string | null;
        quantity: number;
      }>(
        "SELECT quantity, moving_average_cost::text AS average FROM public.inventory_balances WHERE organization_id = $1 AND variant_id = $2",
        [tenant.organizationId, variantId]
      );
      return result.rows[0] ?? { average: null, quantity: 0 };
    };

    /** The ledger must always explain the balance: quantity = sum of movements. */
    const assertLedgerExplainsBalances = async (label: string) => {
      const result = await admin.pool.query<{
        balance: number;
        ledger: string;
        variant_id: string;
      }>(
        `SELECT b.variant_id, b.quantity AS balance,
                COALESCE((SELECT sum(m.quantity_delta) FROM public.stock_movements m WHERE m.organization_id = b.organization_id AND m.variant_id = b.variant_id), 0)::text AS ledger
         FROM public.inventory_balances b WHERE b.organization_id = $1`,
        [tenant.organizationId]
      );
      assert.ok(result.rows.length > 0);
      for (const row of result.rows) {
        assert.equal(
          String(row.balance),
          row.ledger,
          `${label}: balance equals the sum of movements`
        );
      }
    };

    const sell = (
      items: {
        chargedUnitPrice: string;
        listedUnitPrice: string;
        quantity: number;
        variantId: string;
      }[],
      options: {
        adjustments?: Parameters<typeof confirmSale>[2]["adjustments"];
        commandId?: string;
        occurredAt?: string;
      } = {}
    ) =>
      as("sale:create", (transaction, identity) =>
        confirmSale(transaction, identity, {
          adjustments: options.adjustments ?? [],
          commandId: options.commandId ?? randomUUID(),
          commandVersion: 1,
          items,
          occurredAt:
            options.occurredAt ??
            new Date(Date.now() - 2 * 3_600_000).toISOString(),
          payment: { anticipationRequested: false, method: "pix" },
          paymentProfile: null,
          requestId: randomUUID(),
        })
      );

    const cancel = (saleId: string, commandId: string = randomUUID()) =>
      as("sale:cancel", (transaction, identity) =>
        cancelSale(transaction, identity, {
          commandId,
          commandVersion: 1,
          saleId,
        })
      );

    const giveBack = (
      saleId: string,
      items: {
        position: number;
        restockedQuantity: number;
        returnedQuantity: number;
      }[],
      commandId: string = randomUUID()
    ) =>
      as("sale:return", (transaction, identity) =>
        createSaleReturn(transaction, identity, {
          commandId,
          commandVersion: 1,
          items,
          saleId,
        })
      );

    const detail = (saleId: string) =>
      as("sale:read", (transaction, identity) =>
        getSale(transaction, identity, saleId)
      );

    // --------------------------------------------------------------- fixtures
    const p1 = await createSellableProduct(rt, tenant, "G4-P1", {
      cost: "10.00",
      quantity: 50,
    });
    const p2 = await createSellableProduct(rt, tenant, "G4-P2 sem custo", {
      cost: null,
      quantity: 20,
    });
    await assertLedgerExplainsBalances("opening stock");

    // ------------------------ 1. money: totals against an independent oracle
    const lines = [
      {
        chargedUnitPrice: "89.90",
        listedUnitPrice: "100.00",
        quantity: 3,
        variantId: p1.variantId,
      },
      {
        chargedUnitPrice: "50.00",
        listedUnitPrice: "50.00",
        quantity: 2,
        variantId: p2.variantId,
      },
    ];
    const subtotal = lines.reduce(
      (sum, line) => sum + cents(line.chargedUnitPrice) * BigInt(line.quantity),
      0n
    );
    const discount = roundHalfUp(subtotal * 10n, 100n); // 10 %, half-up to the cent
    const freight = cents("5.00");
    const expectedTotal = subtotal - discount + freight;
    const sale1 = await sell(lines, {
      adjustments: [
        { kind: "discount", value: { percentage: "10", type: "percentage" } },
        { kind: "freight", value: { amount: "5", type: "fixed" } },
      ],
    });
    assert.equal(sale1.totals.subtotal, formatCents(subtotal));
    assert.equal(sale1.totals.discountTotal, formatCents(discount));
    assert.equal(sale1.totals.freightTotal, formatCents(freight));
    assert.equal(sale1.totals.totalDue, formatCents(expectedTotal));
    assert.equal(sale1.payment.amount, formatCents(expectedTotal));
    const persisted = await admin.pool.query<{ total: string }>(
      `SELECT (COALESCE(sum(i.charged_unit_price * i.quantity), 0)
              - COALESCE((SELECT sum(a.amount) FROM public.sale_adjustments a WHERE a.sale_id = $1 AND a.kind = 'discount'), 0)
              + COALESCE((SELECT sum(a.amount) FROM public.sale_adjustments a WHERE a.sale_id = $1 AND a.kind <> 'discount'), 0))::text AS total
       FROM public.sale_items i WHERE i.sale_id = $1`,
      [sale1.sale.id]
    );
    assert.equal(
      cents(persisted.rows[0]?.total ?? "0"),
      expectedTotal,
      "the persisted rows add up to the same total"
    );
    tests.push(
      `money: subtotal ${formatCents(subtotal)}, discount ${formatCents(discount)}, freight ${formatCents(freight)} and total due ${formatCents(expectedTotal)} match an independent integer-cents oracle and the persisted rows, and the single payment equals the total`
    );

    // ------------------------------------------ 2. stock after the sale
    const p1AfterSale = await stock(p1.variantId);
    const p2AfterSale = await stock(p2.variantId);
    assert.equal(p1AfterSale.quantity, 47);
    assert.equal(p2AfterSale.quantity, 18);
    assert.equal(
      Number(p1AfterSale.average),
      10,
      "a sale never changes the moving average"
    );
    assert.equal(p2AfterSale.average, null, "unknown cost stays unknown");
    const ledgerOfSale = await admin.pool.query<{
      command_index: number;
      movement_type: string;
      quantity_delta: number;
      unit_cost: string | null;
    }>(
      "SELECT command_index, movement_type, quantity_delta, unit_cost::text FROM public.stock_movements WHERE organization_id = $1 AND command_id = $2 ORDER BY command_index",
      [tenant.organizationId, sale1.sale.commandId]
    );
    assert.deepEqual(
      ledgerOfSale.rows.map((row) => [
        row.movement_type,
        row.quantity_delta,
        row.unit_cost === null ? null : Number(row.unit_cost),
      ]),
      [
        ["sale", -3, 10],
        ["sale", -2, null],
      ]
    );
    await assertLedgerExplainsBalances("after the sale");
    tests.push(
      "stock: one 'sale' movement per item at the cost snapshot, balances 47 and 18, moving average untouched, and the ledger explains every balance"
    );

    // ------------------------------------ 3. atomicity: a failing sale leaves nothing
    const economyBeforeFailure = await digest("economy");
    const ledgerBeforeFailure = await digest("ledger");
    const auditCount = async () =>
      Number(
        (
          await admin.pool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM public.tenant_audit_event WHERE organization_id = $1",
            [tenant.organizationId]
          )
        ).rows[0]?.count
      );
    const auditBeforeFailure = await auditCount();
    await assert.rejects(
      () =>
        sell([
          {
            chargedUnitPrice: "10.00",
            listedUnitPrice: "10.00",
            quantity: 1,
            variantId: p1.variantId,
          },
          {
            chargedUnitPrice: "10.00",
            listedUnitPrice: "10.00",
            quantity: 9999,
            variantId: p2.variantId,
          },
        ]),
      InsufficientStockError
    );
    assert.equal(await digest("economy"), economyBeforeFailure);
    assert.equal(await digest("ledger"), ledgerBeforeFailure);
    assert.equal(
      await auditCount(),
      auditBeforeFailure,
      "a refused sale leaves no audit event either"
    );
    const replayed = await sell(lines, {
      adjustments: [
        { kind: "discount", value: { percentage: "10", type: "percentage" } },
        { kind: "freight", value: { amount: "5", type: "fixed" } },
      ],
      commandId: sale1.sale.commandId,
      occurredAt: sale1.sale.occurredAt.toISOString(),
    });
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.sale.id, sale1.sale.id);
    assert.equal(await digest("economy"), economyBeforeFailure);
    assert.equal(await digest("ledger"), ledgerBeforeFailure);
    tests.push(
      "atomic sale: a sale whose second line lacks stock leaves no header, item, payment, movement, balance, or audit event, and replaying a confirmed sale changes nothing"
    );

    // ------------------------------------------- 4. cancellation
    const beforeS2Ledger = await digest("ledger");
    const sale2 = await sell([
      {
        chargedUnitPrice: "19.90",
        listedUnitPrice: "20.00",
        quantity: 4,
        variantId: p1.variantId,
      },
    ]);
    assert.equal((await stock(p1.variantId)).quantity, 43);
    const economyBeforeCancel = await digest("economy");
    const cancelCommand = randomUUID();
    const cancelled = await cancel(sale2.sale.id, cancelCommand);
    assert.equal(cancelled.replayed, false);
    assert.equal(
      (await stock(p1.variantId)).quantity,
      47,
      "cancellation restores the whole quantity"
    );
    assert.equal(
      Number((await stock(p1.variantId)).average),
      10,
      "units return at their cost snapshot, so the average is unchanged"
    );
    assert.equal(
      await digest("economy"),
      economyBeforeCancel,
      "the cancelled sale and every other sale are not edited"
    );
    assert.equal((await cancel(sale2.sale.id, cancelCommand)).replayed, true);
    assert.notEqual(await digest("ledger"), beforeS2Ledger);
    const cancelledDetail = await detail(sale2.sale.id);
    assert.ok(cancelledDetail.cancellation);
    assert.equal(
      cancelledDetail.sale.totals.totalDue,
      sale2.totals.totalDue,
      "a cancelled sale keeps its totals"
    );
    await assert.rejects(
      () =>
        giveBack(sale2.sale.id, [
          { position: 0, restockedQuantity: 0, returnedQuantity: 1 },
        ]),
      SaleNotReturnableError
    );
    await assertLedgerExplainsBalances("after the cancellation");
    tests.push(
      "cancellation: the full quantity returns to stock at the original cost, the sale and its movements are not edited, repeating the command replays, totals stay visible, and a cancelled sale accepts no return"
    );

    // ---------------------------------------------- 5. partial returns
    const economyBeforeReturns = await digest("economy");
    const first = await giveBack(sale1.sale.id, [
      { position: 0, restockedQuantity: 1, returnedQuantity: 2 },
      { position: 1, restockedQuantity: 1, returnedQuantity: 1 },
    ]);
    assert.equal(first.replayed, false);
    assert.equal((await stock(p1.variantId)).quantity, 48);
    assert.equal((await stock(p2.variantId)).quantity, 19);
    const afterFirst = await detail(sale1.sale.id);
    assert.deepEqual(
      afterFirst.returnSummary.map((line) => [
        line.position,
        line.sold,
        line.returnedQuantity,
        line.restockedQuantity,
        line.availableToReturn,
      ]),
      [
        [0, 3, 2, 1, 1],
        [1, 2, 1, 1, 1],
      ]
    );
    await assert.rejects(() =>
      giveBack(sale1.sale.id, [
        { position: 0, restockedQuantity: 0, returnedQuantity: 2 },
      ])
    );
    const ledgerBeforeSecond = await digest("ledger");
    await giveBack(sale1.sale.id, [
      { position: 0, restockedQuantity: 0, returnedQuantity: 1 },
    ]);
    assert.equal(
      await digest("ledger"),
      ledgerBeforeSecond,
      "a return that restocks nothing creates no movement and changes no balance"
    );
    await assert.rejects(() => cancel(sale1.sale.id), SaleHasReturnsError);
    assert.equal(
      await digest("economy"),
      economyBeforeReturns,
      "returns never edit the sale, its items, adjustments, or payment"
    );
    await assertLedgerExplainsBalances("after the returns");
    tests.push(
      "returns: returned and restocked quantities are tracked apart, only restocked units move stock (48 and 19), an over-return and a return after exhaustion are refused, a sale with returns cannot be cancelled, and the sale itself is never edited"
    );

    // --------------------- 6. customer reconciliation never changes the economy
    const customer = await as("customer:update", (transaction, identity) =>
      createCustomer(transaction, identity, {
        name: "Cliente Gate 4",
        phone: "+55 11 90000-0004",
        requestId: randomUUID(),
      })
    );
    const customerTwo = await as("customer:update", (transaction, identity) =>
      createCustomer(transaction, identity, {
        name: "Cliente Gate 4 (outro)",
        phone: "+55 11 90000-0005",
        requestId: randomUUID(),
      })
    );
    const economyBeforeLink = await digest("economy");
    const ledgerBeforeLink = await digest("ledger");
    const link = (
      saleId: string,
      action: "assign" | "reassign" | "unassign",
      expectedVersion: number,
      customerId?: string
    ) =>
      as("sale:assign_customer", (transaction, identity) =>
        changeSaleCustomerLink(transaction, identity, {
          action,
          ...(customerId === undefined ? {} : { customerId }),
          expectedVersion,
          saleId,
        })
      );
    await link(sale1.sale.id, "assign", 0, customer.id);
    await link(sale1.sale.id, "reassign", 1, customerTwo.id);
    await link(sale1.sale.id, "assign", 0, customer.id).then(
      () => assert.fail("a stale version must conflict"),
      () => undefined
    );
    await link(sale1.sale.id, "unassign", 2);
    await link(sale2.sale.id, "assign", 0, customer.id);
    assert.equal(
      await digest("economy"),
      economyBeforeLink,
      "customer attribution never changes the sales' economy"
    );
    assert.equal(
      await digest("ledger"),
      ledgerBeforeLink,
      "customer attribution never touches stock or movements"
    );
    const reconciled = await detail(sale1.sale.id);
    assert.equal(reconciled.customer.customerId, null);
    assert.equal(reconciled.customer.version, 3);
    assert.equal(reconciled.sale.totals.totalDue, sale1.totals.totalDue);
    tests.push(
      "customer reconciliation: assign, reassign, a stale-version conflict, and unassign (also on a cancelled sale) leave sales, items, adjustments, payments, movements, and balances byte-identical, while the link history keeps its versions"
    );

    // ------------------------------------- 7. a back-dated sale across it all
    const today = storeDay(runClock, 0, saoPaulo);
    const backDay = shiftDay(today, -10);
    const retro = await sell(
      [
        {
          chargedUnitPrice: "50.00",
          listedUnitPrice: "50.00",
          quantity: 1,
          variantId: p2.variantId,
        },
      ],
      { occurredAt: `${backDay}T10:00:00-03:00` }
    );
    assert.equal(retro.sale.occurredOn, backDay);
    const retroLedger = await admin.pool.query<{ occurred_on: string }>(
      "SELECT occurred_on::text FROM public.stock_movements WHERE organization_id = $1 AND command_id = $2",
      [tenant.organizationId, retro.sale.commandId]
    );
    assert.deepEqual(retroLedger.rows, [{ occurred_on: backDay }]);
    assert.equal((await stock(p2.variantId)).quantity, 18);
    await assertLedgerExplainsBalances("after the back-dated sale");
    tests.push(
      "dates: a sale from 10 days ago keeps its commercial date in the organization's calendar and writes its movement on that date"
    );

    // -------- 7b. half-up on a real tie: 10 % of 10.05 is 1.005, 2.5 % is 0.25125
    const tieSale = await sell(
      [
        {
          chargedUnitPrice: "10.05",
          listedUnitPrice: "10.05",
          quantity: 1,
          variantId: p1.variantId,
        },
      ],
      {
        adjustments: [
          { kind: "discount", value: { percentage: "10", type: "percentage" } },
          {
            kind: "surcharge",
            value: { percentage: "2.5", type: "percentage" },
          },
        ],
      }
    );
    const tieSubtotal = cents("10.05");
    const tieDiscount = roundHalfUp(tieSubtotal * 10n, 100n);
    const tieSurcharge = roundHalfUp(tieSubtotal * 25n, 1000n);
    assert.equal(tieDiscount, 101n, "the oracle itself rounds the tie up");
    assert.equal(tieSale.totals.discountTotal, formatCents(tieDiscount));
    assert.equal(tieSale.totals.surchargeTotal, formatCents(tieSurcharge));
    assert.equal(
      tieSale.totals.totalDue,
      formatCents(tieSubtotal - tieDiscount + tieSurcharge)
    );
    tests.push(
      "money: a percentage that lands exactly on a half cent (10 % of 10.05) rounds half-up once per adjustment, matching the oracle"
    );

    // ----------------------------------- 8. the final conservation invariant
    const conservation = await admin.pool.query<{
      net_sold: string;
      returned: string;
      variant_id: string;
    }>(
      `SELECT i.variant_id,
              sum(i.quantity) FILTER (WHERE c.id IS NULL)::text AS net_sold,
              COALESCE((SELECT sum(r.restocked_quantity) FROM public.sale_return_items r
                         JOIN public.sale_items si ON si.sale_id = r.sale_id AND si.position = r.item_position
                        WHERE si.variant_id = i.variant_id AND si.organization_id = i.organization_id), 0)::text AS returned
       FROM public.sale_items i
       LEFT JOIN public.sale_cancellations c ON c.sale_id = i.sale_id AND c.organization_id = i.organization_id
       WHERE i.organization_id = $1
       GROUP BY i.variant_id, i.organization_id`,
      [tenant.organizationId]
    );
    // a late receipt joins the invariant: opening + receipts - net sold + restocked
    await as("inventory:adjust", (transaction, identity) =>
      receiveStock(transaction, identity, {
        commandId: randomUUID(),
        commandVersion: 1,
        occurredOn: storeDay(runClock, 0, saoPaulo),
        quantity: 7,
        unitCost: "11.00",
        variantId: p1.variantId,
      })
    );
    const opening = new Map([
      [p1.variantId, 50 + 7],
      [p2.variantId, 20],
    ]);
    const balances = await Promise.all(
      conservation.rows.map((row) => stock(row.variant_id))
    );
    for (const [index, row] of conservation.rows.entries()) {
      const expected =
        (opening.get(row.variant_id) ?? 0) -
        Number(row.net_sold ?? 0) +
        Number(row.returned);
      assert.equal(
        balances[index]?.quantity,
        expected,
        "stock = opening - units of non-cancelled sales + restocked units"
      );
    }
    tests.push(
      "conservation: for every variant, stock equals opening stock plus later receipts minus the units of non-cancelled sales plus the units restocked by returns"
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
    if (loginRole && loginRoleCreated) {
      await admin.pool.query(`REVOKE "${runtimeRole}" FROM "${loginRole}"`);
      await admin.pool.query(`DROP ROLE "${loginRole}"`);
    }
    await admin.pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    `Gate 4 sales core PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
