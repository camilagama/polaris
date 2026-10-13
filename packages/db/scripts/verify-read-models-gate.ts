import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createDatabase } from "../src/client";
import { createCustomer } from "../src/customer-repository";
import {
  InvalidInventoryBalanceCursorError,
  listInventoryBalances,
} from "../src/inventory-repository";
import { listUserOrganizations } from "../src/organization-membership-query";
import { archiveProduct, deleteProduct } from "../src/product-repository";
import { cancelSale } from "../src/sale-cancellation-repository";
import { changeSaleCustomerLink } from "../src/sale-customer-link-repository";
import { listSales } from "../src/sale-query-repository";
import { createSaleReturn } from "../src/sale-return-repository";
import {
  confirmPlainSale,
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
 * The read models behind the web screens: the organizations of a session user,
 * the stock balance list (search, filters, keyset pagination) and the filtered
 * sale history. Reads must be scoped to the organization, must not show removed
 * products, and must paginate without gaps or repeats.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const tenantDeniedPattern = /tenant_access_denied/;
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

type RuntimeDatabase = ReturnType<typeof createDatabase>;

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
    tests.push("every migration of the repository was replayed from scratch");

    const tenantA = await createTenantFixture(admin.pool, "read A");
    const tenantB = await createTenantFixture(admin.pool, "read B");
    const loginSuffix = randomUUID().replaceAll("-", "");
    loginRole = `polaris_reads_gate_${loginSuffix}`;
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

    // ------------------------------------- 1. the organizations of a user
    const extraOrg = randomUUID();
    const suspendedOrg = randomUUID();
    await admin.pool.query(
      "INSERT INTO public.organizations (id, name, timezone) VALUES ($1, 'Segunda loja', 'America/Sao_Paulo')",
      [extraOrg]
    );
    await admin.pool.query(
      "INSERT INTO public.organizations (id, name, timezone, status) VALUES ($1, 'Loja suspensa', 'America/Sao_Paulo', 'suspended')",
      [suspendedOrg]
    );
    for (const org of [extraOrg, suspendedOrg]) {
      // biome-ignore lint/performance/noAwaitInLoops: two fixture rows
      await admin.pool.query(
        "INSERT INTO public.memberships (organization_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')",
        [org, tenantA.userId]
      );
    }
    const mine = await listUserOrganizations(
      runtimeDatabase.db,
      tenantA.userId
    );
    assert.deepEqual(
      mine.map((organization) => organization.id).sort(),
      [tenantA.organizationId, extraOrg].sort(),
      "the user's active organizations only: the suspended one and tenant B's are not listed"
    );
    assert.ok(mine.every((organization) => organization.role === "owner"));
    assert.ok(
      mine.some((organization) => organization.name === "Segunda loja")
    );
    assert.deepEqual(
      await listUserOrganizations(runtimeDatabase.db, randomUUID()),
      [],
      "a user without memberships has no organizations"
    );
    await assert.rejects(
      () => listUserOrganizations(runtimeDatabase.db, " padded"),
      tenantDeniedPattern
    );
    tests.push(
      "organization.listMine reads only the session user's active memberships of active organizations, with name, time zone and role; a stranger has none and a padded id is refused"
    );

    // ------------------------------------------- 2. the stock balance list
    const alpha = await createSellableProduct(rt, tenantA, "Alpha camiseta", {
      cost: "1.00",
      quantity: 5,
    });
    const bravo = await createSellableProduct(rt, tenantA, "Bravo calça", {
      cost: "1.00",
      quantity: 1,
    });
    await createSellableProduct(rt, tenantA, "Charlie boné", {
      cost: "1.00",
      quantity: 12,
    });
    const delta = await createSellableProduct(rt, tenantA, "Delta meia", {
      cost: "1.00",
      quantity: 3,
    });
    const echo = await createSellableProduct(rt, tenantA, "Echo cinto", {
      cost: "1.00",
      quantity: 8,
    }); // Bravo is sold out; Delta is archived; Echo is removed
    await confirmPlainSale(rt, tenantA, [
      { quantity: 1, variantId: bravo.variantId },
    ]);
    await withTenantAs(
      runtimeDatabase.db,
      tenantA,
      "product:update",
      (transaction, identity) =>
        archiveProduct(transaction, identity, {
          expectedVersion: delta.version,
          id: delta.productId,
        })
    );
    // Echo must be at zero stock to be removed
    await confirmPlainSale(rt, tenantA, [
      { quantity: 8, variantId: echo.variantId },
    ]);
    await withTenantAs(
      runtimeDatabase.db,
      tenantA,
      "product:update",
      (transaction, identity) =>
        deleteProduct(transaction, identity, {
          expectedVersion: echo.version,
          id: echo.productId,
        })
    );
    const readBalances = (
      options: Parameters<typeof listInventoryBalances>[2] = {},
      tenant = tenantA
    ) =>
      withTenantAs(
        runtimeDatabase.db,
        tenant,
        "inventory:read",
        (transaction, identity) =>
          listInventoryBalances(transaction, identity, options)
      );
    const everything = await readBalances({
      includeArchived: true,
      limit: 100,
    });
    const names = everything.entries.map((entry) => entry.productName);
    assert.deepEqual(
      names,
      [
        "Produto Alpha camiseta",
        "Produto Bravo calça",
        "Produto Charlie boné",
        "Produto Delta meia",
      ],
      "ordered by name; the removed product (Echo) is not listed"
    );
    const defaultList = await readBalances({ limit: 100 });
    assert.deepEqual(
      defaultList.entries.map((entry) => entry.productName),
      ["Produto Alpha camiseta", "Produto Bravo calça", "Produto Charlie boné"],
      "archived products are hidden unless asked for"
    );
    const bravoEntry = defaultList.entries.find(
      (entry) => entry.productName === "Produto Bravo calça"
    );
    assert.equal(bravoEntry?.quantity, 0, "a sold-out variant reads as zero");
    assert.deepEqual(
      (await readBalances({ limit: 100, stock: "with_stock" })).entries.map(
        (entry) => entry.productName
      ),
      ["Produto Alpha camiseta", "Produto Charlie boné"]
    );
    assert.deepEqual(
      (await readBalances({ limit: 100, stock: "without_stock" })).entries.map(
        (entry) => entry.productName
      ),
      ["Produto Bravo calça"]
    );
    assert.deepEqual(
      (await readBalances({ limit: 100, query: "boné" })).entries.map(
        (entry) => entry.productName
      ),
      ["Produto Charlie boné"],
      "text search on the product name"
    );
    assert.deepEqual(
      (await readBalances({ limit: 100, query: "100%" })).entries,
      [],
      "LIKE wildcards in the search text are literal"
    );
    assert.deepEqual(
      (
        await readBalances({
          limit: 100,
          variantIds: [alpha.variantId],
        })
      ).entries.map((entry) => entry.variantId),
      [alpha.variantId]
    );
    // keyset pagination: pages of 1 walk every row once, in order
    const walked: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 6; page += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each page needs the previous cursor
      const next: Awaited<ReturnType<typeof readBalances>> = await readBalances(
        {
          cursor,
          includeArchived: true,
          limit: 1,
        }
      );
      walked.push(...next.entries.map((entry) => entry.productName));
      cursor = next.nextCursor;
      if (!cursor) {
        break;
      }
    }
    assert.deepEqual(walked, names, "pages never skip or repeat a row");
    await assert.rejects(
      () => readBalances({ cursor: "not-a-cursor" }),
      InvalidInventoryBalanceCursorError
    );
    assert.deepEqual(
      (await readBalances({ limit: 100 }, tenantB)).entries,
      [],
      "another organization sees none of these balances"
    );
    tests.push(
      "inventory.listBalances orders by product name, hides removed products (and archived ones unless asked), reads sold-out variants as zero, filters by stock and text with literal wildcards, re-reads chosen variants, paginates by keyset without gaps or repeats, rejects a malformed cursor and is scoped to the organization"
    );

    // -------------------------------------------- 3. the filtered sale history
    const itemProduct = await createSellableProduct(rt, tenantA, "Historico", {
      cost: "3.00",
      quantity: 50,
    });
    const customer = await withTenantAs(
      runtimeDatabase.db,
      tenantA,
      "customer:update",
      (transaction, identity) =>
        createCustomer(transaction, identity, {
          name: "Maria Historico",
          phone: "+55 11 98888-0001",
          requestId: randomUUID(),
        })
    );
    const old = await confirmPlainSale(
      rt,
      tenantA,
      [{ quantity: 1, variantId: itemProduct.variantId }],
      { occurredAt: new Date(Date.now() - 10 * 86_400_000).toISOString() }
    );
    const recent = await confirmPlainSale(rt, tenantA, [
      { quantity: 1, variantId: itemProduct.variantId },
    ]);
    const toCancel = await confirmPlainSale(rt, tenantA, [
      { quantity: 1, variantId: itemProduct.variantId },
    ]);
    const toReturn = await confirmPlainSale(rt, tenantA, [
      { quantity: 2, variantId: itemProduct.variantId },
    ]);
    await withTenantAs(
      runtimeDatabase.db,
      tenantA,
      "sale:cancel",
      (transaction, identity) =>
        cancelSale(transaction, identity, {
          commandId: randomUUID(),
          commandVersion: 1,
          saleId: toCancel.sale.id,
        })
    );
    await withTenantAs(
      runtimeDatabase.db,
      tenantA,
      "sale:return",
      (transaction, identity) =>
        createSaleReturn(transaction, identity, {
          commandId: randomUUID(),
          commandVersion: 1,
          items: [{ position: 0, restockedQuantity: 1, returnedQuantity: 1 }],
          saleId: toReturn.sale.id,
        })
    );
    await withTenantAs(
      runtimeDatabase.db,
      tenantA,
      "sale:assign_customer",
      (transaction, identity) =>
        changeSaleCustomerLink(transaction, identity, {
          action: "assign",
          customerId: customer.id,
          expectedVersion: 0,
          saleId: recent.sale.id,
        })
    );
    const history = (
      options: Parameters<typeof listSales>[2] = {},
      tenant = tenantA
    ) =>
      withTenantAs(
        runtimeDatabase.db,
        tenant,
        "sale:read",
        (transaction, identity) =>
          listSales(transaction, identity, { limit: 100, ...options })
      );
    const ids = (result: Awaited<ReturnType<typeof history>>) =>
      result.sales.map((sale) => sale.id);
    const day = (offset: number) =>
      new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const all = await history();
    for (const sale of [old, recent, toCancel, toReturn]) {
      assert.ok(ids(all).includes(sale.sale.id));
    }
    assert.ok(
      ids(await history({ occurredFrom: day(-3) })).every(
        (id) => id !== old.sale.id
      ),
      "from-date filter excludes the older sale"
    );
    assert.deepEqual(
      ids(await history({ occurredTo: day(-5) })).filter((id) =>
        [old.sale.id, recent.sale.id].includes(id)
      ),
      [old.sale.id],
      "to-date filter keeps only the older sale"
    );
    assert.deepEqual(
      ids(await history({ status: "cancelled" })),
      [toCancel.sale.id],
      "cancelled filter"
    );
    assert.ok(
      !ids(await history({ status: "confirmed" })).includes(toCancel.sale.id)
    );
    assert.deepEqual(
      ids(await history({ status: "with_returns" })),
      [toReturn.sale.id],
      "with-returns filter"
    );
    const byCustomer = await history({ customerQuery: "maria" });
    assert.deepEqual(ids(byCustomer), [recent.sale.id]);
    assert.equal(byCustomer.sales[0]?.customerName, "Maria Historico");
    assert.deepEqual(
      ids(await history({ query: "100%" })),
      [],
      "LIKE wildcards in the product text are literal"
    );
    assert.ok(
      ids(await history({ query: "historico" })).includes(recent.sale.id),
      "product label search is case-insensitive"
    );
    assert.deepEqual(ids(await history({}, tenantB)), []);
    const everyOccurredOn = all.sales.every((sale) =>
      isoDatePattern.test(sale.occurredOn)
    );
    assert.ok(everyOccurredOn, "every list entry carries its commercial date");
    tests.push(
      "sale.list filters by commercial date range, cancelled/confirmed/with-returns status, customer name and product text (case-insensitive, literal wildcards), returns the customer name and the commercial date, and is scoped to the organization"
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
    `Read models PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
