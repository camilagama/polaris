import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { createDatabase } from "../src/client";
import {
  type OwnerPlanTenantFacts,
  readOwnerPlanTenantFacts,
} from "../src/plan-read-repository";
import { withAuthorizedTenantTransaction } from "../src/tenant-transaction";
import { assertAllowedGateUrl, localCiHosts } from "./gate-hosts";
import { assertDisposableEnvironment, type MarkerClient } from "./gate-target";
import {
  runtimeRole,
  type TenantFixture,
  temporaryRuntimeUrl,
  withRuntimeSqlContext,
} from "./sales-gate-support";
import { markQaStoreInternal, type QueryClient } from "./seed-qa-store";

/**
 * The local measure of the owner's plan read (`billing/readPlan`, its tenant part `readOwnerPlanTenantFacts`), on a
 * disposable PostgreSQL 18 of this machine (`CI=true`, local host only, a database with no environment marker). It
 * seeds two synthetic `qa-` stores, one of the size of the long-history QA store (products, variants and sales as
 * below) and one ten times larger, then for each store runs the read `MEASURE_RUNS` times (at least 30) after
 * `MEASURE_WARMUP` discarded runs, and prints p50, p95 and the maximum in ms:
 * - of the whole call (the tenant transaction: authorization, the read, the commit) and of the read alone;
 * - of each group of queries of the read, as the client sees each round trip: the catalogs (prices, plan catalog,
 *   effective entitlements), the four usage counts, the count and first day of the sales, and the rest (clock,
 *   time zone, products kept);
 * - of each query of the read, and `EXPLAIN (ANALYZE, BUFFERS)` of the three slowest by p50, as the runtime role
 *   under RLS with the values of the last run.
 *
 * It only reports: no number here passes or fails anything. It does not measure the CPU of the Worker (workerd is
 * not Bun, and the wait for the database is not CPU there), the network to Neon, Hyperdrive, nor the billing role's
 * read of the billing record that `readPlan` makes after the tenant transaction.
 *
 * The rows are written with SQL as the database owner, with `session_replication_role = replica` (the triggers that
 * ask a confirmed sale for its items and the ledger for its movements are skipped): the read counts rows and never
 * looks at items, payments or movements, so only the rows it counts are written. That is a fixture of a disposable
 * database, never something to do with real data. The stores stay; the login role of the run is dropped.
 *
 * After the seed it runs `VACUUM (ANALYZE)`, the state autovacuum leaves a table in: without it the visibility map is
 * empty and every index-only count fetches each heap row, which a store whose rows are older than the last vacuum
 * does not. The plans are timed per node, so their times run above the round trips; the timings to read are the
 * percentiles.
 *
 *   CI=true POLARIS_MEASURE_DATABASE_URL=postgresql://…@localhost:5432/polaris_gate \
 *   bun scripts/measure-plan-read.ts
 */

const BASE_STORE = { products: 1279, sales: 4109, variants: 1280 };
const LARGER_FACTOR = 10;
const MIN_RUNS = 30;
const HISTORY_DAYS = 366;
/** At least one discarded run, so the first measured one does not carry the opening of the connection. */
const DEFAULT_WARMUP = 5;
const SEEDED_TABLES = [
  "public.products",
  "public.product_variants",
  "public.inventory_balances",
  "public.sales",
  "public.goals",
  "public.media_assets",
  "public.product_media",
];

/** Refuses anything but the local PostgreSQL (and a URL that names it but connects elsewhere). Never connects. */
export function assertLocalMeasureUrl(raw: string | undefined, ci: boolean) {
  if (!raw) {
    throw new Error("POLARIS_MEASURE_DATABASE_URL is required");
  }
  const parsed = assertAllowedGateUrl(raw, ci);
  if (!localCiHosts.includes(parsed.hostname)) {
    throw new Error("the measure runs on the local PostgreSQL only");
  }
  return parsed;
}

