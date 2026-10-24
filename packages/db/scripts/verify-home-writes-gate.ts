import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createDatabase } from "../src/client";
import { readPeriodSummary } from "../src/economics-repository";
import {
  evaluateActiveGoals,
  listGoals,
  listPausedGoalIds,
  settleGoals,
} from "../src/goal-repository";
import { listInventoryBalances } from "../src/inventory-repository";
import { cancelSale } from "../src/sale-cancellation-repository";
import { listSales } from "../src/sale-query-repository";
import { withAuthorizedTenantTransaction } from "../src/tenant-transaction";
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
  type TenantFixture,
  temporaryRuntimeUrl,
  withTenantAs,
} from "./sales-gate-support";

/**
 * AC-23 of the Início (corte inicio.md, emended; desenho t269 v2, § 5.4) on a real PostgreSQL 18: opening the Início
 * writes nothing. Every read the page makes (§ 2.4: A and B of the period summary, the goals, the variants with no
 * stock and with no cost, and the checklist's sale, product and stock) is run as the handlers run them, each opening
 * on a connection of its own that is closed at the end, so the backend's statistics are flushed (`pg_stat_*` is
 * flushed when a backend exits). `pg_stat_user_tables` is compared before and after:
 *
 * - a store with no ended goal: no insert, update or delete in any table;
 * - a store with a goal whose period ended: only the settling `goal.list` already does when it reads (ADR 0055), the
 *   goal and its audit event, once; the second opening writes nothing.
 *
 * The same reads must have touched the tables (scans of `sales` went up): otherwise "nothing changed" would only say
 * that the statistics were not flushed yet.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

/** The settling of an ended goal: the goal itself and its audit event. Nothing else may change. */
const SETTLING_TABLES = new Set(["goals", "tenant_audit_event"]);

type Stats = Map<string, { scans: number; writes: number }>;

function dateFrom(day: string, days: number): string {
  const [year, month, date] = day.split("-").map(Number);
  const shifted = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, date ?? 1));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/** The month of `today` and the days before it the Início reads (home-model.ts `homePeriods`). */
function homePeriods(today: string) {
  const first = `${today.slice(0, 7)}-01`;
  const eve = dateFrom(first, -1);
  const previousFirst = `${eve.slice(0, 7)}-01`;
  const thirty = dateFrom(today, -29);
  const [year, month] = today.split("-").map(Number);
  const last = new Date(Date.UTC(year ?? 0, month ?? 1, 0))
    .toISOString()
    .slice(0, 10);
  return {
    before: { from: thirty < previousFirst ? thirty : previousFirst, to: eve },
    month: { from: first, to: last },
  };
}

