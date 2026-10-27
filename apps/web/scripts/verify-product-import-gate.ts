import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { ProductImportRowInput } from "@polaris/contracts";
import { createDatabase } from "@polaris/db/client";
import {
  inventoryCount,
  organizationToday,
  receiveStock,
} from "@polaris/db/inventory-repository";
import {
  createProduct,
  findExistingProductNames,
  lockProductNameAndFindProducts,
  readProductCreation,
} from "@polaris/db/product-repository";
import {
  type TenantRequestIdentity,
  type TenantRequestTransaction,
  withAuthorizedTenantTransaction,
} from "@polaris/db/tenant-transaction";
import type { TenantTransactionRunner } from "../src/server/tenant-request-context";
import { createProductWithOpeningStock } from "../src/server/use-cases/create-product-with-opening-stock";
import { importProductBatch } from "../src/server/use-cases/import-product-batch";

/**
 * The import of a spreadsheet (corte 2.5), run through the real use case on the real schema, under the runtime role
 * and row security: each row in its own transaction with its product, variant and opening stock; sending a slice
 * again repeats it; a name the store already has (an archived product too, with other case and spaces) is skipped,
 * and a deleted one is not; two rows of one slice with one name enter once; two slices at the same time with the
 * same name (two tabs) enter once, by the lock of the store and the name; the name of another store never counts;
 * a character PostgreSQL refuses is a refused row, never a fault; and a Free store stops at its limit without a row
 * past it. The read of the preview (`findExistingProductNames`) answers the same names.
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
const ZONE = "America/Sao_Paulo";
const FREE_VARIANTS = 50;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}.`);
  }
  return value;
}

interface Tenant {
  organizationId: string;
  userId: string;
}

async function createTenant(
  pool: ReturnType<typeof createDatabase>["pool"],
  label: string,
  plan: "free" | "pro"
): Promise<Tenant> {
  const userId = randomUUID();
  const organizationId = randomUUID();
  await pool.query(
    'INSERT INTO public."user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)',
    [userId, `Import ${label}`, `import-${userId}@example.invalid`]
  );
  await pool.query(
    "INSERT INTO public.organizations (id, name, timezone) VALUES ($1, $2, $3)",
    [organizationId, `Import ${label}`, ZONE]
  );
  await pool.query(
    "INSERT INTO public.memberships (organization_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')",
    [organizationId, userId]
  );
  // a Free store is one without a billing record
  if (plan === "pro") {
    await pool.query(
      "INSERT INTO public.organization_billing (organization_id, state, access_ends_at) VALUES ($1, 'active', now() + interval '365 days')",
      [organizationId]
    );
  }
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

let rowNumber = 1;
function row(
  name: string,
  extra: Partial<ProductImportRowInput> = {}
): ProductImportRowInput {
  rowNumber += 1;
  return {
    categoryId: null,
    description: null,
    initialStock: { commandId: randomUUID(), quantity: 4, unitCost: "7.50" },
    listPrice: "19.90",
    name,
    productId: randomUUID(),
    rowNumber,
    variantId: randomUUID(),
    ...extra,
  };
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

    const tenantA = await createTenant(admin.pool, "A", "pro");
    const tenantB = await createTenant(admin.pool, "B", "pro");
    const tenantFree = await createTenant(admin.pool, "Free", "free");
    const loginSuffix = randomUUID().replaceAll("-", "");
    loginRole = `polaris_import_gate_${loginSuffix}`;
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

    /** What the RPC does: one transaction per row, each authorized for `product:create`. */
    const inTransactionOf =
      (
        tenant: Tenant,
        capability = "product:create"
      ): TenantTransactionRunner =>
      <T>(
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
    const importSlice = (tenant: Tenant, rows: ProductImportRowInput[]) =>
      importProductBatch(
        inTransactionOf(tenant),
        rows,
        { requestId: null },
        {
          createProductWithOpeningStock,
          creation: {
            createProduct,
            inventoryCount,
            readProductCreation,
            receiveStock,
          },
          lockProductNameAndFindProducts,
          organizationToday,
        }
      );
    const statuses = async (tenant: Tenant, rows: ProductImportRowInput[]) =>
      (await importSlice(tenant, rows)).results.map((r) => r.status);
    const scalar = async (sql: string, ...params: unknown[]) =>
      Number(
        (await admin.pool.query<{ n: string }>(sql, params)).rows[0]?.n ?? "-1"
      );
    const footprint = async (tenant: Tenant) => ({
      movements: await scalar(
        "SELECT count(*)::text AS n FROM public.stock_movements WHERE organization_id = $1",
        tenant.organizationId
      ),
      products: await scalar(
        "SELECT count(*)::text AS n FROM public.products WHERE organization_id = $1",
        tenant.organizationId
      ),
      variants: await scalar(
        "SELECT count(*)::text AS n FROM public.product_variants WHERE organization_id = $1",
        tenant.organizationId
      ),
    });

    // ======================================================================
    // 1. Each row with its variant and stock; sending again repeats it
    // ======================================================================
    const first = [
      row("Camiseta Azul"),
      row("Boné", {
        initialStock: { commandId: randomUUID(), quantity: 2, unitCost: null },
      }),
      // without stock, so it can be deleted (a deleted product holds no stock)
      row("Meia", { initialStock: null }),
    ];
    assert.deepEqual(await statuses(tenantA, first), [
      "created",
      "created",
      "created",
    ]);
    assert.deepEqual(await footprint(tenantA), {
      movements: 2,
      products: 3,
      variants: 3,
    });
    assert.deepEqual(await statuses(tenantA, first), [
      "repeated",
      "repeated",
      "repeated",
    ]);
    assert.deepEqual(await footprint(tenantA), {
      movements: 2,
      products: 3,
      variants: 3,
    });
    tests.push(
      "each row is created with its default variant and, when it has one, its opening stock; the same slice sent again is repeated and writes nothing"
    );

    // ======================================================================
    // 2. A name the store has: other case and spaces, archived counts, deleted does not
    // ======================================================================
    const archivedId = first[1]?.productId as string;
    await admin.pool.query(
      "UPDATE public.products SET archived_at = now() WHERE id = $1",
      [archivedId]
    );
    const meiaId = first[2]?.productId as string;
    // archived, then deleted alone with the next version, as the tombstone guard of the database asks
    await admin.pool.query(
      "UPDATE public.products SET archived_at = now(), version = version + 1 WHERE id = $1",
      [meiaId]
    );
    await admin.pool.query(
      "UPDATE public.products SET deleted_at = now(), version = version + 1 WHERE id = $1",
      [meiaId]
    );
    assert.deepEqual(
      await statuses(tenantA, [
        row("  camiseta   AZUL "),
        row("BONÉ"),
        row("meia"),
      ]),
      ["exists_by_name", "exists_by_name", "created"]
    );
    tests.push(
      "a name the store already has is skipped without case or repeated spaces, an archived product counts and a deleted one does not"
    );

    // ======================================================================
    // 3. One name twice in one slice, and in two slices at the same time
    // ======================================================================
    assert.deepEqual(await statuses(tenantA, [row("Luva"), row("luva")]), [
      "created",
      "exists_by_name",
    ]);
    const together = await Promise.all([
      importSlice(tenantA, [row("Cinto"), row("Bolsa")]),
      importSlice(tenantA, [row("CINTO"), row("bolsa ")]),
    ]);
    const enteredTogether = together
      .flatMap((slice) => slice.results)
      .filter((result) => result.status === "created").length;
    assert.equal(enteredTogether, 2);
    const repeatedNames = await scalar(
      `SELECT count(*)::text AS n FROM (
         SELECT lower(btrim(regexp_replace(name, '[[:space:]]+', ' ', 'g'))) AS k
           FROM public.products
          WHERE organization_id = $1 AND deleted_at IS NULL
          GROUP BY 1 HAVING count(*) > 1
       ) repeated`,
      tenantA.organizationId
    );
    assert.equal(repeatedNames, 0);
    tests.push(
      "a name twice in one slice enters once, and two slices at the same time with the same names (two tabs) enter each name once, by the lock of the store and the name"
    );

    // ======================================================================
    // 4. Another store's names never count, and neither store sees the other's
    // ======================================================================
    assert.deepEqual(await statuses(tenantB, [row("Camiseta Azul")]), [
      "created",
    ]);
    const readNames = (tenant: Tenant, names: string[]) =>
      inTransactionOf(
        tenant,
        "catalog:read"
      )((transaction, identity) =>
        findExistingProductNames(transaction, identity, names)
      );
    const namesOfA = await readNames(tenantA, [
      "camiseta  azul",
      "Boné",
      "Meia",
      "Inexistente",
    ]);
    // Meia was imported again after its deletion: it exists
    assert.deepEqual([...namesOfA].sort(), ["Boné", "Meia", "camiseta  azul"]);
    assert.deepEqual(await readNames(tenantB, ["Boné", "Camiseta Azul"]), [
      "Camiseta Azul",
    ]);
    assert.deepEqual(await readNames(tenantB, []), []);
    tests.push(
      "the name of another store never counts, and the read of the preview answers, by store, the names asked that a product has (archived included)"
    );

    // ======================================================================
    // 5. Text the database refuses is a refused row, never a fault of the slice
    // ======================================================================
    const hostile = await importSlice(tenantA, [
      row("Bolsa\u0000nula"),
      row("Bolsa\u202Einvertida"),
      row("Carteira", { description: "nota\u0000" }),
      row('=HYPERLINK("http://x")', { description: "<script>x</script>" }),
    ]);
    assert.deepEqual(
      hostile.results.map((result) =>
        result.status === "invalid" ? result.field : result.status
      ),
      ["name", "name", "description", "created"]
    );
    const [kept] = (
      await admin.pool.query<{ description: string; name: string }>(
        "SELECT name, description FROM public.products WHERE id = $1",
        [
          hostile.results[3]?.status === "created"
            ? hostile.results[3].productId
            : "",
        ]
      )
    ).rows;
    assert.deepEqual(kept, {
      description: "<script>x</script>",
      name: '=HYPERLINK("http://x")',
    });
    tests.push(
      "U+0000 and the characters that turn the text are refused rows and the slice goes on; a formula and HTML are kept as the text they came as"
    );

    // ======================================================================
    // 6. A Free store stops at its limit, and no row past it is written
    // ======================================================================
    const freeRows = Array.from({ length: FREE_VARIANTS + 3 }, (_, index) =>
      row(`Free ${index}`)
    );
    const freeStatuses: string[] = [];
    for (let start = 0; start < freeRows.length; start += 10) {
      // biome-ignore lint/performance/noAwaitInLoops: the slices go one after another, as the client sends them
      const slice = await statuses(
        tenantFree,
        freeRows.slice(start, start + 10)
      );
      freeStatuses.push(...slice);
    }
    assert.deepEqual(freeStatuses, [
      ...Array.from({ length: FREE_VARIANTS }, () => "created"),
      "limit_reached",
      "limit_reached",
      "limit_reached",
    ]);
    assert.equal((await footprint(tenantFree)).variants, FREE_VARIANTS);
    // the repeat of a row that filled the plan is still a repeat
    assert.deepEqual(
      await statuses(
        tenantFree,
        freeRows.slice(FREE_VARIANTS - 1, FREE_VARIANTS)
      ),
      ["repeated"]
    );
    tests.push(
      "a Free store imports up to its 50 variants; the rest is limit_reached with nothing written, and the repeat of the row that filled it is still a repeat"
    );

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
  console.error(`Product import gate failed (${redactedFailure(error)})`);
  process.exitCode = 1;
});
