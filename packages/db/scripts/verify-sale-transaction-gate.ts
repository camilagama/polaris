import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  InsufficientStockError,
  InventoryVariantNotFoundError,
} from "@polaris/domain/inventory/inventory";
import {
  InvalidConfirmSaleCommandError,
  SaleCommandConflictError,
  SaleOccurredInFutureError,
  SalePaymentSplitMismatchError,
  SaleProductUnavailableError,
  UnsupportedConfirmSaleCommandVersionError,
} from "@polaris/domain/sales/confirm-sale";
import {
  PaymentProfileLifecycleError,
  PaymentProfileNotFoundError,
  PaymentProfileVersionConflictError,
} from "@polaris/domain/sales/payment-profile";
import { SaleDiscountExceedsSubtotalError } from "@polaris/domain/sales/sale-adjustments";
import { InvalidSalePaymentError } from "@polaris/domain/sales/sale-payment";
import { type SQL, sql } from "drizzle-orm";
import { createDatabase } from "../src/client";
import {
  getInventoryBalance,
  inventoryCount,
  receiveStock,
} from "../src/inventory-repository";
import {
  archivePaymentProfile,
  createPaymentProfile,
  restorePaymentProfile,
  updatePaymentProfile,
} from "../src/payment-profile-repository";
import { archiveProduct, createProduct } from "../src/product-repository";
import {
  type ConfirmSaleRepositoryInput,
  confirmSale,
} from "../src/sale-repository";
import { TenantAuthorizationError } from "../src/tenant-transaction";
import {
  eachRound,
  fulfilled,
  lockRow,
  raceBehindLock,
  rejections,
} from "./concurrency-support";
import { runClock, shiftDay, storeDay } from "./gate-clock";
import { inRolledBackTransaction } from "./gate-roles";
import {
  createTenantFixture,
  disposableHostPattern,
  expectSqlState,
  gateBranchPattern,
  journalMigrationCount,
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

/** A commercial day two days back in the organization's calendar: inside the retroactive window whenever the gate runs. */
const saleDay = storeDay(runClock, -2);
const injectedFailureMessage = "pr43 gate injected failure";
/** A profile id or an amount: neither belongs in a refusal's message. */
const profileOrAmountPattern = /[0-9a-f]{8}-|\d+\.\d{2}/;

type RuntimeDatabase = ReturnType<typeof createDatabase>;

interface Effects {
  adjustments: number;
  audit: number;
  items: number;
  movements: number;
  payments: number;
  sales: number;
}

/** The payment rows of a sale written directly: the parts with their positions, or one payment without a position. */
async function insertPayments(
  execute: (query: SQL) => Promise<unknown>,
  org: string,
  saleId: string,
  options: {
    parts?: { amount: string; position: number }[];
    payment?: string | null;
  }
) {
  if (options.parts) {
    for (const part of options.parts) {
      // biome-ignore lint/performance/noAwaitInLoops: the parts go in one after the other, as a Worker writes them
      await execute(
        sql`INSERT INTO public.sale_payments (organization_id, sale_id, method, amount, position) VALUES (${org}, ${saleId}, 'cash', ${part.amount}, ${part.position})`
      );
    }
  } else if (options.payment !== null) {
    await execute(
      sql`INSERT INTO public.sale_payments (organization_id, sale_id, method, amount) VALUES (${org}, ${saleId}, 'cash', ${options.payment ?? "10.00"})`
    );
  }
}

/** Every sale whose payment parts break the rule the confirmation trigger checks. */
const BROKEN_SALES = `SELECT sale.id
       FROM public.sales AS sale
       LEFT JOIN LATERAL (
         SELECT count(*) AS parts, max(payment.position) AS last_position, COALESCE(sum(payment.amount), 0) AS paid,
                count(*) FILTER (WHERE payment.amount <= 0) AS not_positive
           FROM public.sale_payments AS payment
          WHERE payment.organization_id = sale.organization_id AND payment.sale_id = sale.id
       ) AS payment ON true
       LEFT JOIN LATERAL (
         SELECT COALESCE(sum(item.charged_unit_price * item.quantity), 0) AS subtotal
           FROM public.sale_items AS item
          WHERE item.organization_id = sale.organization_id AND item.sale_id = sale.id
       ) AS item ON true
       LEFT JOIN LATERAL (
         SELECT COALESCE(sum(adjustment.amount) FILTER (WHERE adjustment.kind = 'discount'), 0) AS discounts,
                COALESCE(sum(adjustment.amount) FILTER (WHERE adjustment.kind <> 'discount'), 0) AS additions
           FROM public.sale_adjustments AS adjustment
          WHERE adjustment.organization_id = sale.organization_id AND adjustment.sale_id = sale.id
       ) AS adjustment ON true
      WHERE payment.parts <> sale.payment_count
         OR payment.last_position IS DISTINCT FROM sale.payment_count - 1
         OR payment.paid <> item.subtotal - adjustment.discounts + adjustment.additions
         OR (sale.payment_count > 1 AND payment.not_positive > 0)`;

interface PartsGraph {
  parts?: { amount: string; position: number }[];
  paymentCount?: number;
  price?: string;
  appendTo?: { saleId: string };
}

/**
 * The payment check of the confirmation trigger with parts. Every case is written directly, outside the sale command,
 * and committed: what passes stays in the database, what fails is refused when the transaction commits.
 */
async function assertPaymentParts(
  admin: ReturnType<typeof createDatabase>["pool"],
  write: (options: PartsGraph) => Promise<string | undefined>
) {
  const parts = (...amounts: [string, number][]) =>
    amounts.map(([amount, position]) => ({ amount, position }));
  const refused = (label: string, options: PartsGraph) =>
    expectSqlState(
      () => write(options),
      "23514",
      label,
      "sales_confirmation_payment_complete"
    );
  const stored = async (saleId: string | undefined) => {
    assert.ok(saleId);
    const rows = await admin.query<{
      amount: string;
      payment_count: number;
      position: number;
    }>(
      "SELECT payment.amount::text AS amount, payment.position, sale.payment_count FROM public.sale_payments AS payment JOIN public.sales AS sale ON sale.organization_id = payment.organization_id AND sale.id = payment.sale_id WHERE payment.sale_id = $1 ORDER BY payment.position",
      [saleId]
    );
    return rows.rows;
  };

  assert.deepEqual(
    await stored(
      await write({ parts: parts(["6.00", 0], ["4.00", 1]), paymentCount: 2 })
    ),
    [
      { amount: "6.00", payment_count: 2, position: 0 },
      { amount: "4.00", payment_count: 2, position: 1 },
    ],
    "two parts adding up to the total commit"
  );
  const threeParts = await write({
    parts: parts(["0.01", 2], ["3.33", 0], ["6.66", 1]),
    paymentCount: 3,
  });
  assert.deepEqual(
    (await stored(threeParts)).map((row) => row.position),
    [0, 1, 2],
    "three parts commit, whatever order they were inserted in"
  );
  const onePart = await write({});
  assert.deepEqual(
    await stored(onePart),
    [{ amount: "10.00", payment_count: 1, position: 0 }],
    "the previous Worker's form (no position, no count) commits as one part at position 0"
  );
  assert.deepEqual(
    await stored(
      await write({ parts: parts(["0.00", 0]), paymentCount: 1, price: "0.00" })
    ),
    [{ amount: "0.00", payment_count: 1, position: 0 }],
    "a sale of total zero commits with one part of zero"
  );

  await refused("two parts with a wrong sum", {
    parts: parts(["6.00", 0], ["3.99", 1]),
    paymentCount: 2,
  });
  await refused("two parts above the total", {
    parts: parts(["6.00", 0], ["4.01", 1]),
    paymentCount: 2,
  });
  await refused("a part of zero beside another part", {
    parts: parts(["10.00", 0], ["0.00", 1]),
    paymentCount: 2,
  });
  await refused("two parts of zero in a sale of total zero", {
    parts: parts(["0.00", 0], ["0.00", 1]),
    paymentCount: 2,
    price: "0.00",
  });
  await refused("a gap in the positions (0 and 2)", {
    parts: parts(["6.00", 0], ["4.00", 2]),
    paymentCount: 2,
  });
  await refused("positions that do not start at 0 (1 and 2)", {
    parts: parts(["6.00", 1], ["4.00", 2]),
    paymentCount: 2,
  });
  await refused("a header counting two parts with one written", {
    parts: parts(["10.00", 0]),
    paymentCount: 2,
  });
  await refused("a header counting one part with two written", {
    parts: parts(["6.00", 0], ["4.00", 1]),
    paymentCount: 1,
  });
  await refused("a header counting three parts with positions 0 and 2", {
    parts: parts(["6.00", 0], ["4.00", 2]),
    paymentCount: 3,
  });
  await refused("a header counting three parts with two written", {
    parts: parts(["6.00", 0], ["4.00", 1]),
    paymentCount: 3,
  });
  await refused("a part appended to a confirmed sale of one part", {
    appendTo: { saleId: onePart as string },
    parts: parts(["0.00", 1]),
  });
  await expectSqlState(
    () =>
      write({
        parts: parts(["4.00", 0], ["2.00", 1], ["2.00", 2], ["2.00", 3]),
        paymentCount: 3,
      }),
    "23514",
    "a fourth part (position 3)",
    "sale_payments_position_allowed"
  );
  await expectSqlState(
    () =>
      write({
        parts: parts(["4.00", 0], ["2.00", 1], ["2.00", 2], ["2.00", 3]),
        paymentCount: 4,
      }),
    "23514",
    "a header counting four parts",
    "sales_payment_count_allowed"
  );
  await expectSqlState(
    () => write({ parts: parts(["6.00", 0], ["4.00", 0]), paymentCount: 2 }),
    "23505",
    "two parts at the same position",
    "sale_payments_organization_sale_position_unique"
  );

  const sweep = async (reader: { query: typeof admin.query }) =>
    (await reader.query<{ id: string }>(BROKEN_SALES)).rows.map(
      (row) => row.id
    );
  // the sweep finds a sale that breaks the rule: one planted and never committed (the trigger is deferred)
  const client = await admin.connect();
  let discard = true;
  try {
    const planted = await inRolledBackTransaction(client, async () => {
      const header = await client.query<{ id: string }>(
        "INSERT INTO public.sales (organization_id, command_id, occurred_at, occurred_on, item_count, adjustment_count, payment_count) SELECT organization_id, gen_random_uuid(), occurred_at, occurred_on, 1, 0, 2 FROM public.sales LIMIT 1 RETURNING id"
      );
      const id = header.rows[0]?.id;
      assert.ok(id, "a sale to borrow the organization from");
      assert.deepEqual(
        await sweep(client),
        [id],
        "the sweep finds the planted sale"
      );
      return id;
    });
    assert.ok(planted);
    discard = false;
  } finally {
    client.release(discard);
  }
  const counted = await admin.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM public.sales"
  );
  assert.ok((counted.rows[0]?.count ?? 0) > 0, "the sweep has sales to read");
  assert.deepEqual(
    await sweep(admin),
    [],
    "every sale in the database keeps the rule"
  );
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
    assert.equal(Number(migrations.rows[0]?.count), journalMigrationCount());
    tests.push(
      "migrations 0000-0034 (and any later ones) were replayed from scratch"
    );

    const tenantA = await createTenantFixture(admin.pool, "A");
    const tenantB = await createTenantFixture(admin.pool, "B");
    const outsider = await createTenantFixture(admin.pool, "outsider");
    const loginSuffix = randomUUID().replaceAll("-", "");
    loginRole = `polaris_sale_gate_${loginSuffix}`;
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
    const identityRows = await runtimeDatabase.pool.query<{
      current_user: string;
    }>("SELECT current_user");
    assert.equal(identityRows.rows[0]?.current_user, loginRole);

    // ---------------------------------------------------------------- helpers
    const confirm = (
      tenant: TenantFixture,
      input: ConfirmSaleRepositoryInput,
      database: RuntimeDatabase = runtimeDatabase
    ) =>
      withTenantAs(
        database.db,
        tenant,
        "sale:create",
        (transaction, identity) => confirmSale(transaction, identity, input)
      );

    async function createSellableProduct(
      tenant: TenantFixture,
      label: string,
      stock: { cost: string | null; quantity: number }
    ) {
      const product = await withTenantAs(
        runtimeDatabase.db,
        tenant,
        "product:create",
        (transaction, identity) =>
          createProduct(transaction, identity, {
            name: `Produto ${label}`,
            requestId: randomUUID(),
          })
      );
      const variant = await admin.pool.query<{ id: string }>(
        "SELECT id FROM public.product_variants WHERE organization_id = $1 AND product_id = $2",
        [tenant.organizationId, product.id]
      );
      const variantId = variant.rows[0]?.id;
      assert.ok(variantId);
      await withTenantAs(
        runtimeDatabase.db,
        tenant,
        "inventory:adjust",
        async (transaction, identity) => {
          if (stock.cost === null) {
            await inventoryCount(transaction, identity, {
              commandId: randomUUID(),
              commandVersion: 1,
              expectedVersion: 0,
              occurredOn: "2026-10-01",
              physicalQuantity: stock.quantity,
              valuationUnitCost: null,
              variantId,
            });
          } else {
            await receiveStock(transaction, identity, {
              commandId: randomUUID(),
              commandVersion: 1,
              occurredOn: "2026-10-01",
              quantity: stock.quantity,
              unitCost: stock.cost,
              variantId,
            });
          }
        }
      );
      return { productId: product.id, variantId, version: product.version };
    }

    const balanceOf = (tenant: TenantFixture, variantId: string) =>
      withTenantAs(
        runtimeDatabase.db,
        tenant,
        "inventory:read",
        (transaction, identity) =>
          getInventoryBalance(transaction, identity, variantId)
      );

    async function effects(
      tenant: TenantFixture,
      commandId: string,
      requestId: string
    ): Promise<Effects> {
      const count = async (text: string, params: unknown[]) => {
        const result = await admin.pool.query<{ count: string }>(text, params);
        return Number(result.rows[0]?.count);
      };
      return {
        adjustments: await count(
          "SELECT count(*)::text AS count FROM public.sale_adjustments a JOIN public.sales s ON s.id = a.sale_id AND s.organization_id = a.organization_id WHERE s.organization_id = $1 AND s.command_id = $2",
          [tenant.organizationId, commandId]
        ),
        audit: await count(
          "SELECT count(*)::text AS count FROM public.tenant_audit_event WHERE organization_id = $1 AND request_id = $2",
          [tenant.organizationId, requestId]
        ),
        items: await count(
          "SELECT count(*)::text AS count FROM public.sale_items i JOIN public.sales s ON s.id = i.sale_id AND s.organization_id = i.organization_id WHERE s.organization_id = $1 AND s.command_id = $2",
          [tenant.organizationId, commandId]
        ),
        movements: await count(
          "SELECT count(*)::text AS count FROM public.stock_movements WHERE organization_id = $1 AND command_id = $2",
          [tenant.organizationId, commandId]
        ),
        payments: await count(
          "SELECT count(*)::text AS count FROM public.sale_payments p JOIN public.sales s ON s.id = p.sale_id AND s.organization_id = p.organization_id WHERE s.organization_id = $1 AND s.command_id = $2",
          [tenant.organizationId, commandId]
        ),
        sales: await count(
          "SELECT count(*)::text AS count FROM public.sales WHERE organization_id = $1 AND command_id = $2",
          [tenant.organizationId, commandId]
        ),
      };
    }

    const noEffects: Effects = {
      adjustments: 0,
      audit: 0,
      items: 0,
      movements: 0,
      payments: 0,
      sales: 0,
    };

    function command(
      variantId: string,
      overrides: Partial<ConfirmSaleRepositoryInput> = {}
    ): ConfirmSaleRepositoryInput {
      return {
        adjustments: [],
        commandId: randomUUID(),
        commandVersion: 1,
        items: [
          {
            chargedUnitPrice: "90.00",
            listedUnitPrice: "100.00",
            quantity: 1,
            variantId,
          },
        ],
        occurredAt: `${saleDay}T15:30:00-03:00`,
        payment: { anticipationRequested: false, method: "pix" },
        paymentProfile: null,
        requestId: randomUUID(),
        ...overrides,
      };
    }

    type SalePart = NonNullable<ConfirmSaleRepositoryInput["payments"]>[number];

    /** The same sale as `command`, paid in parts, each with its own profile choice. */
    function splitCommand(
      variantId: string,
      payments: SalePart[],
      overrides: Partial<ConfirmSaleRepositoryInput> = {}
    ): ConfirmSaleRepositoryInput {
      const {
        payment: _payment,
        paymentProfile: _paymentProfile,
        ...base
      } = command(variantId, overrides);
      return { ...base, payments };
    }

    /** Runs a rejected command and proves nothing of it (or its audit) persisted. */
    async function expectRejectedWithoutEffects(
      tenant: TenantFixture,
      input: ConfirmSaleRepositoryInput,
      expectedError: abstract new (...args: never[]) => Error,
      label: string,
      watchedVariants: string[] = []
    ) {
      const before = await Promise.all(
        watchedVariants.map((variantId) => balanceOf(tenant, variantId))
      );
      await assert.rejects(() => confirm(tenant, input), expectedError, label);
      assert.deepEqual(
        await effects(tenant, input.commandId, input.requestId ?? randomUUID()),
        noEffects,
        `${label}: no rows, movements or audit persisted`
      );
      const after = await Promise.all(
        watchedVariants.map((variantId) => balanceOf(tenant, variantId))
      );
      assert.deepEqual(after, before, `${label}: balances unchanged`);
    }

    // --------------------------------------------------------------- fixtures
    const productA1 = await createSellableProduct(tenantA, "A1", {
      cost: "12.345678",
      quantity: 20,
    });
    const productA2 = await createSellableProduct(tenantA, "A2", {
      cost: "5.50",
      quantity: 60,
    });
    const productA3 = await createSellableProduct(tenantA, "A3 sem custo", {
      cost: null,
      quantity: 5,
    });
    const productB1 = await createSellableProduct(tenantB, "B1", {
      cost: "3.00",
      quantity: 5,
    });
    const unknownCostBalance = await balanceOf(tenantA, productA3.variantId);
    assert.equal(unknownCostBalance.quantity, 5);
    assert.equal(unknownCostBalance.movingAverageCost, null);

    const profileInput = {
      name: "Maquininha sintética",
      rules: [
        {
          anticipationFee: {
            fixedAmount: "0.25",
            mode: "fixed_and_percentage" as const,
            percentage: "0.500000",
          },
          expectedSettlementDays: 45,
          installmentPlan: "issuer" as const,
          installments: 3,
          method: "credit_card",
          processingFee: {
            fixedAmount: "0.10",
            mode: "fixed_and_percentage" as const,
            percentage: "2.495600",
          },
        },
        {
          anticipationFee: { mode: "none" as const },
          expectedSettlementDays: 1,
          method: "pix",
          processingFee: {
            mode: "percentage" as const,
            percentage: "1.500000",
          },
        },
        {
          anticipationFee: { mode: "none" as const },
          expectedSettlementDays: 0,
          method: "cash",
          processingFee: { mode: "none" as const },
        },
        {
          anticipationFee: { mode: "unknown" as const },
          expectedSettlementDays: null,
          installmentPlan: "merchant" as const,
          installments: 4,
          method: "credit_card",
          processingFee: { mode: "unknown" as const },
        },
      ],
    };
    const profile = await withTenantAs(
      runtimeDatabase.db,
      tenantA,
      "organization:manage",
      (transaction, identity) =>
        createPaymentProfile(transaction, identity, profileInput)
    );
    const tenantBProfile = await withTenantAs(
      runtimeDatabase.db,
      tenantB,
      "organization:manage",
      (transaction, identity) =>
        createPaymentProfile(transaction, identity, {
          name: "Perfil do tenant B",
          rules: [
            {
              anticipationFee: { mode: "unknown" },
              method: "cash",
              processingFee: { mode: "unknown" },
            },
          ],
        })
    );
    const issuerRuleId = profile.rules.find(
      (rule) => rule.method === "credit_card" && rule.installments === 3
    )?.id;
    assert.ok(issuerRuleId);
    const selection = { expectedVersion: profile.version, id: profile.id };

    // ------------------------------------------------ 1. complete happy path
    const saleOneCommandId = randomUUID();
    const saleOneRequestId = randomUUID();
    const saleOneInput = command(productA1.variantId, {
      adjustments: [
        { kind: "discount", value: { percentage: "10", type: "percentage" } },
        { kind: "freight", value: { amount: "5", type: "fixed" } },
      ],
      commandId: saleOneCommandId,
      items: [
        {
          chargedUnitPrice: "89.90",
          listedUnitPrice: "100.00",
          quantity: 2,
          variantId: productA1.variantId,
        },
        {
          chargedUnitPrice: "50.00",
          listedUnitPrice: "50.00",
          quantity: 1,
          variantId: productA3.variantId,
        },
      ],
      payment: {
        anticipationRequested: true,
        installmentPlan: "issuer",
        installments: 3,
        method: "credit_card",
      },
      paymentProfile: selection,
      requestId: saleOneRequestId,
    });
    const saleOne = await confirm(tenantA, saleOneInput);
    assert.equal(saleOne.replayed, false);
    assert.deepEqual(saleOne.totals, {
      discountTotal: "22.98",
      freightTotal: "5.00",
      paymentSurchargeTotal: "0.00",
      subtotal: "229.80",
      surchargeTotal: "0.00",
      totalDue: "211.82",
    });
    assert.equal(saleOne.payment.amount, "211.82");
    assert.equal(saleOne.payment.paymentProfileId, profile.id);
    assert.equal(saleOne.payment.paymentProfileVersion, 1);
    assert.equal(saleOne.payment.paymentProfileName, profile.name);
    assert.equal(saleOne.payment.paymentProfileRuleId, issuerRuleId);
    assert.equal(saleOne.payment.expectedSettlementDays, 45);
    assert.equal(saleOne.payment.processingFee.mode, "fixed_and_percentage");
    assert.equal(saleOne.payment.processingFee.amount, "5.39");
    assert.equal(saleOne.payment.anticipationFee.amount, "1.31");
    assert.equal(saleOne.payment.anticipationRequested, true);
    assert.deepEqual(
      saleOne.items.map((item) => ({
        label: item.productLabel,
        position: item.position,
        unitCost: item.unitCost,
      })),
      [
        { label: "Produto A1", position: 0, unitCost: "12.345678" },
        { label: "Produto A3 sem custo", position: 1, unitCost: null },
      ]
    );
    assert.deepEqual(
      saleOne.adjustments.map((adjustment) => adjustment.amount),
      ["22.98", "5.00"]
    );
    assert.equal(saleOne.sale.currency, "BRL");
    assert.ok(saleOne.sale.confirmedAt instanceof Date);
    assert.equal(
      saleOne.sale.occurredAt.toISOString(),
      `${saleDay}T18:30:00.000Z`
    );
    assert.deepEqual(
      await effects(tenantA, saleOneCommandId, saleOneRequestId),
      {
        adjustments: 2,
        audit: 3,
        items: 2,
        movements: 2,
        payments: 1,
        sales: 1,
      }
    );
    const ledger = await admin.pool.query<{
      command_index: number;
      movement_type: string;
      occurred_on: string;
      quantity_delta: number;
      unit_cost: string | null;
    }>(
      "SELECT command_index, movement_type, occurred_on::text, quantity_delta, unit_cost FROM public.stock_movements WHERE organization_id = $1 AND command_id = $2 ORDER BY command_index",
      [tenantA.organizationId, saleOneCommandId]
    );
    assert.deepEqual(ledger.rows, [
      {
        command_index: 0,
        movement_type: "sale",
        occurred_on: saleDay,
        quantity_delta: -2,
        unit_cost: "12.345678",
      },
      {
        command_index: 1,
        movement_type: "sale",
        occurred_on: saleDay,
        quantity_delta: -1,
        unit_cost: null,
      },
    ]);
    assert.equal((await balanceOf(tenantA, productA1.variantId)).quantity, 18);
    const a3AfterSale = await balanceOf(tenantA, productA3.variantId);
    assert.equal(a3AfterSale.quantity, 4);
    assert.equal(a3AfterSale.movingAverageCost, null);
    const auditKinds = await admin.pool.query<{
      entity_type: string;
      event_type: string;
    }>(
      "SELECT entity_type, event_type FROM public.tenant_audit_event WHERE organization_id = $1 AND request_id = $2 ORDER BY event_type",
      [tenantA.organizationId, saleOneRequestId]
    );
    assert.deepEqual(
      auditKinds.rows.map((row) => `${row.entity_type}:${row.event_type}`),
      [
        "stock_movement:inventory.movement_recorded",
        "stock_movement:inventory.movement_recorded",
        "sale:sale.confirmed",
      ]
    );
    tests.push(
      "confirmSale commits header, items, adjustments, payment, ledger movements, balances, and audit together with correct snapshots"
    );
    tests.push(
      "unknown item cost stays null and a known cost is captured under the balance lock"
    );

    // ------------------------------------- 2. profile / rule / fee semantics
    const pixNoProfile = await confirm(
      tenantA,
      command(productA2.variantId, { paymentProfile: null })
    );
    assert.equal(pixNoProfile.payment.paymentProfileId, null);
    assert.equal(pixNoProfile.payment.paymentProfileRuleId, null);
    assert.equal(pixNoProfile.payment.processingFee.mode, "unknown");
    assert.equal(pixNoProfile.payment.processingFee.amount, null);
    assert.equal(pixNoProfile.payment.expectedSettlementDays, null);
    assert.equal(pixNoProfile.payment.anticipationFee.mode, "not_applicable");
    assert.equal(pixNoProfile.payment.anticipationFee.amount, "0.00");

    const creditNoRule = await confirm(
      tenantA,
      command(productA2.variantId, {
        payment: {
          anticipationRequested: true,
          installmentPlan: "merchant",
          installments: 5,
          method: "credit_card",
        },
        paymentProfile: selection,
      })
    );
    assert.equal(creditNoRule.payment.paymentProfileId, profile.id);
    assert.equal(creditNoRule.payment.paymentProfileVersion, 1);
    assert.equal(creditNoRule.payment.paymentProfileRuleId, null);
    assert.equal(creditNoRule.payment.processingFee.amount, null);
    assert.equal(creditNoRule.payment.processingFee.mode, "unknown");
    assert.equal(creditNoRule.payment.anticipationFee.mode, "unknown");
    assert.equal(creditNoRule.payment.anticipationFee.amount, null);
    assert.equal(creditNoRule.payment.expectedSettlementDays, null);

    const cashKnownZero = await confirm(
      tenantA,
      command(productA2.variantId, {
        payment: { anticipationRequested: false, method: "cash" },
        paymentProfile: selection,
      })
    );
    assert.equal(cashKnownZero.payment.processingFee.mode, "none");
    assert.equal(cashKnownZero.payment.processingFee.amount, "0.00");
    assert.equal(cashKnownZero.payment.expectedSettlementDays, 0);
    assert.equal(cashKnownZero.payment.anticipationFee.mode, "not_applicable");

    const creditNoAnticipation = await confirm(
      tenantA,
      command(productA2.variantId, {
        payment: {
          anticipationRequested: false,
          installmentPlan: "issuer",
          installments: 3,
          method: "credit_card",
        },
        paymentProfile: selection,
      })
    );
    // 0.10 + 2.4956% of 90.00 (2.24604) = 2.34604, rounded half-up once.
    assert.equal(creditNoAnticipation.payment.processingFee.amount, "2.35");
    assert.equal(
      creditNoAnticipation.payment.anticipationFee.mode,
      "not_applicable"
    );
    assert.equal(creditNoAnticipation.payment.anticipationFee.amount, "0.00");

    const creditUnknownRule = await confirm(
      tenantA,
      command(productA2.variantId, {
        payment: {
          anticipationRequested: true,
          installmentPlan: "merchant",
          installments: 4,
          method: "credit_card",
        },
        paymentProfile: selection,
      })
    );
    assert.equal(
      creditUnknownRule.payment.paymentProfileRuleId,
      profile.rules.find(
        (rule) => rule.method === "credit_card" && rule.installments === 4
      )?.id
    );
    assert.equal(creditUnknownRule.payment.processingFee.amount, null);
    assert.equal(creditUnknownRule.payment.anticipationFee.amount, null);

    const pixPercentage = await confirm(
      tenantA,
      command(productA2.variantId, {
        adjustments: [
          { kind: "freight", value: { amount: "10", type: "fixed" } },
        ],
        items: [
          {
            chargedUnitPrice: "90.00",
            listedUnitPrice: "100.00",
            quantity: 1,
            variantId: productA2.variantId,
          },
        ],
        paymentProfile: selection,
      })
    );
    assert.equal(pixPercentage.totals.totalDue, "100.00");
    assert.equal(pixPercentage.payment.processingFee.amount, "1.50");
    assert.equal(pixPercentage.payment.processingFee.percentage, "1.500000");
    assert.equal(pixPercentage.payment.expectedSettlementDays, 1);
    // 01:30Z of the following day is already that day in UTC but still `saleDay` in the
    // organization's America/Sao_Paulo time zone: the ledger date follows the
    // organization, not UTC.
    const lateEvening = command(productA2.variantId, {
      occurredAt: `${shiftDay(saleDay, 1)}T01:30:00Z`,
    });
    await confirm(tenantA, lateEvening);
    const lateLedger = await admin.pool.query<{ occurred_on: string }>(
      "SELECT occurred_on::text FROM public.stock_movements WHERE organization_id = $1 AND command_id = $2",
      [tenantA.organizationId, lateEvening.commandId]
    );
    assert.deepEqual(lateLedger.rows, [{ occurred_on: saleDay }]);
    await expectRejectedWithoutEffects(
      tenantA,
      command(productA2.variantId, { occurredAt: "9999-12-31T23:00:00-05:00" }),
      InvalidConfirmSaleCommandError,
      "an unrepresentable commercial instant is a validation error",
      [productA2.variantId]
    );
    await expectRejectedWithoutEffects(
      tenantA,
      command(productA2.variantId, { occurredAt: "2099-01-01T00:00:00Z" }),
      SaleOccurredInFutureError,
      "a commercial time ahead of the server clock is rejected",
      [productA2.variantId]
    );
    tests.push(
      "no profile, profile without exact rule, known zero, unknown rule fees, and anticipation on/off persist the right snapshots without blocking the sale"
    );

    // ------------------------------------------------------- 3. idempotency
    const replay = await confirm(tenantA, saleOneInput);
    assert.equal(replay.replayed, true);
    assert.equal(replay.sale.id, saleOne.sale.id);
    assert.deepEqual(replay.totals, saleOne.totals);
    assert.deepEqual(replay.payment, saleOne.payment);
    assert.deepEqual(
      await effects(tenantA, saleOneCommandId, saleOneRequestId),
      {
        adjustments: 2,
        audit: 3,
        items: 2,
        movements: 2,
        payments: 1,
        sales: 1,
      }
    );
    assert.equal((await balanceOf(tenantA, productA1.variantId)).quantity, 18);
    const conflicts: [string, ConfirmSaleRepositoryInput][] = [
      [
        "different quantity",
        {
          ...saleOneInput,
          items: saleOneInput.items.map((item, index) =>
            index === 0 ? { ...item, quantity: 3 } : item
          ),
        },
      ],
      [
        "different payment method",
        {
          ...saleOneInput,
          payment: { anticipationRequested: false, method: "pix" },
        },
      ],
      ["different profile choice", { ...saleOneInput, paymentProfile: null }],
      [
        "different adjustments",
        { ...saleOneInput, adjustments: saleOneInput.adjustments.slice(0, 1) },
      ],
      [
        "different commercial time",
        { ...saleOneInput, occurredAt: `${saleDay}T16:30:00-03:00` },
      ],
    ];
    for (const [label, conflicting] of conflicts) {
      // biome-ignore lint/performance/noAwaitInLoops: each conflicting replay is verified against the same committed sale in turn
      await assert.rejects(
        () => confirm(tenantA, conflicting),
        SaleCommandConflictError,
        `same command ID with ${label} is rejected`
      );
    }
    assert.equal((await balanceOf(tenantA, productA1.variantId)).quantity, 18);
    tests.push(
      "repeating a command ID replays the stored sale without duplicating rows, ledger, balance, or audit; a changed payload is a conflict"
    );

    // ----------------------------- 4. profile versions, lifecycle, isolation
    const updatedProfile = await withTenantAs(
      runtimeDatabase.db,
      tenantA,
      "organization:manage",
      (transaction, identity) =>
        updatePaymentProfile(transaction, identity, {
          ...profileInput,
          expectedVersion: 1,
          id: profile.id,
          rules: profileInput.rules.map((rule) =>
            rule.method === "credit_card" && rule.installments === 3
              ? {
                  ...rule,
                  processingFee: {
                    fixedAmount: "0.10",
                    mode: "fixed_and_percentage" as const,
                    percentage: "5.000000",
                  },
                }
              : rule
          ),
        })
    );
    assert.equal(updatedProfile.profile.version, 2);
    const afterProfileEdit = await confirm(tenantA, saleOneInput);
    assert.equal(afterProfileEdit.replayed, true);
    assert.equal(afterProfileEdit.payment.processingFee.amount, "5.39");
    assert.equal(afterProfileEdit.payment.paymentProfileVersion, 1);
    assert.equal(afterProfileEdit.payment.paymentProfileRuleId, issuerRuleId);
    await expectRejectedWithoutEffects(
      tenantA,
      command(productA2.variantId, {
        paymentProfile: { expectedVersion: 1, id: profile.id },
      }),
      PaymentProfileVersionConflictError,
      "a stale profile version is rejected",
      [productA2.variantId]
    );
    const newVersionSale = await confirm(
      tenantA,
      command(productA2.variantId, {
        payment: {
          anticipationRequested: false,
          installmentPlan: "issuer",
          installments: 3,
          method: "credit_card",
        },
        paymentProfile: { expectedVersion: 2, id: profile.id },
      })
    );
    assert.equal(newVersionSale.payment.paymentProfileVersion, 2);
    assert.equal(newVersionSale.payment.processingFee.percentage, "5.000000");
    assert.notEqual(newVersionSale.payment.paymentProfileRuleId, issuerRuleId);
    tests.push(
      "profile edits never change a confirmed sale; a stale profile version fails and a current one snapshots the new rule"
    );

    const archived = await withTenantAs(
      runtimeDatabase.db,
      tenantA,
      "organization:manage",
      (transaction, identity) =>
        archivePaymentProfile(transaction, identity, {
          expectedVersion: 2,
          id: profile.id,
        })
    );
    await expectRejectedWithoutEffects(
      tenantA,
      command(productA2.variantId, {
        paymentProfile: {
          expectedVersion: archived.profile.version,
          id: profile.id,
        },
      }),
      PaymentProfileLifecycleError,
      "an archived profile cannot be selected for a new sale",
      [productA2.variantId]
    );
    await withTenantAs(
      runtimeDatabase.db,
      tenantA,
      "organization:manage",
      (transaction, identity) =>
        restorePaymentProfile(transaction, identity, {
          expectedVersion: archived.profile.version,
          id: profile.id,
        })
    );
    await expectRejectedWithoutEffects(
      tenantA,
      command(productA2.variantId, {
        paymentProfile: { expectedVersion: 1, id: randomUUID() },
      }),
      PaymentProfileNotFoundError,
      "an unknown profile is rejected",
      [productA2.variantId]
    );
    await expectRejectedWithoutEffects(
      tenantA,
      command(productA2.variantId, {
        paymentProfile: {
          expectedVersion: tenantBProfile.version,
          id: tenantBProfile.id,
        },
      }),
      PaymentProfileNotFoundError,
      "another organization's profile cannot be used",
      [productA2.variantId]
    );
    tests.push(
      "archived, unknown, and cross-organization profiles are rejected with no partial writes"
    );

    // ------------------------------------------ 4b. a sale paid in two parts
    // a function of its own keeps run() under the complexity limit
    async function splitPaymentCases() {
      const currentProfile = await admin.pool.query<{ version: number }>(
        "SELECT version FROM public.payment_profiles WHERE id = $1",
        [profile.id]
      );
      const cardSelection = {
        expectedVersion: Number(currentProfile.rows[0]?.version),
        id: profile.id,
      };
      const pixProfile = await withTenantAs(
        runtimeDatabase.db,
        tenantA,
        "organization:manage",
        (transaction, identity) =>
          createPaymentProfile(transaction, identity, {
            name: "Pix do banco sintético",
            rules: [
              {
                anticipationFee: { mode: "none" },
                expectedSettlementDays: 0,
                method: "pix",
                processingFee: {
                  fixedAmount: "0.50",
                  mode: "fixed_and_percentage",
                  percentage: "1.000000",
                },
              },
            ],
          })
      );
      const pixSelection = {
        expectedVersion: pixProfile.version,
        id: pixProfile.id,
      };
      const pixPart = (
        amount: string,
        paymentProfile: SalePart["paymentProfile"] = pixSelection
      ): SalePart => ({
        amount,
        anticipationRequested: false,
        installmentPlan: null,
        installments: null,
        method: "pix",
        paymentProfile,
      });
      const cardPart = (
        amount: string,
        paymentProfile: SalePart["paymentProfile"] = cardSelection
      ): SalePart => ({
        amount,
        anticipationRequested: false,
        installmentPlan: "issuer",
        installments: 3,
        method: "credit_card",
        paymentProfile,
      });
      const storedParts = async (saleId: string) =>
        (
          await admin.pool.query<{
            amount: string;
            method: string;
            payment_count: number;
            position: number;
            processing_fee: string | null;
            processing_mode: string;
            profile_id: string | null;
            profile_version: number | null;
          }>(
            "SELECT payment.position, payment.method, payment.amount::text AS amount, payment.processing_fee_amount_snapshot::text AS processing_fee, payment.processing_fee_mode_snapshot AS processing_mode, payment.payment_profile_id AS profile_id, payment.payment_profile_version_snapshot AS profile_version, sale.payment_count FROM public.sale_payments AS payment JOIN public.sales AS sale ON sale.organization_id = payment.organization_id AND sale.id = payment.sale_id WHERE payment.sale_id = $1 ORDER BY payment.position",
            [saleId]
          )
        ).rows;

      const splitInput = splitCommand(productA2.variantId, [
        pixPart("40.00"),
        cardPart("50.00"),
      ]);
      const split = await confirm(tenantA, splitInput);
      assert.equal(split.replayed, false);
      assert.equal(split.totals.totalDue, "90.00");
      assert.deepEqual(
        await storedParts(split.sale.id),
        [
          {
            amount: "40.00",
            method: "pix",
            payment_count: 2,
            position: 0,
            processing_fee: "0.90",
            processing_mode: "fixed_and_percentage",
            profile_id: pixProfile.id,
            profile_version: pixProfile.version,
          },
          {
            amount: "50.00",
            method: "credit_card",
            payment_count: 2,
            position: 1,
            processing_fee: "2.60",
            processing_mode: "fixed_and_percentage",
            profile_id: profile.id,
            profile_version: cardSelection.expectedVersion,
          },
        ],
        "two rows at positions 0 and 1, payment_count 2, each part priced by its own profile on its own amount (5% + 0.10 of 50.00 is 2.60; of the 90.00 total it would be 4.60)"
      );
      assert.deepEqual(
        split.payments.map((part) => [part.position, part.method, part.amount]),
        [
          [0, "pix", "40.00"],
          [1, "credit_card", "50.00"],
        ]
      );
      const { position: _splitPosition, ...splitFirst } = split.payments[0] ?? {
        position: -1,
      };
      assert.deepEqual(
        split.payment,
        splitFirst,
        "payment is the part at position 0"
      );
      const splitEffects = await effects(
        tenantA,
        splitInput.commandId,
        splitInput.requestId ?? ""
      );
      assert.deepEqual(splitEffects, {
        adjustments: 0,
        audit: 2,
        items: 1,
        movements: 1,
        payments: 2,
        sales: 1,
      });
      tests.push(
        "a sale of two parts commits two payment rows at positions 0 and 1 with payment_count 2, adding up to the total, each with the fees of its own profile computed on its own amount; payment is the part at position 0"
      );

      await expectRejectedWithoutEffects(
        tenantA,
        splitCommand(productA2.variantId, [
          pixPart("40.00"),
          cardPart("49.99"),
        ]),
        SalePaymentSplitMismatchError,
        "parts adding up to less than the total are refused before anything is written",
        [productA2.variantId]
      );
      await expectRejectedWithoutEffects(
        tenantA,
        splitCommand(productA2.variantId, [
          pixPart("40.00"),
          cardPart("50.01"),
        ]),
        SalePaymentSplitMismatchError,
        "parts adding up to more than the total are refused before anything is written",
        [productA2.variantId]
      );
      tests.push(
        "parts that do not add up to the total the server computes are refused with sale_payment_split_mismatch, leaving no header, item, payment, movement, balance change or audit"
      );

      const splitReplay = await confirm(tenantA, splitInput);
      assert.equal(splitReplay.replayed, true);
      assert.equal(splitReplay.sale.id, split.sale.id);
      assert.deepEqual(
        await effects(
          tenantA,
          splitInput.commandId,
          splitInput.requestId ?? ""
        ),
        splitEffects,
        "a replay writes nothing"
      );
      const splitConflicts: [string, ConfirmSaleRepositoryInput][] = [
        [
          "the same parts in the other order",
          { ...splitInput, payments: [cardPart("50.00"), pixPart("40.00")] },
        ],
        [
          "another split of the same total",
          { ...splitInput, payments: [pixPart("41.00"), cardPart("49.00")] },
        ],
        [
          "another profile on the second part",
          {
            ...splitInput,
            payments: [pixPart("40.00"), cardPart("50.00", null)],
          },
        ],
        ["one part only", { ...splitInput, payments: [pixPart("90.00")] }],
        [
          "the single-payment form",
          command(productA2.variantId, {
            commandId: splitInput.commandId,
            payment: { anticipationRequested: false, method: "pix" },
            paymentProfile: pixSelection,
            requestId: splitInput.requestId ?? null,
          }),
        ],
      ];
      for (const [label, input] of splitConflicts) {
        // biome-ignore lint/performance/noAwaitInLoops: each conflict is checked against the same stored sale, one at a time
        await assert.rejects(
          () => confirm(tenantA, input),
          SaleCommandConflictError,
          label
        );
      }
      assert.deepEqual(
        await effects(
          tenantA,
          splitInput.commandId,
          splitInput.requestId ?? ""
        ),
        splitEffects,
        "a conflict writes nothing"
      );
      tests.push(
        "the same command ID with the same parts replays without a new row; the parts in another order, another split, another profile, fewer parts or the single-payment form are a sale_command_conflict"
      );

      const racedProduct = await createSellableProduct(
        tenantA,
        "partes em corrida",
        {
          cost: "2.00",
          quantity: 10,
        }
      );
      const racedCommand = splitCommand(racedProduct.variantId, [
        pixPart("30.00"),
        cardPart("60.00"),
      ]);
      const { results: racedResults } = await raceBehindLock({
        adminUrl,
        hold: [lockRow("products", "id", racedProduct.productId)],
        label: "four deliveries of one split sale",
        racers: Array.from(
          { length: 4 },
          () => () => confirm(tenantA, racedCommand, concurrentDatabase)
        ),
      });
      assert.deepEqual(rejections(racedResults), [], "no delivery fails");
      const raced = fulfilled(racedResults);
      assert.equal(raced.filter((result) => !result.replayed).length, 1);
      assert.equal(new Set(raced.map((result) => result.sale.id)).size, 1);
      assert.deepEqual(
        await effects(
          tenantA,
          racedCommand.commandId,
          racedCommand.requestId ?? ""
        ),
        { ...splitEffects },
        "one sale, two payment rows, one movement"
      );
      assert.equal(
        (await balanceOf(tenantA, racedProduct.variantId)).quantity,
        9
      );
      tests.push(
        "four concurrent deliveries of one split sale create one sale with its two parts; the rest replay"
      );

      const partRefusals: [
        string,
        SalePart[],
        abstract new (...args: never[]) => Error & { part: number | null },
      ][] = [
        [
          "a stale profile version on the second part",
          [
            pixPart("40.00"),
            cardPart("50.00", {
              expectedVersion: cardSelection.expectedVersion - 1,
              id: profile.id,
            }),
          ],
          PaymentProfileVersionConflictError,
        ],
        [
          "an unknown profile on the second part",
          [
            pixPart("40.00"),
            cardPart("50.00", { expectedVersion: 1, id: randomUUID() }),
          ],
          PaymentProfileNotFoundError,
        ],
        [
          "another organization's profile on the second part",
          [
            pixPart("40.00"),
            cardPart("50.00", {
              expectedVersion: tenantBProfile.version,
              id: tenantBProfile.id,
            }),
          ],
          PaymentProfileNotFoundError,
        ],
        [
          "the same profile named at two versions",
          [
            pixPart("40.00", pixSelection),
            pixPart("50.00", {
              expectedVersion: pixSelection.expectedVersion + 1,
              id: pixProfile.id,
            }),
          ],
          PaymentProfileVersionConflictError,
        ],
      ];
      for (const [label, payments, refusal] of partRefusals) {
        const refused = splitCommand(productA2.variantId, payments);
        // biome-ignore lint/performance/noAwaitInLoops: each refusal is proven without effects before the next one
        await assert.rejects(
          () => confirm(tenantA, refused),
          (error: unknown) => {
            assert.ok(error instanceof refusal, label);
            assert.equal(error.part, 1, `${label}: names the second part`);
            assert.doesNotMatch(
              error.message,
              profileOrAmountPattern,
              `${label}: no profile id and no amount in the message`
            );
            return true;
          },
          label
        );
        assert.deepEqual(
          await effects(tenantA, refused.commandId, refused.requestId ?? ""),
          noEffects,
          `${label}: the whole sale is refused`
        );
      }
      const bothStale = splitCommand(productA2.variantId, [
        pixPart("40.00", {
          expectedVersion: pixSelection.expectedVersion + 1,
          id: pixProfile.id,
        }),
        cardPart("50.00", { expectedVersion: 1, id: randomUUID() }),
      ]);
      await assert.rejects(
        () => confirm(tenantA, bothStale),
        (error: unknown) => {
          assert.ok(error instanceof PaymentProfileVersionConflictError);
          assert.equal(error.part, 0, "the first part that fails is named");
          return true;
        }
      );
      assert.deepEqual(
        await effects(tenantA, bothStale.commandId, bothStale.requestId ?? ""),
        noEffects
      );
      tests.push(
        "a profile refused on one part (stale version, unknown, another organization's, one profile at two versions) refuses the whole sale with that part's position and writes nothing; with both parts refused, the first is named"
      );

      // two parts of the same method under two profiles: each part takes the rule of its own profile
      const samePixTwoProfiles = await confirm(
        tenantA,
        splitCommand(productA2.variantId, [
          pixPart("40.00"),
          pixPart("50.00", cardSelection),
        ])
      );
      assert.deepEqual(
        (await storedParts(samePixTwoProfiles.sale.id)).map((row) => [
          row.position,
          row.profile_id,
          row.processing_fee,
        ]),
        [
          [0, pixProfile.id, "0.90"],
          [1, profile.id, "0.75"],
        ],
        "1% + 0.50 of 40.00 under one profile, 1.5% of 50.00 under the other"
      );
      tests.push(
        "two parts of the same method under two profiles each take the rule of their own profile"
      );

      const partWithoutProfile = await confirm(
        tenantA,
        splitCommand(productA2.variantId, [
          pixPart("40.00"),
          cardPart("50.00", null),
        ])
      );
      const partWithoutRule = await confirm(
        tenantA,
        splitCommand(productA2.variantId, [
          pixPart("40.00"),
          {
            amount: "50.00",
            anticipationRequested: false,
            installmentPlan: null,
            installments: null,
            method: "debit_card",
            paymentProfile: pixSelection,
          },
        ])
      );
      for (const [label, sale] of [
        ["a part without a profile", partWithoutProfile],
        ["a part whose profile has no rule for its method", partWithoutRule],
      ] as const) {
        // biome-ignore lint/performance/noAwaitInLoops: two sales, read one after the other
        const [first, second] = await storedParts(sale.sale.id);
        assert.equal(
          first?.processing_fee,
          "0.90",
          `${label}: the other part keeps its fees`
        );
        assert.equal(
          second?.processing_fee,
          null,
          `${label}: the fee is unknown, never zero`
        );
        assert.equal(second?.processing_mode, "unknown", label);
        assert.equal(sale.payments[1]?.processingFee.amount, null, label);
        assert.equal(sale.payments[1]?.processingFee.mode, "unknown", label);
      }
      tests.push(
        "a part without a profile, or whose profile has no rule for its method, keeps unknown fees (null, never zero) while the other part keeps its own"
      );
    }
    await splitPaymentCases();

    // ------------------------------------------------------- 5. validation
    type ErrorClass = abstract new (...args: never[]) => Error;
    const invalidInputs: [string, ConfirmSaleRepositoryInput, ErrorClass][] = [
      [
        "credit card without plan",
        command(productA2.variantId, {
          payment: {
            anticipationRequested: false,
            installmentPlan: null,
            installments: 2,
            method: "credit_card",
          },
        }),
        InvalidSalePaymentError,
      ],
      [
        "installments on pix",
        command(productA2.variantId, {
          payment: {
            anticipationRequested: false,
            installments: 2,
            method: "pix",
          },
        }),
        InvalidSalePaymentError,
      ],
      [
        "anticipation on a non-credit method",
        command(productA2.variantId, {
          payment: { anticipationRequested: true, method: "debit_card" },
        }),
        InvalidSalePaymentError,
      ],
      [
        "three-decimal price",
        command(productA2.variantId, {
          items: [
            {
              chargedUnitPrice: "1.001",
              listedUnitPrice: "1.00",
              quantity: 1,
              variantId: productA2.variantId,
            },
          ],
        }),
        InvalidConfirmSaleCommandError,
      ],
      [
        "zero quantity",
        command(productA2.variantId, {
          items: [
            {
              chargedUnitPrice: "1.00",
              listedUnitPrice: "1.00",
              quantity: 0,
              variantId: productA2.variantId,
            },
          ],
        }),
        InvalidConfirmSaleCommandError,
      ],
      [
        "discount above subtotal",
        command(productA2.variantId, {
          adjustments: [
            { kind: "discount", value: { amount: "90.01", type: "fixed" } },
          ],
        }),
        SaleDiscountExceedsSubtotalError,
      ],
      [
        "unsupported command version",
        command(productA2.variantId, { commandVersion: 2 }),
        UnsupportedConfirmSaleCommandVersionError,
      ],
    ];
    for (const [label, input, expectedError] of invalidInputs) {
      // biome-ignore lint/performance/noAwaitInLoops: each rejected command is verified before the next one starts
      await expectRejectedWithoutEffects(
        tenantA,
        input,
        expectedError,
        `invalid ${label}`,
        [productA2.variantId]
      );
    }
    tests.push(
      "payment, installment, anticipation, adjustment, quantity, and monetary-scale validation rejects before any write"
    );

    // ------------------------------------------------------------ 6. stock
    const a2Balance = await balanceOf(tenantA, productA2.variantId);
    await expectRejectedWithoutEffects(
      tenantA,
      command(productA2.variantId, {
        items: [
          {
            chargedUnitPrice: "1.00",
            listedUnitPrice: "1.00",
            quantity: a2Balance.quantity + 1,
            variantId: productA2.variantId,
          },
        ],
      }),
      InsufficientStockError,
      "insufficient stock",
      [productA2.variantId]
    );
    await expectRejectedWithoutEffects(
      tenantA,
      command(productA2.variantId, {
        items: [
          {
            chargedUnitPrice: "1.00",
            listedUnitPrice: "1.00",
            quantity: 1,
            variantId: productA1.variantId,
          },
          {
            chargedUnitPrice: "1.00",
            listedUnitPrice: "1.00",
            quantity: 6,
            variantId: productA3.variantId,
          },
        ],
      }),
      InsufficientStockError,
      "a later line without stock rolls back the earlier line",
      [productA1.variantId, productA3.variantId]
    );
    await expectRejectedWithoutEffects(
      tenantA,
      command(productA2.variantId, {
        items: [
          {
            chargedUnitPrice: "1.00",
            listedUnitPrice: "1.00",
            quantity: 3,
            variantId: productA3.variantId,
          },
          {
            chargedUnitPrice: "1.00",
            listedUnitPrice: "1.00",
            quantity: 3,
            variantId: productA3.variantId,
          },
        ],
      }),
      InsufficientStockError,
      "two lines of the same variant cannot jointly exceed the balance",
      [productA3.variantId]
    );
    const archivedProduct = await createSellableProduct(tenantA, "arquivado", {
      cost: "1.00",
      quantity: 3,
    });
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
    await expectRejectedWithoutEffects(
      tenantA,
      command(archivedProduct.variantId),
      SaleProductUnavailableError,
      "an archived product cannot be sold",
      [archivedProduct.variantId]
    );
    await expectRejectedWithoutEffects(
      tenantA,
      command(randomUUID()),
      InventoryVariantNotFoundError,
      "an unknown variant cannot be sold"
    );
    tests.push(
      "insufficient stock, repeated lines, archived products, and unknown variants fail with balances, ledger, and audit untouched"
    );

    // -------------------------------------------- 7. injected failures
    await admin.pool.query(
      `CREATE FUNCTION public.pr43_gate_inject_failure() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION '${injectedFailureMessage}' USING ERRCODE = 'P0001'; END; $f$`
    );
    failureFunctionCreated = true;
    const failurePoints: Array<{
      event: "INSERT" | "UPDATE";
      label: string;
      table: string;
      when?: string;
    }> = [
      { event: "INSERT", label: "sale header", table: "sales" },
      {
        event: "INSERT",
        label: "stock movement",
        table: "stock_movements",
        when: "NEW.movement_type = 'sale'",
      },
      { event: "UPDATE", label: "balance update", table: "inventory_balances" },
      { event: "INSERT", label: "sale items", table: "sale_items" },
      { event: "INSERT", label: "sale adjustments", table: "sale_adjustments" },
      { event: "INSERT", label: "sale payment", table: "sale_payments" },
      {
        event: "INSERT",
        label: "movement audit",
        table: "tenant_audit_event",
        when: "NEW.event_type = 'inventory.movement_recorded'",
      },
      {
        event: "INSERT",
        label: "sale audit",
        table: "tenant_audit_event",
        when: "NEW.event_type = 'sale.confirmed'",
      },
    ];
    for (const point of failurePoints) {
      const triggerName = `pr43_gate_fail_${point.table}`;
      // biome-ignore lint/performance/noAwaitInLoops: each injected failure point must be proven in isolation
      await admin.pool.query(
        `CREATE TRIGGER ${triggerName} BEFORE ${point.event} ON public.${point.table} FOR EACH ROW ${point.when ? `WHEN (${point.when})` : ""} EXECUTE FUNCTION public.pr43_gate_inject_failure()`
      );
      try {
        const input = command(productA2.variantId, {
          adjustments: [
            { kind: "freight", value: { amount: "2", type: "fixed" } },
          ],
          items: [
            {
              chargedUnitPrice: "10.00",
              listedUnitPrice: "10.00",
              quantity: 2,
              variantId: productA2.variantId,
            },
            {
              chargedUnitPrice: "20.00",
              listedUnitPrice: "20.00",
              quantity: 1,
              variantId: productA1.variantId,
            },
          ],
        });
        const before = await Promise.all([
          balanceOf(tenantA, productA1.variantId),
          balanceOf(tenantA, productA2.variantId),
        ]);
        await assert.rejects(
          () => confirm(tenantA, input),
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
        assert.deepEqual(
          await effects(tenantA, input.commandId, input.requestId ?? ""),
          noEffects,
          `rollback after failure at ${point.label} leaves no sale, ledger, or audit rows`
        );
        const after = await Promise.all([
          balanceOf(tenantA, productA1.variantId),
          balanceOf(tenantA, productA2.variantId),
        ]);
        assert.deepEqual(
          after,
          before,
          `balances restored after ${point.label}`
        );
      } finally {
        await admin.pool.query(
          `DROP TRIGGER IF EXISTS ${triggerName} ON public.${point.table}`
        );
      }
    }
    const retried = await confirm(tenantA, command(productA2.variantId));
    assert.equal(retried.replayed, false);
    tests.push(
      `a failure injected at each of ${failurePoints.length} write points (header, ledger movement, balance, items, adjustments, payment, movement audit, sale audit) rolls back sale, stock, ledger, and audit together`
    );

    // ------------------------------------------------------ 8. concurrency
    // Every race holds the contended product lock first, releases its racers
    // from one start barrier and fails if the database never saw them blocked
    // (concurrency-support.ts); each round repeats it with fresh data.
    const rounds = await eachRound(async (round) => {
      const lastUnits = await createSellableProduct(
        tenantA,
        `últimas unidades ${round}`,
        { cost: "2.00", quantity: 3 }
      );
      const { results: race } = await raceBehindLock({
        adminUrl,
        hold: [lockRow("products", "id", lastUnits.productId)],
        label: "8 sales of 1 unit over 3 units",
        racers: Array.from(
          { length: 8 },
          () => () =>
            confirm(tenantA, command(lastUnits.variantId), concurrentDatabase)
        ),
      });
      const raceWins = race.filter((result) => result.status === "fulfilled");
      assert.equal(raceWins.length, 3, "exactly the available units are sold");
      assert.ok(
        rejections(race).every(
          (reason) => reason instanceof InsufficientStockError
        ),
        "every loser fails with insufficient stock"
      );
      const lastBalance = await balanceOf(tenantA, lastUnits.variantId);
      assert.equal(lastBalance.quantity, 0);
      const lastMovements = await admin.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM public.stock_movements WHERE organization_id = $1 AND variant_id = $2 AND movement_type = 'sale'",
        [tenantA.organizationId, lastUnits.variantId]
      );
      assert.equal(lastMovements.rows[0]?.count, "3");

      const twoUnitProduct = await createSellableProduct(
        tenantA,
        `três unidades ${round}`,
        { cost: "2.00", quantity: 3 }
      );
      const { results: twoByTwo } = await raceBehindLock({
        adminUrl,
        hold: [lockRow("products", "id", twoUnitProduct.productId)],
        label: "two sales of 2 units over 3 units",
        racers: [0, 1].map(
          () => () =>
            confirm(
              tenantA,
              command(twoUnitProduct.variantId, {
                items: [
                  {
                    chargedUnitPrice: "5.00",
                    listedUnitPrice: "5.00",
                    quantity: 2,
                    variantId: twoUnitProduct.variantId,
                  },
                ],
              }),
              concurrentDatabase
            )
        ),
      });
      assert.equal(fulfilled(twoByTwo).length, 1);
      assert.equal(
        rejections(twoByTwo).filter(
          (reason) => reason instanceof InsufficientStockError
        ).length,
        1,
        "the loser fails with insufficient stock"
      );
      assert.equal(
        (await balanceOf(tenantA, twoUnitProduct.variantId)).quantity,
        1
      );

      const sharedProduct = await createSellableProduct(
        tenantA,
        `comando repetido ${round}`,
        { cost: "2.00", quantity: 10 }
      );
      const sharedCommand = command(sharedProduct.variantId, {
        items: [
          {
            chargedUnitPrice: "3.00",
            listedUnitPrice: "3.00",
            quantity: 2,
            variantId: sharedProduct.variantId,
          },
        ],
      });
      const { results: sameCommandResults } = await raceBehindLock({
        adminUrl,
        hold: [lockRow("products", "id", sharedProduct.productId)],
        label: "six deliveries of one command",
        racers: Array.from(
          { length: 6 },
          () => () => confirm(tenantA, sharedCommand, concurrentDatabase)
        ),
      });
      assert.deepEqual(
        rejections(sameCommandResults),
        [],
        "no delivery of the same command fails"
      );
      const sameCommand = fulfilled(sameCommandResults);
      assert.equal(sameCommand.filter((result) => !result.replayed).length, 1);
      assert.equal(
        new Set(sameCommand.map((result) => result.sale.id)).size,
        1
      );
      assert.equal(
        (await balanceOf(tenantA, sharedProduct.variantId)).quantity,
        8
      );
      assert.equal(
        (
          await effects(
            tenantA,
            sharedCommand.commandId,
            sharedCommand.requestId ?? ""
          )
        ).sales,
        1
      );

      // Six sales (three per order) all queue behind the same two product locks;
      // each holds them for a full transaction, so more would only measure how far
      // away the database is from the machine running the gate.
      const pairA = await createSellableProduct(tenantA, `par A ${round}`, {
        cost: "2.00",
        quantity: 10,
      });
      const pairB = await createSellableProduct(tenantA, `par B ${round}`, {
        cost: "2.00",
        quantity: 10,
      });
      const { results: orderedPairs } = await raceBehindLock({
        adminUrl,
        hold: [lockRow("products", "id", pairA.productId)],
        label: "six sales listing two products in opposite order",
        racers: Array.from(
          { length: 6 },
          (_, index) => () =>
            confirm(
              tenantA,
              command(pairA.variantId, {
                items: (index % 2 === 0
                  ? [pairA.variantId, pairB.variantId]
                  : [pairB.variantId, pairA.variantId]
                ).map((variantId) => ({
                  chargedUnitPrice: "1.00",
                  listedUnitPrice: "1.00",
                  quantity: 1,
                  variantId,
                })),
              }),
              concurrentDatabase
            )
        ),
      });
      assert.deepEqual(
        rejections(orderedPairs).map(
          (reason) => redactedFailure(reason).split("\n")[0]
        ),
        [],
        "sales listing the same products in opposite order never deadlock"
      );
      assert.equal((await balanceOf(tenantA, pairA.variantId)).quantity, 4);
      assert.equal((await balanceOf(tenantA, pairB.variantId)).quantity, 4);
    });
    tests.push(
      `concurrent sales cannot oversell: 8 racing single-unit sales over 3 units sell exactly 3, and two 2-unit sales over 3 units sell one; the balance never goes negative (${rounds} round(s), each released from a barrier with the racers seen blocked on the lock)`
    );
    tests.push(
      "six concurrent deliveries of one command ID create one sale and one set of stock movements; the rest replay"
    );
    tests.push(
      "concurrent sales listing products in opposite order do not deadlock (locks are taken in product id order)"
    );

    // --------------------------------------------- 9. organization isolation
    const tenantBSaleCommandId = saleOneCommandId;
    const tenantBSale = await confirm(
      tenantB,
      command(productB1.variantId, { commandId: tenantBSaleCommandId })
    );
    assert.equal(tenantBSale.replayed, false);
    assert.notEqual(tenantBSale.sale.id, saleOne.sale.id);
    await expectRejectedWithoutEffects(
      tenantB,
      command(productA1.variantId),
      InventoryVariantNotFoundError,
      "another organization's variant cannot be sold",
      [productB1.variantId]
    );
    const bSees = await withRuntimeSqlContext(runtimeUrl, tenantB, (client) =>
      client.query("SELECT id, organization_id FROM public.sales")
    );
    assert.ok(
      bSees.rows.every(
        (row: { organization_id: string }) =>
          row.organization_id === tenantB.organizationId
      )
    );
    assert.ok(
      bSees.rows.some((row: { id: string }) => row.id === tenantBSale.sale.id)
    );
    await assert.rejects(
      () =>
        withTenantAs(
          runtimeDatabase.db,
          tenantA,
          "catalog:read",
          (transaction, identity) =>
            confirmSale(transaction, identity, command(productA2.variantId))
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
          "sale:create",
          (transaction, identity) =>
            confirmSale(transaction, identity, command(productA2.variantId))
        ),
      (error: unknown) =>
        error instanceof TenantAuthorizationError &&
        error.code === "tenant_access_denied"
    );
    tests.push(
      "organization identity comes from the authorized transaction: command IDs are per-organization, foreign variants/profiles are invisible, other tenants cannot read the sale, and wrong capability or membership is denied"
    );

    // ------------------------------------- 10. database-enforced atomicity
    interface GraphOptions {
      appendTo?: { adjustment?: boolean; item?: boolean; saleId: string };
      itemCount?: number;
      movement?: boolean;
      movementOn?: string;
      payment?: string | null;
      /** The parts written with their positions, in place of the one payment without a position. */
      parts?: { amount: string; position: number }[];
      /** The header's `payment_count`; left out, the header is written as before the parts existed. */
      paymentCount?: number;
      price?: string;
    }
    const writeGraph = (
      tenant: TenantFixture,
      product: { productId: string; variantId: string },
      options: GraphOptions
    ) =>
      withTenantAs(
        runtimeDatabase.db,
        tenant,
        "sale:create",
        async (transaction, identity) => {
          const org = identity.organizationId;
          const commandId = randomUUID();
          if (options.appendTo) {
            const { saleId } = options.appendTo;
            if (options.parts) {
              await insertPayments(
                (query) => transaction.execute(query),
                org,
                saleId,
                options
              );
            } else if (options.appendTo.adjustment) {
              await transaction.execute(
                sql`INSERT INTO public.sale_adjustments (organization_id, sale_id, kind, value_type, amount, position) VALUES (${org}, ${saleId}, 'freight', 'fixed', '1.00', 9)`
              );
            } else {
              await transaction.execute(
                sql`INSERT INTO public.sale_items (organization_id, sale_id, position, product_id, variant_id, product_label, quantity, listed_unit_price, charged_unit_price) VALUES (${org}, ${saleId}, 9, ${product.productId}, ${product.variantId}, 'x', 1, '10.00', '10.00')`
              );
            }
            return;
          }
          const header = await transaction.execute<{ id: string }>(
            options.paymentCount === undefined
              ? sql`INSERT INTO public.sales (organization_id, command_id, occurred_at, occurred_on, item_count, adjustment_count) VALUES (${org}, ${commandId}, now(), '2026-10-13', ${options.itemCount ?? 1}, 0) RETURNING id`
              : sql`INSERT INTO public.sales (organization_id, command_id, occurred_at, occurred_on, item_count, adjustment_count, payment_count) VALUES (${org}, ${commandId}, now(), '2026-10-13', ${options.itemCount ?? 1}, 0, ${options.paymentCount}) RETURNING id`
          );
          const saleId = header.rows[0]?.id;
          assert.ok(saleId);
          const price = options.price ?? "10.00";
          await transaction.execute(
            sql`INSERT INTO public.sale_items (organization_id, sale_id, position, product_id, variant_id, product_label, quantity, listed_unit_price, charged_unit_price) VALUES (${org}, ${saleId}, 0, ${product.productId}, ${product.variantId}, 'x', 1, ${price}, ${price})`
          );
          await insertPayments(
            (query) => transaction.execute(query),
            org,
            saleId,
            options
          );
          if (options.movement !== false) {
            // the product may hold no stock: a receipt keeps the ledger at the balance
            await transaction.execute(
              sql`INSERT INTO public.stock_movements (organization_id, command_id, command_index, command_version, occurred_on, movement_type, product_id, variant_id, quantity_delta, unit_cost) VALUES (${org}, ${randomUUID()}, 0, 1, '2026-10-13', 'receipt', ${product.productId}, ${product.variantId}, 1, '1.000000')`
            );
            await transaction.execute(
              sql`INSERT INTO public.stock_movements (organization_id, command_id, command_index, command_version, occurred_on, movement_type, product_id, variant_id, quantity_delta) VALUES (${org}, ${commandId}, 0, 1, ${options.movementOn ?? "2026-10-13"}, 'sale', ${product.productId}, ${product.variantId}, -1)`
            );
          }
          return saleId;
        }
      );

    const headerOnly = async () =>
      await withTenantAs(
        runtimeDatabase.db,
        tenantA,
        "sale:create",
        async (transaction, identity) => {
          await transaction.execute(
            sql`INSERT INTO public.sales (organization_id, command_id, occurred_at, occurred_on, item_count, adjustment_count) VALUES (${identity.organizationId}, ${randomUUID()}, now(), '2026-10-13', 1, 0)`
          );
        }
      );
    await expectSqlState(
      headerOnly,
      "23514",
      "a header committed alone is rejected",
      "sales_confirmation_items_complete"
    );
    await expectSqlState(
      () => writeGraph(tenantA, productA2, { payment: null }),
      "23514",
      "header and item without a payment are rejected",
      "sales_confirmation_payment_complete"
    );
    await expectSqlState(
      () => writeGraph(tenantA, productA2, { itemCount: 2 }),
      "23514",
      "a header declaring more items than were written is rejected",
      "sales_confirmation_items_complete"
    );
    await expectSqlState(
      () => writeGraph(tenantA, productA2, { payment: "9.99" }),
      "23514",
      "a payment different from the total due is rejected",
      "sales_confirmation_payment_complete"
    );
    await expectSqlState(
      () => writeGraph(tenantA, productA2, { movementOn: "2026-10-12" }),
      "23514",
      "a sale movement dated differently from the sale's commercial date is rejected",
      "sales_confirmation_stock_complete"
    );
    await expectSqlState(
      () => writeGraph(tenantA, productA2, { movement: false }),
      "23514",
      "a sale without its stock movement is rejected",
      "sales_confirmation_stock_complete"
    );
    await expectSqlState(
      () =>
        writeGraph(tenantA, productA2, {
          appendTo: { item: true, saleId: saleOne.sale.id },
        }),
      "23514",
      "items cannot be appended to an already confirmed sale",
      "sales_confirmation_items_complete"
    );
    await expectSqlState(
      () =>
        writeGraph(tenantA, productA2, {
          appendTo: { adjustment: true, saleId: saleOne.sale.id },
        }),
      "23514",
      "adjustments cannot be appended to an already confirmed sale",
      "sales_confirmation_adjustments_complete"
    );
    await expectSqlState(
      () =>
        withTenantAs(
          runtimeDatabase.db,
          tenantA,
          "sale:create",
          async (transaction, identity) => {
            await transaction.execute(
              sql`INSERT INTO public.stock_movements (organization_id, command_id, command_index, command_version, occurred_on, movement_type, product_id, variant_id, quantity_delta) VALUES (${identity.organizationId}, ${randomUUID()}, 0, 1, '2026-10-13', 'sale', ${productA2.productId}, ${productA2.variantId}, -1)`
            );
          }
        ),
      "23514",
      "a sale stock movement without a sale is rejected",
      "stock_movements_sale_requires_confirmed_sale"
    );
    // A coherent graph written directly is accepted: the guard checks
    // completeness, it does not forbid the aggregate.
    await writeGraph(tenantA, productA2, {});
    tests.push(
      "PostgreSQL rejects header-only, payment-less, mismatched-total, ledger-less, appended-item, appended-adjustment, and orphan sale-movement commits (deferred completeness triggers)"
    );

    await assertPaymentParts(admin.pool, (options) =>
      writeGraph(tenantA, productA2, options)
    );
    tests.push(
      "a sale is paid in one to three parts at positions 0, 1, 2 adding up to the total due, written directly by the runtime and committed: two and three parts are accepted; a wrong sum, a part of zero beside another, a gap in the positions, a header counting more or fewer parts than were written and a part appended to a confirmed sale are refused at commit as sales_confirmation_payment_complete; a fourth part (position 3) or a count of 4 is refused by its CHECK, a repeated position by the unique index; the form of the previous Worker (one payment without a position, a header without a count) and a sale of total zero in one part of zero still commit, and every sale in the database keeps the rule"
    );

    await expectSqlState(
      () =>
        withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
          client.query(
            "INSERT INTO public.sales (organization_id, command_id, occurred_at, occurred_on, item_count, adjustment_count) VALUES ($1, gen_random_uuid(), now(), '2026-10-13', 1, 0)",
            [tenantB.organizationId]
          )
        ),
      "42501",
      "sales INSERT cannot claim another organization"
    );
    for (const statement of [
      "UPDATE public.sales SET currency = 'BRL'",
      "DELETE FROM public.sales",
      "DELETE FROM public.sale_items",
      "UPDATE public.sale_items SET quantity = 2",
      "UPDATE public.sale_adjustments SET amount = '0.00'",
      "DELETE FROM public.sale_adjustments",
      "UPDATE public.sale_payments SET amount = '0.00'",
      "DELETE FROM public.sale_payments",
      "TRUNCATE public.sales CASCADE",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each denial is its own probe and must not run concurrently
      await expectSqlState(
        () =>
          withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
            client.query(statement)
          ),
        "42501",
        `runtime cannot run: ${statement}`
      );
    }
    const childTableInserts = [
      `INSERT INTO public.sale_items (organization_id, sale_id, position, product_id, variant_id, product_label, quantity, listed_unit_price, charged_unit_price) VALUES ('${tenantB.organizationId}', '${tenantBSale.sale.id}', 5, '${productB1.productId}', '${productB1.variantId}', 'x', 1, '1.00', '1.00')`,
      `INSERT INTO public.sale_adjustments (organization_id, sale_id, kind, value_type, amount, position) VALUES ('${tenantB.organizationId}', '${tenantBSale.sale.id}', 'freight', 'fixed', '1.00', 5)`,
      `INSERT INTO public.sale_payments (organization_id, sale_id, method, amount) VALUES ('${tenantB.organizationId}', '${tenantBSale.sale.id}', 'cash', '1.00')`,
    ];
    for (const statement of childTableInserts) {
      // biome-ignore lint/performance/noAwaitInLoops: each denial is its own probe and must not run concurrently
      await expectSqlState(
        () =>
          withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
            client.query(statement)
          ),
        "42501",
        "child INSERT cannot target another organization's sale"
      );
    }
    tests.push(
      "runtime INSERT is tenant-scoped by RLS on all four sale tables; UPDATE, DELETE, and TRUNCATE are denied by ACL"
    );

    const functionAcl = await admin.pool.query<{ can_execute: boolean }>(
      "SELECT has_function_privilege('public', 'public.check_sale_confirmation_complete()', 'EXECUTE') AS can_execute"
    );
    assert.equal(functionAcl.rows[0]?.can_execute, false);
    tests.push("the completeness trigger function is not executable by PUBLIC");

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
        "sales",
        "stock_movements",
        "inventory_balances",
        "sale_items",
        "sale_adjustments",
        "sale_payments",
        "tenant_audit_event",
      ]) {
        // biome-ignore lint/performance/noAwaitInLoops: the gate must tear down injected triggers one at a time, in order
        await admin.pool.query(
          `DROP TRIGGER IF EXISTS pr43_gate_fail_${table} ON public.${table}`
        );
      }
      await admin.pool.query(
        "DROP FUNCTION IF EXISTS public.pr43_gate_inject_failure()"
      );
    }
    if (runtime) {
      await runtime.pool.end();
    }
    if (concurrent) {
      await concurrent.pool.end();
    }
    if (loginRole && loginRoleCreated) {
      await admin.pool.query(`DROP ROLE "${loginRole}"`);
    }
    await admin.pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    `Sale transaction PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