async function run() {
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, gateBranchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);

  let admin = createDatabase(adminUrl, { maxConnections: 2 });
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
    const migrations = await admin.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations"
    );
    assert.equal(Number(migrations.rows[0]?.count), journalMigrationCount());
    tests.push(
      "disposable direct connection is PostgreSQL 18 with every migration replayed from scratch"
    );

    const today = (
      await admin.pool.query<{ today: string }>(
        "SELECT to_char((now() AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD') AS today"
      )
    ).rows[0]?.today as string;

    const stats = async (): Promise<Stats> => {
      const result = await admin.pool.query<{
        relname: string;
        scans: string;
        writes: string;
      }>(
        `SELECT relname,
                (n_tup_ins + n_tup_upd + n_tup_del)::text AS writes,
                (coalesce(seq_scan, 0) + coalesce(idx_scan, 0))::text AS scans
           FROM pg_stat_user_tables WHERE schemaname = 'public'`
      );
      return new Map(
        result.rows.map((row) => [
          row.relname,
          { scans: Number(row.scans), writes: Number(row.writes) },
        ])
      );
    };

    /** Polls the statistics until `ready` says the closed backend's ones arrived. */
    const statsWhen = async (ready: (now: Stats) => boolean) => {
      let now = await stats();
      for (let tries = 0; tries < 50 && !ready(now); tries += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: polling the statistics until the closed backend flushed them
        await new Promise((resolve) => setTimeout(resolve, 200));
        now = await stats();
      }
      return now;
    };
    const writesOf = (now: Stats, table: string) => now.get(table)?.writes ?? 0;
    const scansOf = (now: Stats, table: string) => now.get(table)?.scans ?? 0;

    // every table's counters before the fixtures: their writes must have arrived before the first measurement
    const baseline = await stats();

    loginRole = `polaris_home_gate_${randomUUID().replaceAll("-", "")}`;
    const loginPassword = randomBytes(24).toString("hex");
    await admin.pool.query(
      `CREATE ROLE "${loginRole}" WITH LOGIN INHERIT PASSWORD '${loginPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
    );
    await admin.pool.query(`GRANT "${runtimeRole}" TO "${loginRole}"`);
    const runtimeUrl = temporaryRuntimeUrl(adminUrl, loginRole, loginPassword);

    // ---------------------------------------------------------------- the data
    const tenant: TenantFixture = await createTenantFixture(
      admin.pool,
      "home writes"
    );
    const fixtures = createDatabase(runtimeUrl, { maxConnections: 2 });
    try {
      const rt = { adminPool: admin.pool, db: fixtures.db };
      const sold = await createSellableProduct(rt, tenant, "H-P1", {
        cost: "10.00",
        quantity: 20,
      });
      // a product with no stock and no cost: the two lines of "Precisa de atenção" have something to count
      await createSellableProduct(rt, tenant, "H-P2", {
        cost: null,
        quantity: 0,
      });
      await confirmPlainSale(rt, tenant, [
        { chargedUnitPrice: "50.00", quantity: 1, variantId: sold.variantId },
      ]);
      // a cancelled sale is still a sale: the checklist never comes back (AC-23)
      const cancelled = await confirmPlainSale(rt, tenant, [
        { chargedUnitPrice: "30.00", quantity: 1, variantId: sold.variantId },
      ]);
      await withTenantAs(fixtures.db, tenant, "sale:cancel", (tx, identity) =>
        cancelSale(tx, identity, {
          commandId: randomUUID(),
          commandVersion: 1,
          saleId: cancelled.sale.id,
        })
      );
      // a goal in progress that is far from its target: reading it settles nothing
      await admin.pool.query(
        "INSERT INTO public.goals (organization_id, kind, target, starts_on, ends_on) VALUES ($1, 'net_sales', 100000, $2, $3)",
        [tenant.organizationId, dateFrom(today, -3), dateFrom(today, 20)]
      );
    } finally {
      await fixtures.pool.end();
    }

    // the fixtures' own statistics must not land inside a measurement: their backends are closed, and the admin's too
    await admin.pool.end();
    admin = createDatabase(adminUrl, { maxConnections: 1 });
    await statsWhen(
      (now) =>
        writesOf(now, "goals") > writesOf(baseline, "goals") &&
        writesOf(now, "sales") >= writesOf(baseline, "sales") + 2
    );

    /** One opening of the Início: every read of § 2.4, on one connection, closed at the end (its stats flush). */
    const openHome = async () => {
      const database = createDatabase(runtimeUrl, { maxConnections: 1 });
      const as = <T>(
        capability: string,
        operation: Parameters<typeof withAuthorizedTenantTransaction<T>>[2],
        isolationLevel?: "repeatable read"
      ) =>
        withAuthorizedTenantTransaction(
          database.db,
          {
            authenticatedUserId: tenant.userId,
            capability,
            ...(isolationLevel ? { isolationLevel } : {}),
            requestedOrganizationId: tenant.organizationId,
          },
          operation
        );
      try {
        const { before, month } = homePeriods(today);
        const a = await as(
          "report:read",
          (tx, identity) =>
            readPeriodSummary(tx, identity, month, { topProducts: 3 }),
          "repeatable read"
        );
        await as(
          "report:read",
          (tx, identity) => readPeriodSummary(tx, identity, before),
          "repeatable read"
        );
        // goal.list as its handler runs it: evaluate in a snapshot, settle, list every status, the paused ones
        const progress = await as(
          "goal:manage",
          (tx, identity) => evaluateActiveGoals(tx, identity),
          "repeatable read"
        );
        await as("goal:manage", (tx, identity) =>
          settleGoals(
            tx,
            identity,
            progress.flatMap((entry) =>
              entry.settlement
                ? [
                    {
                      achievedValue: entry.evaluation.progress,
                      expectedVersion: entry.version,
                      goalId: entry.goalId,
                      settlement: entry.settlement,
                    },
                  ]
                : []
            )
          )
        );
        const goals = await as("goal:manage", (tx, identity) =>
          listGoals(tx, identity, { status: "all" })
        );
        await as("goal:manage", (tx, identity) =>
          listPausedGoalIds(tx, identity)
        );
        const withoutStock = await as("inventory:read", (tx, identity) =>
          listInventoryBalances(tx, identity, {
            limit: 100,
            stock: "without_stock",
          })
        );
        const unknownCost = await as("inventory:read", (tx, identity) =>
          listInventoryBalances(tx, identity, { cost: "unknown", limit: 100 })
        );
        // the checklist's reads, as if the period had no sale (they are made only then; here, to prove them too)
        const sold = await as(
          "sale:read",
          (tx, identity) => listSales(tx, identity, { limit: 1 }),
          "repeatable read"
        );
        await as("inventory:read", (tx, identity) =>
          listInventoryBalances(tx, identity, {
            includeArchived: true,
            limit: 1,
          })
        );
        await as("inventory:read", (tx, identity) =>
          listInventoryBalances(tx, identity, { limit: 1, stock: "with_stock" })
        );
        return { a, goals, sold, unknownCost, withoutStock };
      } finally {
        await database.pool.end();
      }
    };

    /** The tables whose rows changed between two readings, with how many writes. */
    const changed = (from: Stats, to: Stats) =>
      [...to].flatMap(([table, now]) => {
        const writes = now.writes - (from.get(table)?.writes ?? 0);
        return writes === 0 ? [] : [[table, writes] as const];
      });

    /** Measures one opening; waits until the reads themselves show in the statistics, so they were flushed. */
    const measure = async () => {
      const before = await stats();
      const read = await openHome();
      let after = await stats();
      for (
        let tries = 0;
        tries < 50 &&
        (after.get("sales")?.scans ?? 0) <= (before.get("sales")?.scans ?? 0);
        tries += 1
      ) {
        // biome-ignore lint/performance/noAwaitInLoops: polling the statistics until the closed backend flushed them
        await new Promise((resolve) => setTimeout(resolve, 200));
        after = await stats();
      }
      assert.ok(
        (after.get("sales")?.scans ?? 0) > (before.get("sales")?.scans ?? 0),
        "the reads of the opening show in pg_stat_user_tables (the statistics were flushed)"
      );
      return { read, writes: changed(before, after) };
    };

    // ------------------------------------------- 1. no ended goal: no writes
    const first = await measure();
    assert.equal(first.read.a.result.salesCount >= 1, true);
    assert.equal(first.read.sold.sales.length, 1);
    assert.ok(first.read.withoutStock.entries.length >= 1);
    assert.ok(first.read.unknownCost.entries.length >= 1);
    assert.deepEqual(
      first.writes,
      [],
      "opening the Início of a store with no ended goal writes nothing"
    );
    tests.push(
      "opening the Início (A and B with the ranking, goal.list, the stock lists and the checklist's reads) of a store with sales, a cancelled sale and a goal in progress inserts, updates and deletes nothing in any table (pg_stat_user_tables)"
    );

    // ---------------- 2. an ended goal: only its settling, and only once
    // inserted on a connection of its own, closed at once: its statistics arrive before the opening is measured
    const beforeInsert = await stats();
    const inserter = createDatabase(adminUrl, { maxConnections: 1 });
    let endedGoalId: string;
    try {
      endedGoalId = (
        await inserter.pool.query<{ id: string }>(
          "INSERT INTO public.goals (organization_id, kind, target, starts_on, ends_on) VALUES ($1, 'sale_count', 50, $2, $3) RETURNING id",
          [tenant.organizationId, dateFrom(today, -10), dateFrom(today, -1)]
        )
      ).rows[0]?.id as string;
    } finally {
      await inserter.pool.end();
    }
    const beforeSettle = await statsWhen(
      (now) => writesOf(now, "goals") > writesOf(beforeInsert, "goals")
    );
    await openHome();
    const afterSettle = await statsWhen(
      (now) => writesOf(now, "goals") > writesOf(beforeSettle, "goals")
    );
    const settling = changed(beforeSettle, afterSettle);
    assert.ok(
      settling.some(([table]) => table === "goals"),
      `the ended goal is settled by the opening (changed: ${JSON.stringify(settling)})`
    );
    assert.deepEqual(
      settling.filter(([table]) => !SETTLING_TABLES.has(table)),
      [],
      "the only writes of the opening are the settling of the goal and its audit event"
    );
    const status = await admin.pool.query<{ status: string }>(
      "SELECT status FROM public.goals WHERE id = $1",
      [endedGoalId]
    );
    assert.equal(status.rows[0]?.status, "missed");

    const beforeAgain = await stats();
    await openHome();
    const afterAgain = await statsWhen(
      (now) => scansOf(now, "sales") > scansOf(beforeAgain, "sales")
    );
    assert.deepEqual(
      changed(beforeAgain, afterAgain),
      [],
      "the second opening writes nothing: the goal settled once"
    );
    tests.push(
      "with a goal whose period ended, the opening writes only its settling (the goal and its audit event, the write goal.list already makes), and the next opening writes nothing"
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
    if (loginRole) {
      await admin.pool.query(`REVOKE "${runtimeRole}" FROM "${loginRole}"`);
      await admin.pool.query(`DROP ROLE IF EXISTS "${loginRole}"`);
    }
    await admin.pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    `Home writes PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