export function runsOf(raw: string | undefined): number {
  const runs = Number(raw ?? MIN_RUNS);
  if (!Number.isInteger(runs) || runs < MIN_RUNS) {
    throw new Error(
      `MEASURE_RUNS must be a whole number of at least ${MIN_RUNS}`
    );
  }
  return runs;
}

export function warmupOf(raw: string | undefined): number {
  const warmup = Number(raw ?? DEFAULT_WARMUP);
  if (!Number.isInteger(warmup) || warmup < 1) {
    throw new Error("MEASURE_WARMUP must be a whole number of at least 1");
  }
  return warmup;
}

/** Nearest rank: the smallest value with at least `fraction` of the values at or below it. */
export function percentile(values: readonly number[], fraction: number) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1] ?? 0;
}

const round = (value: number) => Number(value.toFixed(2));

function summary(values: readonly number[]) {
  return {
    maxMs: round(Math.max(...values)),
    p50Ms: round(percentile(values, 0.5)),
    p95Ms: round(percentile(values, 0.95)),
  };
}

interface TimedQuery {
  ms: number;
  text: string;
  values: unknown[];
}

const GROUPS = ["catalogs", "usageCounts", "salesCount", "rest"] as const;
type Group = (typeof GROUPS)[number];

const FIRST_USAGE_COUNT = /count\(distinct "products"\."id"\)/i;
const SALES_COUNT = /min\((?:"sales"\.)?"occurred_on"\)/i;
const USAGE_COUNTS = 4;

/**
 * The queries of one read, in order, by group. The read runs its queries one after the other: what comes before the
 * first usage count (the freeable archived products) is the catalogs', the next four are the usage counts, then the
 * sales, then the rest. A read whose shape changed is refused, so the groups never silently mean something else.
 */
export function groupQueries(queries: readonly { text: string }[]): Group[] {
  const firstCount = queries.findIndex((query) =>
    FIRST_USAGE_COUNT.test(query.text)
  );
  const sales = queries.findIndex((query) => SALES_COUNT.test(query.text));
  if (firstCount < 1 || sales !== firstCount + USAGE_COUNTS) {
    throw new Error(
      "the plan read changed its queries: update the groups of measure-plan-read.ts"
    );
  }
  return queries.map((_, index) => {
    if (index < firstCount) {
      return "catalogs";
    }
    if (index < sales) {
      return "usageCounts";
    }
    return index === sales ? "salesCount" : "rest";
  });
}

/** Times every round trip of the pool's clients while a recording is open. */
function recordQueries(pool: pg.Pool) {
  let recording: TimedQuery[] | null = null;
  pool.on("connect", (client) => {
    const original = client.query.bind(client) as (
      ...args: unknown[]
    ) => unknown;
    (client as unknown as { query: unknown }).query = (...args: unknown[]) => {
      const [first, second] = args;
      const text =
        typeof first === "string"
          ? first
          : String((first as { text?: string }).text ?? "");
      const values = (
        Array.isArray(second)
          ? second
          : ((first as { values?: unknown[] }).values ?? [])
      ) as unknown[];
      const target = recording;
      const started = performance.now();
      const result = original(...args);
      if (target && result instanceof Promise) {
        return result.then((value: unknown) => {
          target.push({ ms: performance.now() - started, text, values });
          return value;
        });
      }
      return result;
    };
  });
  return {
    start() {
      recording = [];
    },
    stop(): TimedQuery[] {
      const done = recording ?? [];
      recording = null;
      return done;
    },
  };
}

interface StoreSize {
  products: number;
  sales: number;
  variants: number;
}

