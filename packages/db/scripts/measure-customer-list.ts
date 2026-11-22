import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { createDatabase } from "../src/client";
import { getCustomer, listCustomers } from "../src/customer-repository";
import { assertAllowedGateUrl } from "./gate-hosts";
import { inCommittedTransaction } from "./gate-roles";
import { assertDisposableEnvironment, type MarkerClient } from "./gate-target";
import {
  createProductFixture,
  createTenantFixture,
  runtimeRole,
  type TenantFixture,
  temporaryRuntimeUrl,
  withRuntimeSqlContext,
  withTenant,
} from "./sales-gate-support";

/**
 * The local measure of the customer reads on a large store, on the PostgreSQL 18 of the gates
 * (`CI=true`, local host only). It builds one synthetic store (`MEASURE_CUSTOMERS` customers,
 * `MEASURE_SALES` attributed sales, one tenth with a partial or total return, one in fifty cancelled,
 * one in twenty reassigned once, and `MEASURE_HEAVY_PERCENT` percent of the sales on a single customer),
 * then, as the runtime role under RLS, captures the SQL that `listCustomers` and `getCustomer` really
 * send and repeats `EXPLAIN (ANALYZE, BUFFERS)` of each `MEASURE_RUNS` times. It prints JSON with the
 * size of the store generated, the wall time of the repository calls and the execution time and plan
 * nodes of each statement.
 *
 * Nothing but the database it is given is written, and only through the owner connection with the
 * triggers off for the bulk insert (the rows are plain facts, not commands; `session_replication_role`
 * needs a superuser, so the cluster with a non-superuser owner refuses it). Each run adds a new store and
 * deletes nothing: run it on the disposable database of the gates, recreated by `reset.sh` or the gate
 * runner, never on one you keep.
 *
 *   CI=true POLARIS_GATE_DATABASE_URL=postgresql://…@localhost:5432/polaris_gate \
 *   MEASURE_CUSTOMERS=500 MEASURE_SALES=50000 bun scripts/measure-customer-list.ts
 */

const customerCount = Number(process.env.MEASURE_CUSTOMERS ?? 500);
const saleCount = Number(process.env.MEASURE_SALES ?? 50_000);
const heavyPercent = Number(process.env.MEASURE_HEAVY_PERCENT ?? 10);
const runs = Number(process.env.MEASURE_RUNS ?? 5);

/**
 * The sizes are interpolated into utility statements, which take no parameters: refuse anything but whole numbers in range before any connection.
 * The floor of 251 customers comes from the typical customer, which used to be the fixed `OFFSET 250` one by name and so needed 251 customers. It is now the middle one (`floor(MEASURE_CUSTOMERS / 2)`), and the seed only needs 2 or more customers (`customerCount - 1` is a modulus), so the 251 is kept from that choice, not required by the code.
 */
function assertSizes() {
  const inRange = (value: number, min: number, max: number) =>
    Number.isInteger(value) && value >= min && value <= max;
  if (
    !(
      inRange(customerCount, 251, 100_000) &&
      inRange(saleCount, 2, 5_000_000) &&
      inRange(heavyPercent, 1, 100) &&
      inRange(runs, 1, 100)
    )
  ) {
    throw new Error(
      "MEASURE_CUSTOMERS must be 251..100000, MEASURE_SALES 2..5000000, MEASURE_HEAVY_PERCENT 1..100 and MEASURE_RUNS 1..100"
    );
  }
}

