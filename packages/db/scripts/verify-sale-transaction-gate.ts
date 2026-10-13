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
import { sql } from "drizzle-orm";
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
  createTenantFixture,
  disposableHostPattern,
  gateBranchPattern,
  expectSqlState,
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
const injectedFailureMessage = "pr43 gate injected failure";

type RuntimeDatabase = ReturnType<typeof createDatabase>;

interface Effects {
  adjustments: number;
  audit: number;
  items: number;
  movements: number;
  payments: number;
  sales: number;
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
    assert.ok(Number(migrations.rows[0]?.count) >= 35);
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
        occurredAt: "2026-10-12T15:30:00-03:00",
        payment: { anticipationRequested: false, method: "pix" },
        paymentProfile: null,
        requestId: randomUUID(),
        ...overrides,
      };
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
      "2026-10-12T18:30:00.000Z"
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
        occurred_on: "2026-10-12",
        quantity_delta: -2,
        unit_cost: "12.345678",
      },
      {
        command_index: 1,
        movement_type: "sale",
        occurred_on: "2026-10-12",
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
    // 2026-10-13T01:30Z is already the 13th in UTC but still the 12th in the
    // organization's America/Sao_Paulo time zone: the ledger date follows the
    // organization, not UTC.
    const lateEvening = command(productA2.variantId, {
      occurredAt: "2026-10-13T01:30:00Z",
    });
    await confirm(tenantA, lateEvening);
    const lateLedger = await admin.pool.query<{ occurred_on: string }>(
      "SELECT occurred_on::text FROM public.stock_movements WHERE organization_id = $1 AND command_id = $2",
      [tenantA.organizationId, lateEvening.commandId]
    );
    assert.deepEqual(lateLedger.rows, [{ occurred_on: "2026-10-12" }]);
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
        { ...saleOneInput, occurredAt: "2026-10-12T16:30:00-03:00" },
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
    const lastUnits = await createSellableProduct(tenantA, "últimas unidades", {
      cost: "2.00",
      quantity: 3,
    });
    const race = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        confirm(tenantA, command(lastUnits.variantId), concurrentDatabase)
      )
    );
    const raceWins = race.filter((result) => result.status === "fulfilled");
    const raceLosses = race.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    assert.equal(raceWins.length, 3, "exactly the available units are sold");
    assert.ok(
      raceLosses.every(
        (result) => result.reason instanceof InsufficientStockError
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
      "três unidades",
      {
        cost: "2.00",
        quantity: 3,
      }
    );
    const twoByTwo = await Promise.allSettled(
      [0, 1].map(() =>
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
      )
    );
    assert.equal(twoByTwo.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(
      (await balanceOf(tenantA, twoUnitProduct.variantId)).quantity,
      1
    );
    tests.push(
      "concurrent sales cannot oversell: 8 racing single-unit sales over 3 units sell exactly 3, and two 2-unit sales over 3 units sell one; the balance never goes negative"
    );

    const sharedCommand = command(productA2.variantId, {
      items: [
        {
          chargedUnitPrice: "3.00",
          listedUnitPrice: "3.00",
          quantity: 2,
          variantId: productA2.variantId,
        },
      ],
    });
    const a2Before = await balanceOf(tenantA, productA2.variantId);
    const sameCommand = await Promise.all(
      Array.from({ length: 6 }, () =>
        confirm(tenantA, sharedCommand, concurrentDatabase)
      )
    );
    assert.equal(sameCommand.filter((result) => !result.replayed).length, 1);
    assert.equal(new Set(sameCommand.map((result) => result.sale.id)).size, 1);
    assert.equal(
      (await balanceOf(tenantA, productA2.variantId)).quantity,
      a2Before.quantity - 2
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
    tests.push(
      "six concurrent deliveries of one command ID create one sale and one set of stock movements; the rest replay"
    );

    const orderedPairs = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) =>
        confirm(
          tenantA,
          command(productA1.variantId, {
            items: (index % 2 === 0
              ? [productA1.variantId, productA2.variantId]
              : [productA2.variantId, productA1.variantId]
            ).map((variantId) => ({
              chargedUnitPrice: "1.00",
              listedUnitPrice: "1.00",
              quantity: 1,
              variantId,
            })),
          }),
          concurrentDatabase
        )
      )
    );
    const orderedFailures = orderedPairs.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    assert.deepEqual(
      orderedFailures.map(
        (result) => redactedFailure(result.reason).split("\n")[0]
      ),
      [],
      "sales listing the same products in opposite order never deadlock"
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
      payment?: string | null;
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
            if (options.appendTo.adjustment) {
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
            sql`INSERT INTO public.sales (organization_id, command_id, occurred_at, item_count, adjustment_count) VALUES (${org}, ${commandId}, now(), ${options.itemCount ?? 1}, 0) RETURNING id`
          );
          const saleId = header.rows[0]?.id;
          assert.ok(saleId);
          await transaction.execute(
            sql`INSERT INTO public.sale_items (organization_id, sale_id, position, product_id, variant_id, product_label, quantity, listed_unit_price, charged_unit_price) VALUES (${org}, ${saleId}, 0, ${product.productId}, ${product.variantId}, 'x', 1, '10.00', '10.00')`
          );
          if (options.payment !== null) {
            await transaction.execute(
              sql`INSERT INTO public.sale_payments (organization_id, sale_id, method, amount) VALUES (${org}, ${saleId}, 'cash', ${options.payment ?? "10.00"})`
            );
          }
          if (options.movement !== false) {
            await transaction.execute(
              sql`INSERT INTO public.stock_movements (organization_id, command_id, command_index, command_version, occurred_on, movement_type, product_id, variant_id, quantity_delta) VALUES (${org}, ${commandId}, 0, 1, '2026-10-13', 'sale', ${product.productId}, ${product.variantId}, -1)`
            );
          }
        }
      );

    const headerOnly = async () =>
      await withTenantAs(
        runtimeDatabase.db,
        tenantA,
        "sale:create",
        async (transaction, identity) => {
          await transaction.execute(
            sql`INSERT INTO public.sales (organization_id, command_id, occurred_at, item_count, adjustment_count) VALUES (${identity.organizationId}, ${randomUUID()}, now(), 1, 0)`
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

    await expectSqlState(
      () =>
        withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
          client.query(
            "INSERT INTO public.sales (organization_id, command_id, occurred_at, item_count, adjustment_count) VALUES ($1, gen_random_uuid(), now(), 1, 0)",
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
      await admin.pool.query(`REVOKE "${runtimeRole}" FROM "${loginRole}"`);
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
