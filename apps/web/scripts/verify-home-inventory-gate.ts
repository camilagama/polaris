// biome-ignore-all lint/performance/noAwaitInLoops: a gate runs its probes strictly one at a time, for a clear failure
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createDatabase } from "@polaris/db/client";
import {
  listInventoryBalances,
  writeOffStock,
} from "@polaris/db/inventory-repository";
import { archiveProduct, createProduct } from "@polaris/db/product-repository";
import {
  createSellableProduct,
  createTenantFixture,
  disposableHostPattern,
  gateBranchPattern,
  journalMigrationCount,
  poolerPattern,
  redactedFailure,
  requiredEnvironment,
  type TenantFixture,
  temporaryRuntimeUrl,
  withTenantAs,
} from "../../../packages/db/scripts/sales-gate-support";
import {
  checklistOf,
  firstProductId,
  hasStock,
  stockOf,
  type WideEntry,
  wholeCatalog,
} from "../src/home/home-inventory";

/**
 * The Início reads the stock in ONE list (every product status, 100 variants) and derives from it what four filtered
 * reads said before: the first product, "has stock", S (no stock) and C (no cost). On a real PostgreSQL 18, with the
 * repository the handler runs (`listInventoryBalances`), the derivation of `home/home-inventory.ts` must equal those
 * four reads, count and order included, in a catalog with an active and an archived product, a variant with no balance
 * row, one with a known cost and one without, with and without stock:
 *   1. the variant with no balance row arrives in the wide list with quantity 0 and no cost, and the filters count it
 *      (AC-3: otherwise the derivation would be a lie, and the cut goes back to its designer);
 *   2. the derived values equal the filtered reads in a full catalog, an empty one and one that has only variants
 *      with no stock beside an archived one with stock;
 *   3. wrong derivations (`>= 0`, archived ones counted, a cost of zero taken for no cost, the first active product in
 *      the place of the first) give another answer in these catalogs: the catalog tells them apart. What fails when
 *      `home-inventory.ts` itself is wrong are the equalities of 2.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";
const runtimeRole = "polaris_pr11_runtime";

type Rows = Awaited<ReturnType<typeof listInventoryBalances>>["entries"];

async function run() {
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, gateBranchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);

  const admin = createDatabase(adminUrl, { maxConnections: 2 });
  let loginRole: string | undefined;
  let notes = 0;
  try {
    const server = await admin.pool.query<{
      database_name: string;
      server_version_num: string;
    }>(
      "SELECT current_database() AS database_name, current_setting('server_version_num') AS server_version_num"
    );
    const [serverRow] = server.rows;
    assert.ok(serverRow);
    assert.equal(serverRow.database_name, expectedDatabase);
    assert.ok(Number(serverRow.server_version_num) >= 180_000);
    const migrations = await admin.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations"
    );
    assert.equal(Number(migrations.rows[0]?.count), journalMigrationCount());

    loginRole = `polaris_home_inv_${randomUUID().replaceAll("-", "")}`;
    const loginPassword = randomBytes(24).toString("hex");
    await admin.pool.query(
      `CREATE ROLE "${loginRole}" WITH LOGIN INHERIT PASSWORD '${loginPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
    );
    await admin.pool.query(`GRANT "${runtimeRole}" TO "${loginRole}"`);
    const database = createDatabase(
      temporaryRuntimeUrl(adminUrl, loginRole, loginPassword),
      { maxConnections: 2 }
    );

    try {
      const rt = { adminPool: admin.pool, db: database.db };
      const tenant = (label: string) =>
        createTenantFixture(admin.pool, `home inventory ${label}`);

      /** A product with its default variant and no stock movement at all: no balance row. */
      const withoutRow = async (
        owner: TenantFixture,
        name: string,
        archived = false
      ) => {
        const product = await withTenantAs(
          database.db,
          owner,
          "product:create",
          (tx, identity) =>
            createProduct(tx, identity, { name, requestId: randomUUID() })
        );
        if (archived) {
          await withTenantAs(
            database.db,
            owner,
            "product:update",
            (tx, identity) =>
              archiveProduct(tx, identity, {
                expectedVersion: product.version,
                id: product.id,
              })
          );
        }
        return product;
      };
      const archive = async (
        owner: TenantFixture,
        productId: string,
        version: number
      ) =>
        withTenantAs(database.db, owner, "product:update", (tx, identity) =>
          archiveProduct(tx, identity, {
            expectedVersion: version,
            id: productId,
          })
        );
      const named = async (
        owner: TenantFixture,
        name: string,
        stock: { cost: string | null; quantity: number }
      ) => {
        const made = await createSellableProduct(rt, owner, name, stock);
        await admin.pool.query(
          "UPDATE public.products SET name = $1 WHERE id = $2",
          [name, made.productId]
        );
        return made;
      };

      // ------------------------------------------------ the catalogs
      const full = await tenant("full");
      const archivedStocked = await named(full, "A arquivado com estoque", {
        cost: "4.00",
        quantity: 7,
      });
      await archive(full, archivedStocked.productId, archivedStocked.version);
      await named(full, "B com estoque e custo", {
        cost: "10.00",
        quantity: 5,
      });
      await named(full, "C com estoque sem custo", {
        cost: null,
        quantity: 3,
      });
      const emptied = await named(full, "D zerado com custo", {
        cost: "2.00",
        quantity: 5,
      });
      await withTenantAs(
        database.db,
        full,
        "inventory:adjust",
        (tx, identity) =>
          writeOffStock(tx, identity, {
            commandId: randomUUID(),
            commandVersion: 1,
            occurredOn: "2026-10-02",
            quantity: 5,
            reasonCode: "lost",
            variantId: emptied.variantId,
          })
      );
      await named(full, "E zerado sem custo", { cost: null, quantity: 0 });
      const noRow = await withoutRow(full, "F sem linha de saldo");
      await withoutRow(full, "G arquivado sem linha", true);
      await named(full, "H custo zero", { cost: "0.00", quantity: 2 });

      const empty = await tenant("empty");

      const zeros = await tenant("zeros");
      const zerosArchived = await named(zeros, "A arquivado com estoque", {
        cost: "4.00",
        quantity: 7,
      });
      await archive(zeros, zerosArchived.productId, zerosArchived.version);
      await named(zeros, "B zerado sem custo", { cost: null, quantity: 0 });
      await withoutRow(zeros, "C sem linha de saldo");

      // ----------------------------- what the page read before: four filtered reads, and the wide one
      const read = (
        owner: TenantFixture,
        options: Parameters<typeof listInventoryBalances>[2]
      ) =>
        withTenantAs(database.db, owner, "inventory:read", (tx, identity) =>
          listInventoryBalances(tx, identity, options)
        );
      const before = async (owner: TenantFixture) => {
        const [product] = (
          await read(owner, { includeArchived: true, limit: 1 })
        ).entries;
        const stocked = await read(owner, { limit: 1, stock: "with_stock" });
        const withoutStock = await read(owner, {
          limit: 100,
          stock: "without_stock",
        });
        const unknownCost = await read(owner, { cost: "unknown", limit: 100 });
        return {
          checklist: {
            firstProductId: product?.productId ?? null,
            hasStock: stocked.entries.length > 0,
          },
          stock: {
            unknownCost: {
              count: unknownCost.entries.length,
              more: unknownCost.nextCursor !== null,
            },
            withoutStock: {
              count: withoutStock.entries.length,
              more: withoutStock.nextCursor !== null,
            },
          },
        };
      };
      const wide = async (owner: TenantFixture): Promise<Rows> => {
        const list = await read(owner, { includeArchived: true, limit: 100 });
        const whole = wholeCatalog(list);
        assert.ok(whole, "the catalog of the gate fits in the wide list");
        return list.entries;
      };

      // 1. AC-3: the variant with no balance row
      const fullWide = await wide(full);
      const missing = fullWide.find((entry) => entry.productId === noRow.id);
      assert.ok(missing, "the variant with no balance row is in the list");
      assert.equal(missing.quantity, 0);
      assert.equal(missing.movingAverageCost, null);
      assert.equal(missing.productStatus, "active");
      const noBalance = await admin.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM public.inventory_balances WHERE variant_id = $1",
        [missing.variantId]
      );
      assert.equal(
        Number(noBalance.rows[0]?.count),
        0,
        "the variant of the case has no balance row at all"
      );
      const filteredWithout = await read(full, {
        limit: 100,
        stock: "without_stock",
      });
      const filteredUnknown = await read(full, { cost: "unknown", limit: 100 });
      assert.ok(
        filteredWithout.entries.some((entry) => entry.productId === noRow.id)
      );
      assert.ok(
        filteredUnknown.entries.some((entry) => entry.productId === noRow.id)
      );
      notes += 1;

      // 2. the derivation equals the four filtered reads
      const derive = (entries: Rows) => ({
        checklist: checklistOf(entries),
        stock: stockOf(entries, true),
      });
      const expectedFull = await before(full);
      assert.deepEqual(derive(fullWide), expectedFull);
      assert.equal(
        expectedFull.checklist.firstProductId,
        archivedStocked.productId,
        "the first product is the archived one: the order of the list, not the first active"
      );
      assert.equal(expectedFull.checklist.hasStock, true);
      notes += 1;

      const emptyWide = await wide(empty);
      assert.deepEqual(derive(emptyWide), await before(empty));
      assert.deepEqual(await before(empty), {
        checklist: { firstProductId: null, hasStock: false },
        stock: {
          unknownCost: { count: 0, more: false },
          withoutStock: { count: 0, more: false },
        },
      });
      notes += 1;

      const zerosWide = await wide(zeros);
      const expectedZeros = await before(zeros);
      assert.deepEqual(derive(zerosWide), expectedZeros);
      assert.equal(
        expectedZeros.checklist.hasStock,
        false,
        "an archived product's stock is not the store's stock"
      );
      assert.equal(expectedZeros.stock.withoutStock.count, 2);
      notes += 1;

      // 3. mutants of the derivation that these catalogs tell apart
      const active = (entry: WideEntry) => entry.productStatus === "active";
      const mutants: Array<{
        differs: () => boolean;
        name: string;
      }> = [
        {
          differs: () =>
            zerosWide.some((entry) => active(entry) && entry.quantity >= 0) !==
            expectedZeros.checklist.hasStock,
          name: ">= 0 for 'has stock'",
        },
        {
          differs: () =>
            hasStock(
              zerosWide.map((entry) => ({ ...entry, productStatus: "active" }))
            ) !== expectedZeros.checklist.hasStock,
          name: "archived products counted in 'has stock'",
        },
        {
          differs: () =>
            fullWide.filter((entry) => entry.quantity === 0).length !==
            expectedFull.stock.withoutStock.count,
          name: "archived products counted in S",
        },
        {
          differs: () =>
            fullWide.filter((entry) => entry.movingAverageCost === null)
              .length !== expectedFull.stock.unknownCost.count,
          name: "archived products counted in C",
        },
        {
          differs: () =>
            fullWide.filter(
              (entry) =>
                active(entry) &&
                !Number.parseFloat(entry.movingAverageCost ?? "")
            ).length !== expectedFull.stock.unknownCost.count,
          name: "a cost of zero taken for no cost",
        },
        {
          differs: () =>
            fullWide.find(active)?.productId !== firstProductId(fullWide),
          name: "the first active product in the place of the first",
        },
      ];
      for (const mutant of mutants) {
        assert.ok(
          mutant.differs(),
          `the seeded catalog tells the mutant apart: ${mutant.name}`
        );
      }
      notes += 1;

      assert.equal(notes, 5, "every check of the gate ran");
      console.log(
        `gate-note: ${notes} cases passed (the variant with no balance row reads quantity 0 and no cost; the derivation equals the four filtered reads in a full, an empty and a stockless catalog; the seeded catalog tells ${mutants.length} wrong derivations apart)`
      );
      console.log(
        JSON.stringify(
          { branch, database: serverRow.database_name, status: "passed" },
          null,
          2
        )
      );
    } finally {
      await database.pool.end();
    }
  } finally {
    if (loginRole) {
      await admin.pool.query(`DROP ROLE IF EXISTS "${loginRole}"`);
    }
    await admin.pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    `Home inventory PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