interface Captured {
  text: string;
  values: unknown[];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function summarize(values: number[]) {
  return {
    maxMs: Math.max(...values),
    p50Ms: median(values),
    samplesMs: values,
  };
}

async function seedStore(
  admin: ReturnType<typeof createDatabase>,
  fixture: TenantFixture,
  product: { productId: string; variantId: string }
) {
  const org = fixture.organizationId;
  await inCommittedTransaction(admin.pool, async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO public.customers (organization_id, name, phone, id)
       SELECT $1::text, 'Cliente ' || lpad(n::text, 5, '0'), '119' || lpad(n::text, 8, '0'), uuidv7() FROM generate_series(1, $2::int) n`,
      [org, customerCount]
    );
    await client.query(
      `CREATE TEMP TABLE bench_customer ON COMMIT DROP AS
       SELECT row_number() OVER (ORDER BY name) AS rn, id FROM public.customers WHERE organization_id = '${org}'`
    );
    await client.query(
      `CREATE TEMP TABLE bench_sale ON COMMIT DROP AS
       SELECT n, uuidv7() AS id, gen_random_uuid() AS command_id,
         1 + (n % 3) AS item_count,
         CASE WHEN n % 5 = 0 THEN 1 ELSE 0 END AS adjustment_count,
         CASE WHEN n <= (${saleCount} * ${heavyPercent} / 100) THEN 1 ELSE 2 + (n % (${customerCount} - 1)) END AS customer_rn,
         (current_date - (n % 365)) AS occurred_on
       FROM generate_series(1, ${saleCount}) n`
    );
    await client.query(
      `INSERT INTO public.sales (command_id, id, organization_id, adjustment_count, item_count, occurred_at, occurred_on)
       SELECT command_id, id, $1::text, adjustment_count, item_count, occurred_on + time '13:00', occurred_on FROM bench_sale`,
      [org]
    );
    await client.query(
      `INSERT INTO public.sale_items (organization_id, sale_id, position, product_id, variant_id, product_label, quantity, listed_unit_price, charged_unit_price)
       SELECT $1::text, s.id, p, $2::uuid, $3::uuid, 'Produto sintético', 2, 25 + (s.n % 50), 20 + (s.n % 50)
       FROM bench_sale s, LATERAL generate_series(0, s.item_count - 1) p`,
      [org, product.productId, product.variantId]
    );
    await client.query(
      `INSERT INTO public.sale_adjustments (organization_id, sale_id, position, kind, value_type, amount)
       SELECT $1::text, id, 0, 'discount', 'fixed', 5 FROM bench_sale WHERE adjustment_count = 1`,
      [org]
    );
    await client.query(
      `INSERT INTO public.sale_customer_links (organization_id, sale_id, version, action, customer_id)
       SELECT $1::text, s.id, 1, 'assign', c.id FROM bench_sale s JOIN bench_customer c ON c.rn = s.customer_rn`,
      [org]
    );
    await client.query(
      `INSERT INTO public.sale_customer_links (organization_id, sale_id, version, action, customer_id)
       SELECT $1::text, s.id, 2, 'reassign', c.id FROM bench_sale s
       JOIN bench_customer c ON c.rn = 1 + (s.customer_rn % $2::int)
       WHERE s.n % 20 = 7`,
      [org, customerCount]
    );
    await client.query(
      `CREATE TEMP TABLE bench_return ON COMMIT DROP AS
       SELECT s.*, uuidv7() AS return_id FROM bench_sale s WHERE s.n % 10 = 0`
    );
    await client.query(
      `INSERT INTO public.sale_returns (command_id, id, organization_id, sale_id, returned_by)
       SELECT gen_random_uuid(), return_id, $1::text, id, $2::text FROM bench_return`,
      [org, fixture.userId]
    );
    await client.query(
      `INSERT INTO public.sale_return_items (organization_id, sale_id, return_id, item_position, returned_quantity, restocked_quantity)
       SELECT $1::text, r.id, r.return_id, p, CASE WHEN r.n % 20 = 0 THEN 2 ELSE 1 END, 0
       FROM bench_return r, LATERAL generate_series(0, CASE WHEN r.n % 20 = 0 THEN r.item_count - 1 ELSE 0 END) p`,
      [org]
    );
    await client.query(
      `INSERT INTO public.sale_cancellations (command_id, organization_id, sale_id, cancelled_by)
       SELECT gen_random_uuid(), $1::text, id, $2::text FROM bench_sale WHERE n % 50 = 3`,
      [org, fixture.userId]
    );
  });
  await admin.pool.query(
    "ANALYZE public.customers, public.sales, public.sale_items, public.sale_adjustments, public.sale_customer_links, public.sale_returns, public.sale_return_items, public.sale_cancellations"
  );
  const { rows } = await admin.pool.query(
    `SELECT
       (SELECT count(*)::int FROM public.customers WHERE organization_id = $1) AS customers,
       (SELECT count(*)::int FROM public.sales WHERE organization_id = $1) AS sales,
       (SELECT count(*)::int FROM public.sale_items WHERE organization_id = $1) AS sale_items,
       (SELECT count(*)::int FROM public.sale_customer_links WHERE organization_id = $1) AS links,
       (SELECT count(DISTINCT sale_id)::int FROM public.sale_return_items WHERE organization_id = $1) AS sales_with_return,
       (SELECT count(*)::int FROM public.sale_cancellations WHERE organization_id = $1) AS cancelled,
       (SELECT count(*)::int FROM public.sale_customer_links l WHERE organization_id = $1 AND version = (SELECT max(version) FROM public.sale_customer_links m WHERE m.organization_id = l.organization_id AND m.sale_id = l.sale_id) AND customer_id = (SELECT id FROM public.customers WHERE organization_id = $1 ORDER BY name LIMIT 1)) AS heavy_customer_sales`,
    [org]
  );
  return rows[0];
}

async function captureStatements(
  run: () => Promise<unknown>
): Promise<Captured[]> {
  const captured: Captured[] = [];
  const original = Client.prototype.query;
  // biome-ignore lint/suspicious/noExplicitAny: the pg overloads cannot be forwarded with a typed rest
  (Client.prototype as any).query = function (this: Client, ...args: any[]) {
    const [first, second] = args as [
      string | { text: string; values?: unknown[] },
      unknown[] | undefined,
    ];
    const text = typeof first === "string" ? first : first.text;
    const values =
      second ?? (typeof first === "string" ? [] : (first.values ?? []));
    if (text.includes('from "customers"')) {
      captured.push({ text, values });
    }
    return (original as (...a: unknown[]) => unknown).apply(this, args);
  };
  try {
    await run();
  } finally {
    Client.prototype.query = original;
  }
  return captured;
}

const wantedPlanNode = /Seq Scan|Sort|Hash|Nested Loop|Merge|Aggregate|SubPlan/;

function planNodes(plan: string[]) {
  return plan
    .filter((line) => wantedPlanNode.test(line))
    .map((line) => line.trim());
}

async function explainRuns(
  runtimeUrl: string,
  fixture: TenantFixture,
  statement: Captured
) {
  const times: number[] = [];
  let lastPlan: string[] = [];
  let buffers = "";
  for (let index = 0; index < runs; index += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential on purpose, one run at a time
    const plan = await withRuntimeSqlContext(
      runtimeUrl,
      fixture,
      async (client) => {
        await client.query(`PREPARE measured AS ${statement.text}`);
        const literals = statement.values.map(
          (value) => `'${String(value).replaceAll("'", "''")}'`
        );
        return await client.query(
          `EXPLAIN (ANALYZE, BUFFERS) EXECUTE measured${
            literals.length > 0 ? `(${literals.join(", ")})` : ""
          }`
        );
      }
    );
    const lines = plan.rows.map(
      (row: Record<string, string>) => row["QUERY PLAN"] as string
    );
    const execution = lines.find((line) => line.startsWith("Execution Time"));
    const milliseconds = Number.parseFloat(execution?.split(":")[1] ?? "");
    if (Number.isNaN(milliseconds)) {
      throw new Error("the plan has no Execution Time line");
    }
    times.push(milliseconds);
    lastPlan = lines;
    buffers = lines.find((line) => line.includes("Buffers:")) ?? "";
  }
  return {
    ...summarize(times),
    buffersTop: buffers.trim(),
    fullPlan: lastPlan,
    nodes: planNodes(lastPlan),
  };
}