/** Writes one synthetic store: the rows the read counts, spread as a store with a year of history would have them. */
async function seedStore(admin: pg.Pool, label: string, size: StoreSize) {
  const fixture: TenantFixture = {
    organizationId: randomUUID(),
    userId: randomUUID(),
  };
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      'INSERT INTO public."user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)',
      [
        fixture.userId,
        "qa medida",
        `qa-medida-plano-${fixture.userId}@example.invalid`,
      ]
    );
    await client.query(
      "INSERT INTO public.organizations (id, name, timezone) VALUES ($1, $2, 'America/Sao_Paulo')",
      [fixture.organizationId, `qa-medida-plano-${label}`]
    );
    await client.query(
      "INSERT INTO public.memberships (organization_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')",
      [fixture.organizationId, fixture.userId]
    );
    await client.query(
      "INSERT INTO public.organization_billing (organization_id, state) VALUES ($1, 'free')",
      [fixture.organizationId]
    );
    await markQaStoreInternal(
      client as unknown as QueryClient,
      fixture.organizationId
    );
    await client.query("SET LOCAL session_replication_role = replica");
    // 1 in 30 archived (half of those with no stock, so deleting them frees room), 1 in 100 deleted
    await client.query(
      `INSERT INTO public.products (organization_id, name, archived_at, deleted_at)
       SELECT $1, 'Produto ' || g,
              CASE WHEN g % 30 = 0 OR g % 100 = 0 THEN now() - interval '40 days' END,
              CASE WHEN g % 100 = 0 THEN now() - interval '20 days' END
         FROM generate_series(1, $2::int) AS g`,
      [fixture.organizationId, size.products]
    );
    await client.query(
      `INSERT INTO public.product_variants (organization_id, product_id, is_default)
       SELECT organization_id, id, true FROM public.products WHERE organization_id = $1`,
      [fixture.organizationId]
    );
    await client.query(
      `INSERT INTO public.product_variants (organization_id, product_id, is_default, position, sku)
       SELECT p.organization_id, p.id, false, 1, 'EXTRA-' || row_number() OVER (ORDER BY p.id)
         FROM public.products p WHERE p.organization_id = $1 AND p.deleted_at IS NULL AND p.archived_at IS NULL
        ORDER BY p.id LIMIT $2::int`,
      [fixture.organizationId, Math.max(0, size.variants - size.products)]
    );
    await client.query(
      `INSERT INTO public.inventory_balances (organization_id, product_id, variant_id, quantity, moving_average_cost)
       SELECT v.organization_id, v.product_id, v.id,
              CASE WHEN p.archived_at IS NOT NULL AND hashtext(p.id::text) % 2 = 0 THEN 0 ELSE 1 + abs(hashtext(v.id::text)) % 20 END,
              10.00
         FROM public.product_variants v JOIN public.products p ON p.id = v.product_id
        WHERE v.organization_id = $1`,
      [fixture.organizationId]
    );
    await client.query(
      `INSERT INTO public.sales (organization_id, command_id, occurred_at, occurred_on, item_count, adjustment_count)
       SELECT $1, gen_random_uuid(), x.at, (x.at AT TIME ZONE 'America/Sao_Paulo')::date, 1, 0
         FROM (SELECT now() - (g * interval '1 day' * $3::int / $2::int) AS at
                 FROM generate_series(1, $2::int) AS g) AS x`,
      [fixture.organizationId, size.sales, HISTORY_DAYS - 1]
    );
    await client.query(
      `INSERT INTO public.goals (organization_id, kind, target, starts_on, ends_on, status)
       SELECT $1, 'net_sales', 1000 * g, current_date - 30 * g, current_date + 30,
              CASE WHEN g <= 3 THEN 'active' ELSE 'cancelled' END
         FROM generate_series(1, 5) AS g`,
      [fixture.organizationId]
    );
    // one image per product on 1 in 7 of the products kept
    await client.query(
      `WITH chosen AS (
         SELECT id AS product_id, gen_random_uuid() AS asset_id, gen_random_uuid() AS command_id,
                encode(sha256(id::text::bytea), 'hex') AS fingerprint
           FROM public.products WHERE organization_id = $1 AND deleted_at IS NULL AND abs(hashtext(id::text)) % 7 = 0
       ), assets AS (
         INSERT INTO public.media_assets (id, organization_id, byte_size, content_type, input_fingerprint, storage_key, upload_command_id, width, height)
         SELECT asset_id, $1, 40000, 'image/webp', fingerprint,
                'media/v2/' || $1 || '/' || gen_random_uuid() || '/' || command_id || '/' || fingerprint || '/' || asset_id || '.webp',
                command_id, 800, 800
           FROM chosen
       )
       INSERT INTO public.product_media (organization_id, product_id, media_asset_id, position)
       SELECT $1, product_id, asset_id, 0 FROM chosen`,
      [fixture.organizationId]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return fixture;
}

