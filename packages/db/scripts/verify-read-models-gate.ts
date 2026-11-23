import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/client";
import { createCustomer } from "../src/customer-repository";
import {
  InvalidInventoryBalanceCursorError,
  listInventoryBalances,
} from "../src/inventory-repository";
import { listUserOrganizations } from "../src/organization-membership-query";
import {
  archiveProduct,
  createProduct,
  listProducts,
} from "../src/product-repository";
import { cancelSale } from "../src/sale-cancellation-repository";
import { changeSaleCustomerLink } from "../src/sale-customer-link-repository";
import { getSale, listSales } from "../src/sale-query-repository";
import { createSaleReturn } from "../src/sale-return-repository";
import { runClock, storeDay, storeNoon } from "./gate-clock";
import { inRolledBackTransaction } from "./gate-roles";
import { archiveThenDeleteProduct } from "./product-lifecycle-support";
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
import {
  checkOtherRuntimeCannotList,
  checkUserOrganizationsCatalog,
  checkUserOrganizationsEquality,
  checkUserOrganizationsLeaveNoSetting,
  checkUserOrganizationsRefusals,
  listedBySeparateStatements,
} from "./user-organizations-gate-checks";

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

    await checkUserOrganizationsCatalog(admin.pool);
    await checkOtherRuntimeCannotList(admin.pool, tenantA.userId);
    const runtimeClient = await runtimeDatabase.pool.connect();
    try {
      await checkUserOrganizationsRefusals(runtimeClient, tenantB.userId);
      await checkUserOrganizationsLeaveNoSetting(
        runtimeClient,
        tenantA.userId,
        mine
      );
      assert.deepEqual(
        mine,
        await inRolledBackTransaction(runtimeClient, () =>
          listedBySeparateStatements(runtimeClient, tenantA.userId)
        ),
        "listUserOrganizations answers what the reference reading in separate statements answers"
      );
    } finally {
      runtimeClient.release();
    }
    assert.deepEqual(
      await listUserOrganizations(runtimeDatabase.db, tenantA.userId),
      mine,
      "a second listUserOrganizations on the one connection of the pool answers the same"
    );
    const compared = await checkUserOrganizationsEquality(admin.pool);
    assert.equal(compared.length, 6);
    tests.push(
      `list_user_organizations is SECURITY INVOKER with a pinned search_path and EXECUTE only for the tenant runtime, returns the four fields, refuses a null, empty or padded user with 42501, keeps every setting local (session values come back after COMMIT and ROLLBACK, on one connection) and leaves both empty for the rest of its transaction, and answers exactly what the separate statements answer (${compared.join("; ")})`
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
        archiveThenDeleteProduct(transaction, identity, {
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

    // ------------- 2b. the unknown-cost filter (a tenant of its own: the lists above stay as they were)
    const tenantC = await createTenantFixture(admin.pool, "read C");
    const readBalancesOf = (
      options: Parameters<typeof listInventoryBalances>[2],
      tenant = tenantC
    ) =>
      withTenantAs(
        runtimeDatabase.db,
        tenant,
        "inventory:read",
        (transaction, identity) =>
          listInventoryBalances(transaction, identity, options)
      );
    await createSellableProduct(rt, tenantC, "Custo conhecido", {
      cost: "2.00",
      quantity: 4,
    });
    await createSellableProduct(rt, tenantC, "Custo contado", {
      cost: null,
      quantity: 3,
    }); // a balance row whose average cost is null
    const archivedUnknown = await createSellableProduct(
      rt,
      tenantC,
      "Custo arquivado",
      { cost: null, quantity: 2 }
    );
    await withTenantAs(
      runtimeDatabase.db,
      tenantC,
      "product:update",
      (transaction, identity) =>
        archiveProduct(transaction, identity, {
          expectedVersion: archivedUnknown.version,
          id: archivedUnknown.productId,
        })
    );
    // no balance row at all: the LEFT JOIN reads null
    const withoutRowProduct = await withTenantAs(
      runtimeDatabase.db,
      tenantC,
      "product:create",
      (transaction, identity) =>
        createProduct(transaction, identity, {
          name: "Produto Sem linha de saldo",
          requestId: randomUUID(),
        })
    );
    // `/products?produto=<uuid>` looks the product up in this list: another store's id is not in it
    const productIdsOf = (tenant: typeof tenantC) =>
      withTenantAs(
        runtimeDatabase.db,
        tenant,
        "catalog:read",
        (transaction, identity) =>
          listProducts(transaction, identity, { status: "all" })
      ).then((list) => list.map((item) => item.id));
    assert.ok(
      (await productIdsOf(tenantC)).includes(withoutRowProduct.id),
      "the owner store lists its own product"
    );
    assert.equal(
      (await productIdsOf(tenantA)).includes(withoutRowProduct.id),
      false,
      "another store's product id is not in the list a product link is resolved against"
    );
    const namesOf = (page: { entries: { productName: string }[] }) =>
      page.entries.map((entry) => entry.productName);
    const allCosts = await readBalancesOf({ limit: 100 });
    assert.deepEqual(
      namesOf(allCosts),
      [
        "Produto Custo conhecido",
        "Produto Custo contado",
        "Produto Sem linha de saldo",
      ],
      "cost: all (and no cost option) lists every active variant, as before the filter"
    );
    assert.deepEqual(
      namesOf(await readBalancesOf({ cost: "all", limit: 100 })),
      namesOf(allCosts),
      "cost: all is the same answer as no cost option"
    );
    const unknownCosts = await readBalancesOf({ cost: "unknown", limit: 100 });
    assert.deepEqual(
      namesOf(unknownCosts),
      ["Produto Custo contado", "Produto Sem linha de saldo"],
      "cost: unknown keeps the null-cost balance and the variant without a balance row"
    );
    const withoutRow = unknownCosts.entries.find(
      (entry) => entry.productName === "Produto Sem linha de saldo"
    );
    assert.equal(withoutRow?.version, 0);
    assert.equal(withoutRow?.quantity, 0);
    assert.equal(withoutRow?.movingAverageCost, null);
    assert.deepEqual(
      unknownCosts.entries,
      allCosts.entries.filter((entry) => entry.movingAverageCost === null),
      "the filtered list is the unfiltered list minus the known costs: one query, one count"
    );
    assert.deepEqual(
      namesOf(
        await readBalancesOf({
          cost: "unknown",
          includeArchived: true,
          limit: 100,
        })
      ),
      [
        "Produto Custo arquivado",
        "Produto Custo contado",
        "Produto Sem linha de saldo",
      ],
      "an archived variant with an unknown cost shows only when archived products are asked for"
    );
    assert.deepEqual(
      namesOf(
        await readBalancesOf({
          cost: "unknown",
          limit: 100,
          stock: "without_stock",
        })
      ),
      ["Produto Sem linha de saldo"],
      "the cost filter combines with the stock filter"
    );
    const unknownWalked: string[] = [];
    let unknownCursor: string | null = null;
    const readUnknownPage = (after: string | null) =>
      readBalancesOf({ cost: "unknown", cursor: after, limit: 1 });
    for (let page = 0; page < 4; page += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each page needs the previous cursor
      const next = await readUnknownPage(unknownCursor);
      unknownWalked.push(...namesOf(next));
      unknownCursor = next.nextCursor;
      if (!unknownCursor) {
        break;
      }
    }
    assert.deepEqual(
      unknownWalked,
      namesOf(unknownCosts),
      "the unknown-cost list paginates without gaps or repeats"
    );
    assert.deepEqual(
      (await readBalances({ cost: "unknown", limit: 100 }, tenantA)).entries,
      [],
      "another organization's unknown-cost variants are not listed"
    );
    tests.push(
      "inventory.listBalances cost: unknown keeps the variants with a null average cost, including the one without a balance row, equals the unfiltered list minus the known costs, combines with the stock and archived filters, paginates by keyset and stays inside the organization; cost: all changes nothing; a product id of another store is not in the product list a link is resolved against"
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
      { occurredAt: storeNoon(storeDay(runClock, -10)) }
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
    // the organization's calendar (America/Sao_Paulo), not UTC's, on the clock fixed at the start of the run
    const day = (offset: number) => storeDay(runClock, offset);
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

    // ------------------------ 4. the main part of a sale with more than one part
    const partsDay = storeDay(runClock, -1);
    const writeParts = (
      parts: { amount: string; id?: string; method: string }[]
    ) =>
      withTenantAs(
        runtimeDatabase.db,
        tenantA,
        "sale:create",
        async (transaction, identity) => {
          const org = identity.organizationId;
          const commandId = randomUUID();
          const total = parts
            .reduce(
              (sum, part) => sum + Math.round(Number(part.amount) * 100),
              0
            )
            .toString();
          const price = `${total.slice(0, -2) || "0"}.${total.slice(-2).padStart(2, "0")}`;
          const header = await transaction.execute<{ id: string }>(
            sql`INSERT INTO public.sales (organization_id, command_id, occurred_at, occurred_on, item_count, adjustment_count, payment_count) VALUES (${org}, ${commandId}, ${storeNoon(partsDay)}, ${partsDay}, 1, 0, ${parts.length}) RETURNING id`
          );
          const saleId = header.rows[0]?.id;
          assert.ok(saleId);
          await transaction.execute(
            sql`INSERT INTO public.sale_items (organization_id, sale_id, position, product_id, variant_id, product_label, quantity, listed_unit_price, charged_unit_price, unit_cost) VALUES (${org}, ${saleId}, 0, ${itemProduct.productId}, ${itemProduct.variantId}, 'Historico', 1, ${price}, ${price}, '3.000000')`
          );
          for (const [position, part] of parts.entries()) {
            const card = part.method === "credit_card";
            // biome-ignore lint/performance/noAwaitInLoops: the parts go in at their positions, one after the other
            await transaction.execute(
              sql`INSERT INTO public.sale_payments (id, organization_id, sale_id, method, amount, position, installments, installment_plan_unknown) VALUES (COALESCE(${part.id ?? null}::uuid, uuidv7()), ${org}, ${saleId}, ${part.method}, ${part.amount}, ${position}, ${card ? 1 : null}, ${card})`
            );
          }
          // a receipt of the unit sold keeps the ledger at the balance
          await transaction.execute(
            sql`INSERT INTO public.stock_movements (organization_id, command_id, command_index, command_version, occurred_on, movement_type, product_id, variant_id, quantity_delta, unit_cost) VALUES (${org}, ${randomUUID()}, 0, 1, ${partsDay}, 'receipt', ${itemProduct.productId}, ${itemProduct.variantId}, 1, '3.000000')`
          );
          await transaction.execute(
            sql`INSERT INTO public.stock_movements (organization_id, command_id, command_index, command_version, occurred_on, movement_type, product_id, variant_id, quantity_delta, unit_cost) VALUES (${org}, ${commandId}, 0, 1, ${partsDay}, 'sale', ${itemProduct.productId}, ${itemProduct.variantId}, -1, '3.000000')`
          );
          return saleId;
        }
      );
    const lowestId = "00000000-0000-7000-8000-000000000001";
    const highestId = "ffffffff-ffff-7fff-bfff-ffffffffffff";
    const partSales = {
      biggestFirst: await writeParts([
        { amount: "14.90", method: "pix" },
        { amount: "5.00", method: "cash" },
      ]),
      biggestLast: await writeParts([
        { amount: "9.90", method: "pix" },
        { amount: "30.00", method: "credit_card" },
      ]),
      onlyPart: (
        await confirmPlainSale(rt, tenantA, [
          { quantity: 1, variantId: itemProduct.variantId },
        ])
      ).sale.id,
      tieHigherIdLast: await writeParts([
        { amount: "19.90", method: "pix" },
        { amount: "19.90", id: highestId, method: "bank_transfer" },
      ]),
      tieLowerIdLast: await writeParts([
        { amount: "19.90", method: "pix" },
        { amount: "19.90", id: lowestId, method: "debit_card" },
      ]),
    };
    const stored = await admin.pool.query<{ parts: string }>(
      "SELECT string_agg(payment.position || ':' || payment.method, ',' ORDER BY payment.position) AS parts FROM public.sale_payments AS payment JOIN public.sales AS sale ON sale.organization_id = payment.organization_id AND sale.id = payment.sale_id WHERE payment.sale_id = ANY($1::uuid[]) GROUP BY sale.id, sale.payment_count HAVING count(*) = sale.payment_count",
      [Object.values(partSales)]
    );
    assert.deepEqual(
      stored.rows.map((row) => row.parts).sort(),
      [
        "0:pix",
        "0:pix,1:bank_transfer",
        "0:pix,1:cash",
        "0:pix,1:credit_card",
        "0:pix,1:debit_card",
      ],
      "the parts are committed at their positions, as many as each header counts"
    );
    const seen = await withTenantAs(
      runtimeDatabase.db,
      tenantA,
      "sale:read",
      async (transaction, identity) => {
        const listed = await listSales(transaction, identity, { limit: 100 });
        const partIds = Object.values(partSales);
        assert.equal(
          listed.sales.filter((sale) => partIds.includes(sale.id)).length,
          partIds.length,
          "a sale of two parts is listed once"
        );
        const read: Record<
          string,
          { amount: string; detail: string | null; list: string | null }
        > = {};
        for (const [name, saleId] of Object.entries(partSales)) {
          // biome-ignore lint/performance/noAwaitInLoops: one transaction, one statement at a time
          const detail = await getSale(transaction, identity, saleId);
          read[name] = {
            amount: detail.sale.payment.amount,
            detail: detail.sale.payment.method,
            list:
              listed.sales.find((sale) => sale.id === saleId)?.paymentMethod ??
              null,
          };
        }
        return read;
      }
    );
    assert.deepEqual(
      seen,
      {
        biggestFirst: { amount: "14.90", detail: "pix", list: "pix" },
        biggestLast: {
          amount: "30.00",
          detail: "credit_card",
          list: "credit_card",
        },
        onlyPart: { amount: "19.90", detail: "pix", list: "pix" },
        tieHigherIdLast: { amount: "19.90", detail: "pix", list: "pix" },
        tieLowerIdLast: {
          amount: "19.90",
          detail: "debit_card",
          list: "debit_card",
        },
      },
      "the list and the detail name the main part: the biggest amount, the smaller id on a tie, at whatever position"
    );
    tests.push(
      "sale.list paymentMethod and sale.get payment.method name the same main part (biggest amount, smaller id on a tie) of a sale committed in two parts, the biggest at position 0 or 1"
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