async function main() {
  assertSizes();
  const adminUrl = process.env.POLARIS_GATE_DATABASE_URL ?? "";
  const parsed = assertAllowedGateUrl(adminUrl);
  if (!["localhost", "127.0.0.1"].includes(parsed.hostname)) {
    throw new Error("the measure runs on the local PostgreSQL only");
  }
  const admin = createDatabase(adminUrl, { maxConnections: 2 });
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

    const fixture = await createTenantFixture(admin.pool, "customer-list");
    const product = await createProductFixture(
      runtime.db,
      fixture,
      "customer-list"
    );
    const size = await seedStore(admin, fixture, product);

    const heavy = await admin.pool.query(
      "SELECT id FROM public.customers WHERE organization_id = $1 ORDER BY name, id LIMIT 1",
      [fixture.organizationId]
    );
    const typical = await admin.pool.query(
      "SELECT id FROM public.customers WHERE organization_id = $1 ORDER BY name, id OFFSET floor($2::int / 2) LIMIT 1",
      [fixture.organizationId, customerCount]
    );
    const heavyId = heavy.rows[0].id as string;
    const typicalId = typical.rows[0].id as string;

    const listWall: number[] = [];
    let listed = 0;
    let listStatements: Captured[] = [];
    for (let index = 0; index < runs; index += 1) {
      const started = performance.now();
      // biome-ignore lint/performance/noAwaitInLoops: sequential on purpose, one run at a time
      const statements = await captureStatements(async () => {
        const rows = await withTenant(
          runtime?.db as ReturnType<typeof createDatabase>["db"],
          fixture,
          (transaction, identity) => listCustomers(transaction, identity)
        );
        listed = rows.length;
      });
      listWall.push(performance.now() - started);
      listStatements = statements;
    }

    const detailWall: Record<string, number[]> = { heavy: [], typical: [] };
    const detailStatements: Record<string, Captured[]> = {};
    for (const [label, customerId] of [
      ["heavy", heavyId],
      ["typical", typicalId],
    ] as const) {
      for (let index = 0; index < runs; index += 1) {
        const started = performance.now();
        // biome-ignore lint/performance/noAwaitInLoops: sequential on purpose, one run at a time
        detailStatements[label] = await captureStatements(async () => {
          await withTenant(
            runtime?.db as ReturnType<typeof createDatabase>["db"],
            fixture,
            (transaction, identity) =>
              getCustomer(transaction, identity, customerId)
          );
        });
        detailWall[label]?.push(performance.now() - started);
      }
    }

    const [listStatement] = listStatements;
    if (!listStatement) {
      throw new Error("the list statement was not captured");
    }
    const result = {
      detail: {} as Record<string, unknown>,
      list: {
        explain: await explainRuns(runtimeUrl, fixture, listStatement),
        rowsListed: listed,
        wall: summarize(listWall),
      },
      size,
    };
    for (const label of ["heavy", "typical"]) {
      const [statement] = detailStatements[label] ?? [];
      if (!statement) {
        throw new Error(`the ${label} customer statement was not captured`);
      }
      // biome-ignore lint/performance/noAwaitInLoops: sequential on purpose, one run at a time
      const explain = await explainRuns(runtimeUrl, fixture, statement);
      result.detail[label] = {
        explain,
        wall: summarize(detailWall[label] ?? []),
      };
    }
    console.log(JSON.stringify(result, null, 2));
  } finally {
    try {
      await runtime?.pool.end();
    } finally {
      try {
        if (roleCreated) {
          await admin.pool.query(`DROP ROLE IF EXISTS "${loginRole}"`);
        }
      } finally {
        await admin.pool.end();
      }
    }
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : "measure failed"
  );
  process.exitCode = 1;
});
