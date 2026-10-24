import { randomBytes, randomUUID } from "node:crypto";
import {
  dailySales,
  topProducts,
} from "@polaris/domain/economics/period-series";
import {
  dashboardCards,
  resultQuality,
} from "@polaris/domain/economics/period-summary";
import {
  periodResult,
  saleEconomics,
} from "@polaris/domain/economics/sale-economics";
import { createDatabase } from "../src/client";
import {
  type EconomicsPeriod,
  readPeriodFacts,
  readPeriodSummary,
} from "../src/economics-repository";
import { evaluateActiveGoals } from "../src/goal-repository";
import { withAuthorizedTenantTransaction } from "../src/tenant-transaction";
import { assertAllowedGateUrl } from "./gate-hosts";
import { assertDisposableEnvironment, type MarkerClient } from "./gate-target";
import {
  runtimeRole,
  type TenantFixture,
  temporaryRuntimeUrl,
  withRuntimeSqlContext,
} from "./sales-gate-support";
import { seedQaStore } from "./seed-qa-store";

/**
 * The local measure of the Início's reads (t277, items 1 and 2 of the
 * desenho-t269 round), on the PostgreSQL 18 of the gates (`CI=true`, local
 * host only). For each store it seeds (`MEASURE_STORES`, sales per day, 60
 * days each) it prints:
 * - the rows read and an estimate of the bytes the database sends for A (the
 *   current month, with the ranking) and B (the window before it), computed
 *   in SQL as the text-protocol `DataRow` size of the same columns;
 * - the wall time of `readPeriodSummary` and the CPU time of the engine alone
 *   (series and ranking included) over the facts already read;
 * - the time of `evaluateActiveGoals` with an annual goal;
 * - `EXPLAIN (ANALYZE, BUFFERS)` of the period's sales query, as the runtime
 *   role under RLS.
 *
 * The CPU of the Worker is NOT this: Bun on this machine is not workerd on
 * Cloudflare. The staging measure (in the PR) is the one that counts.
 *
 * It writes into the database it is given and cleans only its login role: the
 * stores `qa-medida-*` stay. Run it on the disposable database of the gates
 * (recreated by the gate runner), never on one you keep.
 *
 *   CI=true POLARIS_GATE_DATABASE_URL=postgresql://…@localhost:5432/polaris_gate \
 *   MEASURE_STORES=20,50,330 bun scripts/measure-period-summary.ts
 */

const DAYS = 60;