async function storeCounts(admin: pg.Pool, organizationId: string) {
  const { rows } = await admin.query<Record<string, number>>(
    `SELECT (SELECT count(*)::int FROM public.products WHERE organization_id = $1) AS products,
            (SELECT count(*)::int FROM public.products WHERE organization_id = $1 AND deleted_at IS NULL) AS "productsKept",
            (SELECT count(*)::int FROM public.product_variants WHERE organization_id = $1) AS variants,
            (SELECT count(*)::int FROM public.sales WHERE organization_id = $1) AS sales,
            (SELECT count(*)::int FROM public.product_media WHERE organization_id = $1) AS images`,
    [organizationId]
  );
  return rows[0];
}

interface MeasureContext {
  db: ReturnType<typeof createDatabase>["db"];
  recorder: ReturnType<typeof recordQueries>;
  runs: number;
  runtimeUrl: string;
  warmup: number;
}

async function timedRead(context: MeasureContext, fixture: TenantFixture) {
  let readMs = 0;
  let queries: TimedQuery[] = [];
  let facts: OwnerPlanTenantFacts | undefined;
  const started = performance.now();
  await withAuthorizedTenantTransaction(
    context.db,
    {
      authenticatedUserId: fixture.userId,
      capability: "billing:manage",
      requestedOrganizationId: fixture.organizationId,
    },
    async (transaction, identity) => {
      const readStarted = performance.now();
      context.recorder.start();
      try {
        facts = await readOwnerPlanTenantFacts(transaction, {
          organizationId: identity.organizationId,
        });
      } finally {
        queries = context.recorder.stop();
      }
      readMs = performance.now() - readStarted;
    }
  );
  return { callMs: performance.now() - started, facts, queries, readMs };
}

