import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Client } from "pg";
import { createDatabase } from "../src/client";
import { createProduct } from "../src/product-repository";
import {
  saleAdjustments,
  saleItems,
  salePayments,
  sales,
} from "../src/schema/sale";
import { productVariants } from "../src/schema/product";
import {
  type TenantRequestIdentity,
  type TenantRequestTransaction,
  withAuthorizedTenantTransaction,
} from "../src/tenant-transaction";

const expectedBranch = "pr36-customers-gate";
const runtimeRole = "polaris_pr11_runtime";
const sqlStatePattern = /^[0-9A-Z]{5}$/;
const poolerPattern = /pooler/i;
const disposableHostPattern =
  /^ep-[a-z-]+-[a-z0-9]+\.c-2\.sa-east-1\.aws\.neon\.tech$/;

type Database = ReturnType<typeof createDatabase>["db"];
type AdminPool = ReturnType<typeof createDatabase>["pool"];

interface TenantFixture {
  organizationId: string;
  userId: string;
}

interface ProductFixture {
  productId: string;
  variantId: string;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}.`);
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

async function createTenantFixture(
  adminPool: AdminPool,
  label: string
): Promise<TenantFixture> {
  const userId = randomUUID();
  const organizationId = randomUUID();
  await adminPool.query(
    'INSERT INTO public."user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)',
    [userId, `PR38 sales gate ${label}`, `pr38-${userId}@example.invalid`]
  );
  await adminPool.query(
    "INSERT INTO public.organizations (id, name, timezone) VALUES ($1, $2, $3)",
    [organizationId, `PR38 sales gate ${label}`, "America/Sao_Paulo"]
  );
  await adminPool.query(
    "INSERT INTO public.memberships (organization_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')",
    [organizationId, userId]
  );
  return { organizationId, userId };
}

async function withTenant<T>(
  database: Database,
  fixture: TenantFixture,
  operation: (
    transaction: TenantRequestTransaction,
    identity: TenantRequestIdentity
  ) => Promise<T>
): Promise<T> {
  return await withAuthorizedTenantTransaction(
    database,
    {
      authenticatedUserId: fixture.userId,
      capability: "catalog:read",
      requestedOrganizationId: fixture.organizationId,
    },
    operation
  );
}

async function withRuntimeSqlContext<T>(
  connectionString: string,
  fixture: TenantFixture,
  operation: (client: Client) => Promise<T>
): Promise<T> {
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  await client.query("BEGIN");
  try {
    await client.query(
      "SELECT set_config('app.organization_id', $1, true), set_config('app.user_id', $2, true)",
      [fixture.organizationId, fixture.userId]
    );
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

function temporaryRuntimeUrl(adminUrl: string, role: string, password: string) {
  const url = new URL(adminUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}

async function createProductFixture(
  database: Database,
  fixture: TenantFixture,
  label: string
): Promise<ProductFixture> {
  const product = await withTenant(database, fixture, (transaction, identity) =>
    createProduct(transaction, identity, {
      name: `Produto sintético ${label}`,
      requestId: randomUUID(),
    })
  );
  const [variant] = await withTenant(
    database,
    fixture,
    async (transaction) =>
      await transaction
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(
          and(
            eq(productVariants.organizationId, fixture.organizationId),
            eq(productVariants.productId, product.id)
          )
        )
        .limit(1)
  );
  assert.ok(variant);
  return { productId: product.id, variantId: variant.id };
}

async function run() {
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.equal(branch, expectedBranch);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);

  const admin = createDatabase(adminUrl, { maxConnections: 2 });
  let runtime: ReturnType<typeof createDatabase> | undefined;
  let loginRole: string | undefined;
  let loginRoleCreated = false;
  const temporaryInsertPolicies: Array<{ name: string; table: string }> = [];
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
    assert.equal(serverRow.database_name, "neondb");
    assert.ok(Number(serverRow.server_version_num) >= 180_000);
    tests.push("disposable direct Neon connection is PostgreSQL 18");

    const tables = await admin.pool.query<{
      relforcerowsecurity: boolean;
      relname: string;
      relowner: string;
      relrowsecurity: boolean;
    }>(
      "SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) AS relowner FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = ANY($1::text[]) AND c.relkind = 'r' ORDER BY c.relname",
      [["sales", "sale_items", "sale_adjustments", "sale_payments"]]
    );
    assert.deepEqual(
      tables.rows.map((row) => row.relname),
      ["sale_adjustments", "sale_items", "sale_payments", "sales"]
    );
    assert.ok(
      tables.rows.every(
        (row) =>
          row.relrowsecurity &&
          row.relforcerowsecurity &&
          row.relowner !== runtimeRole
      )
    );

    const privileges = await admin.pool.query<{
      can_delete: boolean;
      can_insert: boolean;
      can_select: boolean;
      can_update: boolean;
      table_name: string;
    }>(
      "SELECT table_name, has_table_privilege($1, format('public.%I', table_name), 'SELECT') AS can_select, has_table_privilege($1, format('public.%I', table_name), 'INSERT') AS can_insert, has_table_privilege($1, format('public.%I', table_name), 'UPDATE') AS can_update, has_table_privilege($1, format('public.%I', table_name), 'DELETE') AS can_delete FROM unnest(ARRAY['sales', 'sale_items', 'sale_adjustments', 'sale_payments']) AS table_name ORDER BY table_name",
      [runtimeRole]
    );
    assert.deepEqual(privileges.rows, [
      {
        can_delete: false,
        can_insert: false,
        can_select: true,
        can_update: false,
        table_name: "sale_adjustments",
      },
      {
        can_delete: false,
        can_insert: false,
        can_select: true,
        can_update: false,
        table_name: "sale_items",
      },
      {
        can_delete: false,
        can_insert: false,
        can_select: true,
        can_update: false,
        table_name: "sale_payments",
      },
      {
        can_delete: false,
        can_insert: false,
        can_select: true,
        can_update: false,
        table_name: "sales",
      },
    ]);
    const runtimeInsertPolicies = await admin.pool.query<{
      policyname: string;
      tablename: string;
    }>(
      "SELECT policyname, tablename FROM pg_catalog.pg_policies WHERE schemaname = 'public' AND tablename = ANY($1::text[]) AND cmd = 'INSERT' AND $2::name = ANY(roles) ORDER BY tablename, policyname",
      [
        ["sales", "sale_items", "sale_adjustments", "sale_payments"],
        runtimeRole,
      ]
    );
    assert.deepEqual(runtimeInsertPolicies.rows, []);
    tests.push(
      "sales, items, adjustments, and payments use FORCE RLS; app runtime is read-only"
    );

    const tenantA = await createTenantFixture(admin.pool, "A");
    const tenantB = await createTenantFixture(admin.pool, "B");
    const loginSuffix = randomUUID().replaceAll("-", "");
    loginRole = `polaris_sales_gate_${loginSuffix}`;
    const loginPassword = randomBytes(24).toString("hex");
    await admin.pool.query(
      `CREATE ROLE "${loginRole}" WITH LOGIN INHERIT PASSWORD '${loginPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
    );
    loginRoleCreated = true;
    await admin.pool.query(`GRANT "${runtimeRole}" TO "${loginRole}"`);

    const gateInsertPolicyPrefixes = {
      sale_adjustments: "sa",
      sale_items: "si",
      sale_payments: "sp",
      sales: "s",
    } as const;
    const gateInsertPolicies = (
      ["sales", "sale_items", "sale_adjustments", "sale_payments"] as const
    ).map((table) => ({
      name: `${gateInsertPolicyPrefixes[table]}_${loginSuffix}_i`,
      table,
    }));
    temporaryInsertPolicies.push(...gateInsertPolicies);
    await Promise.all(
      gateInsertPolicies.map(async ({ name, table }) => {
        await admin.pool.query(
          `GRANT INSERT ON TABLE public.${table} TO "${loginRole}"`
        );
        await admin.pool.query(
          `CREATE POLICY "${name}" ON public.${table} AS PERMISSIVE FOR INSERT TO "${loginRole}" WITH CHECK (
            organization_id = NULLIF(current_setting('app.organization_id', true), '')
            AND EXISTS (
              SELECT 1
              FROM public.memberships AS membership_scope
              WHERE membership_scope.organization_id = NULLIF(current_setting('app.organization_id', true), '')
                AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
                AND membership_scope.status = 'active'
            )
            AND EXISTS (
              SELECT 1
              FROM public.organizations AS organization_scope
              WHERE organization_scope.id = NULLIF(current_setting('app.organization_id', true), '')
                AND organization_scope.status = 'active'
            )
          )`
        );
      })
    );

    const runtimeUrl = temporaryRuntimeUrl(adminUrl, loginRole, loginPassword);
    const runtimeDatabase = createDatabase(runtimeUrl, { maxConnections: 1 });
    runtime = runtimeDatabase;
    const runtimeIdentity = await runtimeDatabase.pool.query<{
      current_user: string;
    }>("SELECT current_user");
    assert.equal(runtimeIdentity.rows[0]?.current_user, loginRole);

    const productA = await createProductFixture(
      runtimeDatabase.db,
      tenantA,
      "A"
    );
    const productB = await createProductFixture(
      runtimeDatabase.db,
      tenantB,
      "B"
    );
    const tenantBSale = await withTenant(
      runtimeDatabase.db,
      tenantB,
      async (transaction, identity) => {
        const [sale] = await transaction
          .insert(sales)
          .values({
            commandId: randomUUID(),
            organizationId: identity.organizationId,
            currency: "BRL",
          })
          .returning();
        assert.ok(sale);
        const [item] = await transaction
          .insert(saleItems)
          .values({
            chargedUnitPrice: "15.00",
            listedUnitPrice: "15.00",
            organizationId: identity.organizationId,
            position: 0,
            productId: productB.productId,
            productLabel: "Produto sintético B",
            quantity: 1,
            saleId: sale.id,
            unitCost: null,
            variantId: productB.variantId,
          })
          .returning();
        assert.ok(item);
        const [adjustment] = await transaction
          .insert(saleAdjustments)
          .values({
            amount: "1.00",
            kind: "freight",
            organizationId: identity.organizationId,
            percentage: null,
            position: 0,
            saleId: sale.id,
            valueType: "fixed",
          })
          .returning();
        assert.ok(adjustment);
        const [payment] = await transaction
          .insert(salePayments)
          .values({
            amount: "16.00",
            installments: null,
            method: "cash",
            organizationId: identity.organizationId,
            saleId: sale.id,
          })
          .returning();
        assert.ok(payment);
        return sale;
      }
    );
    const commandId = randomUUID();
    const confirmedSale = await withTenant(
      runtimeDatabase.db,
      tenantA,
      async (transaction, identity) => {
        const [sale] = await transaction
          .insert(sales)
          .values({
            commandId,
            organizationId: identity.organizationId,
            currency: "BRL",
          })
          .returning();
        assert.ok(sale);
        const [item] = await transaction
          .insert(saleItems)
          .values({
            chargedUnitPrice: "89.90",
            listedUnitPrice: "100.00",
            organizationId: identity.organizationId,
            position: 0,
            productId: productA.productId,
            productLabel: "Produto sintético A",
            quantity: 2,
            saleId: sale.id,
            unitCost: null,
            variantId: productA.variantId,
          })
          .returning();
        assert.ok(item);
        const [adjustment] = await transaction
          .insert(saleAdjustments)
          .values({
            amount: "17.98",
            kind: "discount",
            organizationId: identity.organizationId,
            percentage: "10.000000",
            position: 0,
            saleId: sale.id,
            valueType: "percentage",
          })
          .returning();
        assert.ok(adjustment);
        const [payment] = await transaction
          .insert(salePayments)
          .values({
            amount: "161.82",
            installments: 3,
            method: "credit_card",
            organizationId: identity.organizationId,
            saleId: sale.id,
          })
          .returning();
        assert.ok(payment);
        return { adjustment, item, payment, sale };
      }
    );
    assert.equal(confirmedSale.sale.currency, "BRL");
    assert.ok(confirmedSale.sale.confirmedAt instanceof Date);
    assert.equal(confirmedSale.item.unitCost, null);
    assert.equal(confirmedSale.item.quantity, 2);
    assert.equal(confirmedSale.item.listedUnitPrice, "100.00");
    assert.equal(confirmedSale.item.chargedUnitPrice, "89.90");
    assert.equal(confirmedSale.adjustment.amount, "17.98");
    assert.equal(confirmedSale.adjustment.percentage, "10.000000");
    assert.equal(confirmedSale.payment.amount, "161.82");
    assert.equal(confirmedSale.payment.method, "credit_card");
    assert.equal(confirmedSale.payment.installments, 3);
    tests.push("confirmed sale snapshots preserve BRL prices and unknown cost");
    tests.push("sale adjustments persist fixed and percentage snapshots");
    tests.push("sale payments snapshot the total and credit card installments");

    await expectSqlState(
      () =>
        withTenant(
          runtimeDatabase.db,
          tenantA,
          async (transaction, identity) =>
            await transaction.insert(sales).values({
              commandId,
              organizationId: identity.organizationId,
              currency: "BRL",
            })
        ),
      "23505",
      "sale command identity is unique within an organization"
    );
    await expectSqlState(
      () =>
        withTenant(
          runtimeDatabase.db,
          tenantA,
          async (transaction, identity) =>
            await transaction.insert(sales).values({
              commandId: randomUUID(),
              organizationId: identity.organizationId,
              currency: "USD",
            })
        ),
      "23514",
      "sale currency is constrained to BRL"
    );
    tests.push("sale command identity is unique and currency is BRL");

    const validSaleItem = {
      chargedUnitPrice: "89.90",
      listedUnitPrice: "100.00",
      organizationId: tenantA.organizationId,
      position: 1,
      productId: productA.productId,
      productLabel: "Produto sintético A",
      quantity: 1,
      saleId: confirmedSale.sale.id,
      unitCost: null,
      variantId: productA.variantId,
    };
    await expectSqlState(
      () =>
        withTenant(
          runtimeDatabase.db,
          tenantA,
          async (transaction) =>
            await transaction
              .insert(saleItems)
              .values({ ...validSaleItem, quantity: 0 })
        ),
      "23514",
      "sale item quantity is positive"
    );
    await expectSqlState(
      () =>
        withTenant(
          runtimeDatabase.db,
          tenantA,
          async (transaction) =>
            await transaction
              .insert(saleItems)
              .values({ ...validSaleItem, listedUnitPrice: "100.001" })
        ),
      "23514",
      "sale prices do not exceed two decimal places"
    );
    await expectSqlState(
      () =>
        withTenant(
          runtimeDatabase.db,
          tenantA,
          async (transaction) =>
            await transaction
              .insert(saleItems)
              .values({ ...validSaleItem, unitCost: "1.0000001" })
        ),
      "23514",
      "sale cost snapshots do not exceed six decimal places"
    );
    tests.push(
      "sale item quantity and monetary scales are enforced by PostgreSQL"
    );

    const validSaleAdjustment = {
      amount: "1.00",
      kind: "discount",
      organizationId: tenantA.organizationId,
      percentage: null,
      position: 1,
      saleId: confirmedSale.sale.id,
      valueType: "fixed",
    };
    await expectSqlState(
      () =>
        withTenant(
          runtimeDatabase.db,
          tenantA,
          async (transaction) =>
            await transaction
              .insert(saleAdjustments)
              .values({ ...validSaleAdjustment, amount: "1.001" })
        ),
      "23514",
      "sale adjustment amounts do not exceed two decimal places"
    );
    await expectSqlState(
      () =>
        withTenant(
          runtimeDatabase.db,
          tenantA,
          async (transaction) =>
            await transaction.insert(saleAdjustments).values({
              ...validSaleAdjustment,
              percentage: "5.0000001",
              valueType: "percentage",
            })
        ),
      "23514",
      "sale adjustment percentages do not exceed six decimal places"
    );
    await expectSqlState(
      () =>
        withTenant(
          runtimeDatabase.db,
          tenantA,
          async (transaction) =>
            await transaction.insert(saleAdjustments).values({
              ...validSaleAdjustment,
              kind: "freight",
              percentage: "5.000000",
              valueType: "percentage",
            })
        ),
      "23514",
      "freight cannot be stored as a percentage adjustment"
    );
    await expectSqlState(
      () =>
        withTenant(
          runtimeDatabase.db,
          tenantA,
          async (transaction) =>
            await transaction.insert(saleAdjustments).values({
              ...validSaleAdjustment,
              percentage: "5.000000",
            })
        ),
      "23514",
      "fixed adjustments cannot carry a percentage snapshot"
    );
    await expectSqlState(
      () =>
        withTenant(
          runtimeDatabase.db,
          tenantA,
          async (transaction) =>
            await transaction
              .insert(saleAdjustments)
              .values({ ...validSaleAdjustment, amount: "-0.01" })
        ),
      "23514",
      "sale adjustment amounts are nonnegative"
    );
    await expectSqlState(
      () =>
        withTenant(
          runtimeDatabase.db,
          tenantA,
          async (transaction) =>
            await transaction
              .insert(saleAdjustments)
              .values({ ...validSaleAdjustment, position: 0 })
        ),
      "23505",
      "sale adjustment positions are unique within a sale"
    );
    tests.push(
      "sale adjustment kinds, scales, value modes, and positions are constrained"
    );

    const validSalePayment = {
      amount: "1.00",
      installments: null,
      method: "cash",
      organizationId: tenantA.organizationId,
      saleId: confirmedSale.sale.id,
    };
    await expectSqlState(
      () =>
        withTenant(
          runtimeDatabase.db,
          tenantA,
          async (transaction) =>
            await transaction
              .insert(salePayments)
              .values({ ...validSalePayment, amount: "1.001" })
        ),
      "23514",
      "sale payment amount does not exceed two decimal places"
    );
    await expectSqlState(
      () =>
        withTenant(
          runtimeDatabase.db,
          tenantA,
          async (transaction) =>
            await transaction
              .insert(salePayments)
              .values({ ...validSalePayment, amount: "-0.01" })
        ),
      "23514",
      "sale payment amount is nonnegative"
    );
    await expectSqlState(
      () =>
        withTenant(
          runtimeDatabase.db,
          tenantA,
          async (transaction) =>
            await transaction
              .insert(salePayments)
              .values({ ...validSalePayment, method: "crypto" })
        ),
      "23514",
      "sale payment method is in the V1 allowlist"
    );
    await expectSqlState(
      () =>
        withTenant(
          runtimeDatabase.db,
          tenantA,
          async (transaction) =>
            await transaction.insert(salePayments).values({
              ...validSalePayment,
              installments: null,
              method: "credit_card",
            })
        ),
      "23514",
      "credit card payments require installments"
    );
    await expectSqlState(
      () =>
        withTenant(
          runtimeDatabase.db,
          tenantA,
          async (transaction) =>
            await transaction.insert(salePayments).values({
              ...validSalePayment,
              installments: 0,
              method: "credit_card",
            })
        ),
      "23514",
      "credit card installments are positive"
    );
    await expectSqlState(
      () =>
        withTenant(
          runtimeDatabase.db,
          tenantA,
          async (transaction) =>
            await transaction.insert(salePayments).values({
              ...validSalePayment,
              installments: 1,
            })
        ),
      "23514",
      "non-credit card methods cannot have installments"
    );
    await expectSqlState(
      () =>
        withTenant(
          runtimeDatabase.db,
          tenantA,
          async (transaction) =>
            await transaction.insert(salePayments).values(validSalePayment)
        ),
      "23505",
      "a sale has at most one payment in V1"
    );
    tests.push(
      "sale payment methods, amounts, installments, and per-sale uniqueness are constrained"
    );

    await expectSqlState(
      () =>
        withTenant(
          runtimeDatabase.db,
          tenantA,
          async (transaction) =>
            await transaction.insert(saleItems).values({
              ...validSaleItem,
              position: 2,
              productId: productB.productId,
              variantId: productB.variantId,
            })
        ),
      "23503",
      "sale items cannot reference another organization's product/variant"
    );
    await expectSqlState(
      () =>
        withTenant(
          runtimeDatabase.db,
          tenantB,
          async (transaction, identity) =>
            await transaction.insert(saleItems).values({
              ...validSaleItem,
              organizationId: identity.organizationId,
              productId: productB.productId,
              saleId: confirmedSale.sale.id,
              variantId: productB.variantId,
            })
        ),
      "23503",
      "sale items cannot reference a sale from another organization"
    );
    await expectSqlState(
      () =>
        withTenant(
          runtimeDatabase.db,
          tenantB,
          async (transaction, identity) =>
            await transaction.insert(saleAdjustments).values({
              ...validSaleAdjustment,
              organizationId: identity.organizationId,
              position: 1,
            })
        ),
      "23503",
      "sale adjustments cannot reference a sale from another organization"
    );
    await expectSqlState(
      () =>
        withTenant(
          runtimeDatabase.db,
          tenantB,
          async (transaction, identity) =>
            await transaction.insert(salePayments).values({
              ...validSalePayment,
              organizationId: identity.organizationId,
            })
        ),
      "23503",
      "sale payments cannot reference a sale from another organization"
    );
    const crossTenantSales = await withTenant(
      runtimeDatabase.db,
      tenantA,
      async (transaction) =>
        await transaction
          .select({ id: sales.id })
          .from(sales)
          .where(eq(sales.organizationId, tenantB.organizationId))
    );
    assert.deepEqual(crossTenantSales, []);
    const crossTenantAdjustments = await withTenant(
      runtimeDatabase.db,
      tenantA,
      async (transaction) =>
        await transaction
          .select({ id: saleAdjustments.id })
          .from(saleAdjustments)
          .where(eq(saleAdjustments.organizationId, tenantB.organizationId))
    );
    assert.deepEqual(crossTenantAdjustments, []);
    const crossTenantPayments = await withTenant(
      runtimeDatabase.db,
      tenantA,
      async (transaction) =>
        await transaction
          .select({ id: salePayments.id })
          .from(salePayments)
          .where(eq(salePayments.organizationId, tenantB.organizationId))
    );
    assert.deepEqual(crossTenantPayments, []);
    assert.ok(tenantBSale.id);
    tests.push(
      "composite foreign keys and RLS isolate products, sales, adjustments, and payments by tenant"
    );

    await expectSqlState(
      () =>
        withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
          client.query(
            "UPDATE public.sales SET currency = 'USD' WHERE id = $1",
            [confirmedSale.sale.id]
          )
        ),
      "42501",
      "runtime cannot update confirmed sale snapshots"
    );
    await expectSqlState(
      () =>
        withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
          client.query("DELETE FROM public.sale_items WHERE id = $1", [
            confirmedSale.item.id,
          ])
        ),
      "42501",
      "runtime cannot delete confirmed sale items"
    );
    await expectSqlState(
      () =>
        withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
          client.query(
            "UPDATE public.sale_adjustments SET amount = '9.99' WHERE id = $1",
            [confirmedSale.adjustment.id]
          )
        ),
      "42501",
      "runtime cannot update confirmed sale adjustments"
    );
    await expectSqlState(
      () =>
        withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
          client.query("DELETE FROM public.sale_adjustments WHERE id = $1", [
            confirmedSale.adjustment.id,
          ])
        ),
      "42501",
      "runtime cannot delete confirmed sale adjustments"
    );
    await expectSqlState(
      () =>
        withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
          client.query(
            "UPDATE public.sale_payments SET amount = '9.99' WHERE id = $1",
            [confirmedSale.payment.id]
          )
        ),
      "42501",
      "runtime cannot update confirmed sale payments"
    );
    await expectSqlState(
      () =>
        withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
          client.query("DELETE FROM public.sale_payments WHERE id = $1", [
            confirmedSale.payment.id,
          ])
        ),
      "42501",
      "runtime cannot delete confirmed sale payments"
    );
    tests.push("runtime cannot update or delete confirmed sale snapshots");

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
      await Promise.all(
        temporaryInsertPolicies.map(({ name, table }) =>
          admin.pool.query(`DROP POLICY IF EXISTS "${name}" ON public.${table}`)
        )
      );
      await admin.pool.query(
        `REVOKE INSERT ON TABLE public.sales, public.sale_items, public.sale_adjustments, public.sale_payments FROM "${loginRole}"`
      );
      await admin.pool.query(`REVOKE "${runtimeRole}" FROM "${loginRole}"`);
      await admin.pool.query(`DROP ROLE "${loginRole}"`);
    }
    await admin.pool.end();
  }
}

run().catch((error: unknown) => {
  const code = sqlState(error);
  const name = error instanceof Error ? error.name : "UnknownError";
  const message =
    error instanceof Error
      ? error.message.replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, "[redacted]")
      : "Unknown gate failure.";
  console.error(
    `Sales PostgreSQL gate failed (${name}${code ? `, ${code}` : ""}): ${message}`
  );
  process.exitCode = 1;
});