function addDays(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function lastDayOfMonth(date: string): string {
  const [year, month] = date.split("-").map(Number);
  return new Date(Date.UTC(year ?? 0, month ?? 1, 0))
    .toISOString()
    .slice(0, 10);
}

/** A and B of the design (2.4): the current month, and min(1st of last month, today − 29) up to the day before the 1st. */
function homePeriods(today: string): {
  a: EconomicsPeriod;
  b: EconomicsPeriod;
} {
  const first = `${today.slice(0, 7)}-01`;
  const lastMonthFirst = `${addDays(first, -1).slice(0, 7)}-01`;
  const minusTwentyNine = addDays(today, -29);
  return {
    a: { from: first, to: lastDayOfMonth(today) },
    b: {
      from: lastMonthFirst < minusTwentyNine ? lastMonthFirst : minusTwentyNine,
      to: addDays(first, -1),
    },
  };
}

const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

/** The text-protocol size of what the eight reads of a period send: 7 bytes per row plus 4 per field and the value's text. */
const WIRE_BYTES_SQL = `
WITH s AS (
  SELECT id, occurred_on FROM public.sales
   WHERE organization_id = $1 AND occurred_on BETWEEN $2::date AND $3::date
), parts AS (
  SELECT 'sales' AS part, count(*) AS rows_read, COALESCE(sum(7 + 8 + octet_length(id::text) + octet_length(occurred_on::text)), 0) AS bytes FROM s
  UNION ALL
  SELECT 'items', count(*), COALESCE(sum(7 + 24 + octet_length(i.charged_unit_price::text) + octet_length(i.position::text) + octet_length(i.product_id::text) + octet_length(i.quantity::text) + octet_length(i.sale_id::text) + COALESCE(octet_length(i.unit_cost::text), 0)), 0)
    FROM public.sale_items i JOIN s ON s.id = i.sale_id WHERE i.organization_id = $1
  UNION ALL
  SELECT 'adjustments', count(*), COALESCE(sum(7 + 12 + octet_length(a.amount::text) + octet_length(a.kind) + octet_length(a.sale_id::text)), 0)
    FROM public.sale_adjustments a JOIN s ON s.id = a.sale_id WHERE a.organization_id = $1
  UNION ALL
  SELECT 'payments', count(*), COALESCE(sum(7 + 12 + COALESCE(octet_length(p.anticipation_fee_amount_snapshot::text), 0) + COALESCE(octet_length(p.processing_fee_amount_snapshot::text), 0) + octet_length(p.sale_id::text)), 0)
    FROM public.sale_payments p JOIN s ON s.id = p.sale_id WHERE p.organization_id = $1
  UNION ALL
  SELECT 'returnLines', count(*), COALESCE(sum(7 + 16 + octet_length(r.item_position::text) + octet_length(r.restocked_quantity::text) + octet_length(r.returned_quantity::text) + octet_length(r.sale_id::text)), 0)
    FROM public.sale_return_items r JOIN s ON s.id = r.sale_id WHERE r.organization_id = $1
  UNION ALL
  SELECT 'cancellations', count(*), COALESCE(sum(7 + 4 + octet_length(c.sale_id::text)), 0)
    FROM public.sale_cancellations c JOIN s ON s.id = c.sale_id WHERE c.organization_id = $1
)
SELECT part, rows_read::int AS rows_read, bytes::int AS bytes FROM parts`;

async function measureStore(
  admin: ReturnType<typeof createDatabase>,
  db: ReturnType<typeof createDatabase>["db"],
  runtimeUrl: string,
  salesPerDay: number
) {
  const fixture: TenantFixture = {
    organizationId: randomUUID(),
    userId: randomUUID(),
  };
  await admin.pool.query(
    'INSERT INTO public."user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)',
    [fixture.userId, "qa medida", `qa-medida-${fixture.userId}@example.invalid`]
  );
  await admin.pool.query(
    "INSERT INTO public.organizations (id, name, timezone) VALUES ($1, $2, 'America/Sao_Paulo')",
    [fixture.organizationId, `qa-medida-${salesPerDay}`]
  );
  await admin.pool.query(
    "INSERT INTO public.memberships (organization_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')",
    [fixture.organizationId, fixture.userId]
  );
  await admin.pool.query(
    "INSERT INTO public.organization_billing (organization_id, state, access_ends_at) VALUES ($1, 'active', now() + interval '365 days')",
    [fixture.organizationId]
  );
  const seedStarted = Date.now();
  const seeded = await seedQaStore(db, admin.pool, {
    days: DAYS,
    goals: true,
    organizationId: fixture.organizationId,
    salesPerDay,
    userId: fixture.userId,
    variantsWithoutStock: 120,
  });
  const seedSeconds = Math.round((Date.now() - seedStarted) / 1000);
  await admin.pool.query("ANALYZE");

  const asReport = <T>(
    operation: Parameters<typeof withAuthorizedTenantTransaction<T>>[2],
    capability = "report:read"
  ) =>
    withAuthorizedTenantTransaction(
      db,
      {
        authenticatedUserId: fixture.userId,
        capability,
        isolationLevel: "repeatable read",
        requestedOrganizationId: fixture.organizationId,
      },
      operation
    );
  const today = (
    await admin.pool.query<{ today: string }>(
      "SELECT to_char((now() AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD') AS today"
    )
  ).rows[0]?.today as string;
  const periods = homePeriods(today);
  const reads: Record<string, unknown> = {};
  for (const [label, period] of Object.entries(periods)) {
    const limit = label === "a" ? 3 : undefined;
    const wall: number[] = [];
    let summary: Awaited<ReturnType<typeof readPeriodSummary>> | undefined;
    for (let run = 0; run < 5; run += 1) {
      const started = performance.now();
      // biome-ignore lint/performance/noAwaitInLoops: runs are timed one after the other
      summary = await asReport((tx, identity) =>
        readPeriodSummary(tx, identity, period, { topProducts: limit })
      );
      wall.push(performance.now() - started);
    }
    const facts = await asReport((tx, identity) =>
      readPeriodFacts(tx, identity, period)
    );
    const cpu: number[] = [];
    for (let run = 0; run < 20; run += 1) {
      const before = process.cpuUsage();
      const economics = facts.sales.map(saleEconomics);
      const result = periodResult(
        facts.sales,
        facts.operatingExpenses,
        economics
      );
      dashboardCards(result);
      resultQuality(result);
      dailySales(facts.sales, period.from, period.to, economics);
      if (limit) {
        topProducts(facts.sales, limit);
      }
      const used = process.cpuUsage(before);
      cpu.push((used.user + used.system) / 1000);
    }
    const wire = await admin.pool.query<{
      bytes: number;
      part: string;
      rows_read: number;
    }>(WIRE_BYTES_SQL, [fixture.organizationId, period.from, period.to]);
    const output = summary
      ? {
          cards: dashboardCards(summary.result),
          daily: summary.daily,
          quality: resultQuality(summary.result),
          topProducts: summary.topProducts,
        }
      : null;
    reads[label] = {
      engineCpuMsMedian: Number(median(cpu).toFixed(2)),
      period,
      reads: summary?.reads,
      readWallMsMedian: Number(median(wall).toFixed(1)),
      responseBytesApprox: Buffer.byteLength(JSON.stringify(output)) + 900,
      wireBytes: Object.fromEntries(
        wire.rows.map((row) => [row.part, row.bytes])
      ),
      wireBytesTotal: wire.rows.reduce((total, row) => total + row.bytes, 0),
    };
  }

  const goalWall: number[] = [];
  let goalReads = { periods: 0, sales: 0 };
  for (let run = 0; run < 3; run += 1) {
    const tally = { periods: 0, sales: 0 };
    const started = performance.now();
    // biome-ignore lint/performance/noAwaitInLoops: runs are timed one after the other
    await asReport(
      (tx, identity) =>
        evaluateActiveGoals(tx, identity, (counts) => {
          tally.periods += 1;
          tally.sales += counts.sales;
        }),
      "goal:manage"
    );
    goalWall.push(performance.now() - started);
    goalReads = tally;
  }

  const explain = await withRuntimeSqlContext(runtimeUrl, fixture, (client) =>
    client.query<{ "QUERY PLAN": string }>(
      `EXPLAIN (ANALYZE, BUFFERS) SELECT id, occurred_on FROM public.sales
        WHERE organization_id = $1 AND occurred_on >= $2::date AND occurred_on <= $3::date
        ORDER BY occurred_on, id`,
      [fixture.organizationId, periods.a.from, periods.a.to]
    )
  );
  const storeSales = (
    await admin.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM public.sales WHERE organization_id = $1",
      [fixture.organizationId]
    )
  ).rows[0]?.count;
  return {
    explainA: explain.rows.map((row) => row["QUERY PLAN"]),
    goals: {
      reads: goalReads,
      wallMsMedian: Number(median(goalWall).toFixed(1)),
    },
    reads,
    salesPerDay,
    seeded,
    seedSeconds,
    storeSales,
    today,
  };
}