async function measureStore(
  context: MeasureContext,
  admin: pg.Pool,
  label: string,
  size: StoreSize
) {
  const seedStarted = performance.now();
  const fixture = await seedStore(admin, label, size);
  await admin.query(`VACUUM (ANALYZE) ${SEEDED_TABLES.join(", ")}`);
  const seedSeconds = round((performance.now() - seedStarted) / 1000);
  for (let run = 0; run < context.warmup; run += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: runs are timed one after the other
    await timedRead(context, fixture);
  }
  const calls: number[] = [];
  const reads: number[] = [];
  const byGroup = new Map<Group, number[]>(GROUPS.map((group) => [group, []]));
  const byQuery: number[][] = [];
  let lastQueries: TimedQuery[] = [];
  let lastFacts: OwnerPlanTenantFacts | undefined;
  for (let run = 0; run < context.runs; run += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: runs are timed one after the other
    const timed = await timedRead(context, fixture);
    calls.push(timed.callMs);
    reads.push(timed.readMs);
    const groups = groupQueries(timed.queries);
    const totals = new Map<Group, number>();
    timed.queries.forEach((query, index) => {
      const group = groups[index] as Group;
      totals.set(group, (totals.get(group) ?? 0) + query.ms);
      byQuery[index] = [...(byQuery[index] ?? []), query.ms];
    });
    for (const group of GROUPS) {
      byGroup.get(group)?.push(totals.get(group) ?? 0);
    }
    lastQueries = timed.queries;
    lastFacts = timed.facts;
  }
  const groups = groupQueries(lastQueries);
  const perQuery = lastQueries.map((query, index) => ({
    group: groups[index],
    index,
    sql: query.text.replace(/\s+/g, " ").slice(0, 160),
    ...summary(byQuery[index] ?? []),
  }));
  const slowest = [...perQuery].sort((a, b) => b.p50Ms - a.p50Ms).slice(0, 3);
  const explains: { index: number; plan: string[] }[] = [];
  for (const query of slowest) {
    const recorded = lastQueries[query.index] as TimedQuery;
    // biome-ignore lint/performance/noAwaitInLoops: one plan at a time
    const plan = await withRuntimeSqlContext(
      context.runtimeUrl,
      fixture,
      (client) =>
        client.query<{ "QUERY PLAN": string }>(
          `EXPLAIN (ANALYZE, BUFFERS) ${recorded.text}`,
          recorded.values
        )
    );
    explains.push({
      index: query.index,
      plan: plan.rows.map((row) => row["QUERY PLAN"]),
    });
  }
  return {
    call: summary(calls),
    counts: await storeCounts(admin, fixture.organizationId),
    explains,
    // what the read itself answered, next to the raw rows above: a seed that drifts from the read's rules shows here
    facts: lastFacts && { kept: lastFacts.kept, usage: lastFacts.usage },
    groups: Object.fromEntries(
      GROUPS.map((group) => [group, summary(byGroup.get(group) ?? [])])
    ),
    label,
    perQuery,
    queriesPerRead: lastQueries.length,
    read: summary(reads),
    seedSeconds,
  };
}

async function main() {
  const adminUrl = process.env.POLARIS_MEASURE_DATABASE_URL;
  assertLocalMeasureUrl(adminUrl, process.env.CI === "true");
  const runs = runsOf(process.env.MEASURE_RUNS);
  const warmup = warmupOf(process.env.MEASURE_WARMUP);
  const admin = createDatabase(adminUrl as string, { maxConnections: 2 });
  // the host says nothing about the database behind it: a marked one is refused before any write
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
    const runtimeUrl = temporaryRuntimeUrl(
      adminUrl as string,
      loginRole,
      password
    );
    runtime = createDatabase(runtimeUrl, { maxConnections: 1 });
    const context: MeasureContext = {
      db: runtime.db,
      recorder: recordQueries(runtime.pool),
      runs,
      runtimeUrl,
      warmup,
    };
    const larger = {
      products: BASE_STORE.products * LARGER_FACTOR,
      sales: BASE_STORE.sales * LARGER_FACTOR,
      variants: BASE_STORE.variants * LARGER_FACTOR,
    };
    const stores: unknown[] = [];
    for (const [label, size] of [
      ["ano-366", BASE_STORE],
      [`ano-366-x${LARGER_FACTOR}`, larger],
    ] as const) {
      // one store at a time keeps the timings apart
      // biome-ignore lint/performance/noAwaitInLoops: sequential on purpose
      const measured = await measureStore(context, admin.pool, label, size);
      stores.push(measured);
      console.error(`${label}: call p50 ${measured.call.p50Ms} ms`);
    }
    const { rows } = await admin.pool.query<{ version: string }>(
      "SELECT current_setting('server_version') AS version"
    );
    console.log(
      JSON.stringify(
        { postgres: rows[0]?.version, runs, stores, warmup },
        null,
        2
      )
    );
  } finally {
    await runtime?.pool.end();
    if (roleCreated) {
      // a failed drop is reported without hiding the error of the measure itself
      await admin.pool
        .query(`DROP ROLE IF EXISTS "${loginRole}"`)
        .catch(() =>
          console.error(`could not drop the login role ${loginRole}`)
        );
    }
    await admin.pool.end();
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "measure failed");
    process.exitCode = 1;
  });
}