/**
 * The plan of the period's sales query in a store with a long history:
 * `count` sale headers spread over the last 365 days (only the headers: the
 * query reads nothing else), next to another store of the same size. The
 * criterion (design 2.5): if the plan reads more than twice the rows of the
 * period, the index `sales (organization_id, occurred_on, id)` is due (1b).
 */
async function explainLongHistory(
  admin: ReturnType<typeof createDatabase>,
  runtimeUrl: string,
  count: number
) {
  const stores: TenantFixture[] = [];
  for (const label of ["explain", "vizinha"]) {
    const fixture = { organizationId: randomUUID(), userId: randomUUID() };
    // biome-ignore lint/performance/noAwaitInLoops: two stores, one after the other
    await admin.pool.query(
      'INSERT INTO public."user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)',
      [
        fixture.userId,
        "qa medida",
        `qa-${label}-${fixture.userId}@example.invalid`,
      ]
    );
    await admin.pool.query(
      "INSERT INTO public.organizations (id, name, timezone) VALUES ($1, $2, 'America/Sao_Paulo')",
      [fixture.organizationId, `qa-medida-${label}`]
    );
    await admin.pool.query(
      "INSERT INTO public.memberships (organization_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')",
      [fixture.organizationId, fixture.userId]
    );
    // only the headers, so the triggers that check a confirmed sale against its
    // items are skipped for this insert (a superuser of the local database only)
    const client = await admin.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `INSERT INTO public.sales (organization_id, command_id, occurred_at, occurred_on, item_count, adjustment_count)
         SELECT $1, gen_random_uuid(), x.at, (x.at AT TIME ZONE 'America/Sao_Paulo')::date, 1, 0
           FROM (SELECT now() - (g * interval '365 days' / $2::int) AS at FROM generate_series(1, $2::int) AS g) AS x`,
        [fixture.organizationId, count]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    stores.push(fixture);
  }
  await admin.pool.query("ANALYZE public.sales");
  const [store] = stores as [TenantFixture];
  const today = (
    await admin.pool.query<{ today: string }>(
      "SELECT to_char((now() AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD') AS today"
    )
  ).rows[0]?.today as string;
  const periods = homePeriods(today);
  const plans: Record<string, unknown> = {};
  for (const [label, period] of Object.entries(periods)) {
    // biome-ignore lint/performance/noAwaitInLoops: one plan at a time
    const inPeriod = await admin.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM public.sales WHERE organization_id = $1 AND occurred_on BETWEEN $2::date AND $3::date",
      [store.organizationId, period.from, period.to]
    );
    const plan = await withRuntimeSqlContext(runtimeUrl, store, (client) =>
      client.query<{ "QUERY PLAN": string }>(
        `EXPLAIN (ANALYZE, BUFFERS) SELECT id, occurred_on FROM public.sales
          WHERE organization_id = $1 AND occurred_on >= $2::date AND occurred_on <= $3::date
          ORDER BY occurred_on, id`,
        [store.organizationId, period.from, period.to]
      )
    );
    plans[label] = {
      period,
      plan: plan.rows.map((row) => row["QUERY PLAN"]),
      rowsInPeriod: inPeriod.rows[0]?.count,
    };
  }
  return { plans, salesPerStore: count };
}

async function main() {
  const adminUrl = process.env.POLARIS_GATE_DATABASE_URL ?? "";
  const parsed = assertAllowedGateUrl(adminUrl);
  if (!["localhost", "127.0.0.1"].includes(parsed.hostname)) {
    throw new Error("the measure runs on the local PostgreSQL only");
  }
  const admin = createDatabase(adminUrl, { maxConnections: 2 });
  // the host list says nothing about the database behind it: a marked one is refused before any write
  await assertDisposableEnvironment(admin.pool as unknown as MarkerClient);
  const loginRole = `polaris_measure_${randomUUID().replaceAll("-", "")}`;
  const password = randomBytes(24).toString("hex");
  let runtime: ReturnType<typeof createDatabase> | undefined;
  let roleCreated = false;
  try {
    await admin.pool.query(
      `CREATE ROLE "${loginRole}" WITH LOGIN INHERIT PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
    );
    roleCreated = true;
    await admin.pool.query(`GRANT "${runtimeRole}" TO "${loginRole}"`);
    const runtimeUrl = temporaryRuntimeUrl(adminUrl, loginRole, password);
    runtime = createDatabase(runtimeUrl, { maxConnections: 2 });
    const stores = (process.env.MEASURE_STORES ?? "20,50")
      .split(",")
      .filter((entry) => entry.trim() !== "")
      .map(Number);
    const results: unknown[] = [];
    for (const salesPerDay of stores) {
      // one store at a time keeps the timings apart
      // biome-ignore lint/performance/noAwaitInLoops: sequential on purpose
      const measured = await measureStore(
        admin,
        runtime.db,
        runtimeUrl,
        salesPerDay
      );
      results.push(measured);
      // printed as it comes: a later failure does not lose a long seed
      console.error(JSON.stringify(measured));
    }
    const explainSales = Number(process.env.MEASURE_EXPLAIN_SALES ?? 20_000);
    const explain =
      explainSales > 0
        ? await explainLongHistory(admin, runtimeUrl, explainSales)
        : null;
    console.log(JSON.stringify({ explain, stores: results }, null, 2));
  } finally {
    await runtime?.pool.end();
    if (roleCreated) {
      await admin.pool.query(`REVOKE "${runtimeRole}" FROM "${loginRole}"`);
      await admin.pool.query(`DROP ROLE IF EXISTS "${loginRole}"`);
    }
    await admin.pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "measure failed");
  process.exitCode = 1;
});
