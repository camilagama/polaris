import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/client";
import {
  dailySalesQuery,
  type EconomicsPeriod,
  InvalidEconomicsPeriodError,
  MAX_DAILY_SALES_DAYS,
  readDailySales,
  readPeriodSummary,
} from "../src/economics-repository";
import { cancelSale } from "../src/sale-cancellation-repository";
import { confirmSale } from "../src/sale-repository";
import { createSaleReturn } from "../src/sale-return-repository";
import {
  TenantAuthorizationError,
  withAuthorizedTenantTransaction,
} from "../src/tenant-transaction";
import {
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
 * The daily sales series of the Início's map (`readDailySales`) on a real
 * PostgreSQL 18: the database aggregates net sales and the count of sales of
 * each date with SQL, and this gate proves that it is the engine's
 * `readPeriodSummary(...).daily` (`netSales` and `salesCount`), date by date,
 * over generated sales with discounts (fixed and percentage, split among the
 * items, with ties), partial, repeated and full returns, cancellations, sales a
 * second before and after midnight and organizations in different time zones.
 * It also proves the scope (organization, capability, period) and prints the
 * plan of the statement: which index reads `sales`.
 *
 * The generated sales come from a seed printed as a `gate-note`; set
 * `POLARIS_DAILY_SALES_SEED` to replay a failure.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

/** São Paulo (UTC-3), Tokyo (UTC+9) and Auckland (UTC+13 or +12, with daylight saving time). */
const ZONES = ["America/Sao_Paulo", "Asia/Tokyo", "Pacific/Auckland"];
const GENERATED_SALES_PER_STORE = 45;
/** The owner dates a sale at most 30 days back (ADR 0021). */
const GENERATED_DAYS = 26;
const MOVED_BACK_DAYS = 150;
/** The last sales of each store (generated ones, uuidv7 in creation order) are the ones moved back. */
const MOVED_BACK_PER_STORE = 8;

type AdminPool = ReturnType<typeof createDatabase>["pool"];
type RuntimeDb = ReturnType<typeof createDatabase>["db"];
type Adjustments = Parameters<typeof confirmSale>[2]["adjustments"];

interface Variant {
  variantId: string;
}

interface Line {
  cents: number;
  quantity: number;
  variant: Variant;
}

interface Store {
  tenant: TenantFixture;
  timezone: string;
  today: string;
}

interface PlanNode {
  "Index Name"?: string;
  "Node Type"?: string;
  Plans?: PlanNode[];
  "Relation Name"?: string;
}

/** A small deterministic generator (a linear congruential one, in plain arithmetic). */
function generator(seed: number) {
  const modulus = 2 ** 32;
  let state = Math.abs(Math.trunc(seed)) % modulus;
  return (n: number) => {
    state = (state * 1_664_525 + 1_013_904_223) % modulus;
    return Math.floor((state / modulus) * n);
  };
}

function dateFrom(day: string, days: number): string {
  const shifted = new Date(`${day}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function centsText(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function scansOf(node: PlanNode, relation: string): PlanNode[] {
  const own = node["Relation Name"] === relation ? [node] : [];
  return [
    ...own,
    ...(node.Plans ?? []).flatMap((child) => scansOf(child, relation)),
  ];
}

/** The indexes a scan reads: its own, or those of the bitmap index scans under a bitmap heap scan. */
function indexesOf(node: PlanNode): string[] {
  return [
    ...(node["Index Name"] ? [node["Index Name"]] : []),
    ...(node.Plans ?? []).flatMap(indexesOf),
  ];
}

class Fixture {
  readonly counts = {
    cancelled: 0,
    fullyReturned: 0,
    returned: 0,
    returnedWithDiscount: 0,
    sales: 0,
  };
  private readonly pick: (n: number) => number;
  private readonly admin: AdminPool;
  private readonly db: RuntimeDb;

  constructor(admin: AdminPool, db: RuntimeDb, seed: number) {
    this.admin = admin;
    this.db = db;
    this.pick = generator(seed);
  }

  as<T>(
    tenant: TenantFixture,
    capability: string,
    operation: Parameters<typeof withTenantAs<T>>[3]
  ) {
    return withTenantAs(this.db, tenant, capability, operation);
  }

  /** The period summary needs one consistent snapshot, as the repository requires. */
  summary(tenant: TenantFixture, period: EconomicsPeriod) {
    return withAuthorizedTenantTransaction(
      this.db,
      {
        authenticatedUserId: tenant.userId,
        capability: "report:read",
        isolationLevel: "repeatable read",
        requestedOrganizationId: tenant.organizationId,
      },
      (tx, identity) => readPeriodSummary(tx, identity, period)
    );
  }

  /** A time of a store date in the store's zone, as the instant a sale carries. */
  async instantOf(timezone: string, day: string, seconds: number) {
    const result = await this.admin.query<{ instant: string }>(
      `SELECT to_char((($1::date::timestamp + make_interval(secs => $2)) AT TIME ZONE $3) AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS instant`,
      [day, seconds, timezone]
    );
    return result.rows[0]?.instant as string;
  }

  sell(
    tenant: TenantFixture,
    occurredAt: string,
    items: Line[],
    adjustments: Adjustments
  ) {
    this.counts.sales += 1;
    return this.as(tenant, "sale:create", (tx, identity) =>
      confirmSale(tx, identity, {
        adjustments,
        commandId: randomUUID(),
        commandVersion: 1,
        items: items.map((item) => ({
          chargedUnitPrice: centsText(item.cents),
          listedUnitPrice: centsText(item.cents),
          quantity: item.quantity,
          variantId: item.variant.variantId,
        })),
        occurredAt,
        payment: { anticipationRequested: false, method: "pix" },
        paymentProfile: null,
        requestId: randomUUID(),
      })
    );
  }

  giveBack(
    tenant: TenantFixture,
    saleId: string,
    items: { position: number; returnedQuantity: number }[]
  ) {
    return this.as(tenant, "sale:return", (tx, identity) =>
      createSaleReturn(tx, identity, {
        commandId: randomUUID(),
        commandVersion: 1,
        items: items.map((item) => ({
          position: item.position,
          // restocking changes the cost, never net sales: half of them go back to the shelf
          restockedQuantity:
            item.position % 2 === 0 ? item.returnedQuantity : 0,
          returnedQuantity: item.returnedQuantity,
        })),
        saleId,
      })
    );
  }

  /** A store in `timezone` with four products, one of them of unknown cost. */
  async store(timezone: string): Promise<Store & { variants: Variant[] }> {
    const tenant = await createTenantFixture(
      this.admin,
      `daily sales ${timezone}`,
      timezone
    );
    const today = (
      await this.admin.query<{ today: string }>(
        "SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS today",
        [timezone]
      )
    ).rows[0]?.today as string;
    const variants: Variant[] = [];
    for (const [index, cost] of ["10.00", null, "3.33", "0.10"].entries()) {
      variants.push(
        // biome-ignore lint/performance/noAwaitInLoops: one product after the other, as a store creates them
        await createSellableProduct(
          { adminPool: this.admin, db: this.db },
          tenant,
          `DS-${index}`,
          { cost, quantity: 100_000 }
        )
      );
    }
    return { tenant, timezone, today, variants };
  }

  private adjustments(subtotal: number): Adjustments {
    const adjustments: Adjustments[number][] = [];
    const discount = this.pick(3);
    if (discount === 1 && subtotal > 3) {
      adjustments.push({
        kind: "discount",
        value: {
          amount: centsText(1 + this.pick(Math.floor(subtotal / 3))),
          type: "fixed",
        },
      });
    } else if (discount === 2) {
      adjustments.push({
        kind: "discount",
        value: { percentage: `${1 + this.pick(30)}.5`, type: "percentage" },
      });
    }
    if (this.pick(4) === 0) {
      adjustments.push({
        kind: "freight",
        value: { amount: centsText(1 + this.pick(2000)), type: "fixed" },
      });
    }
    return adjustments;
  }

  /** One or two returns of part (or all) of the units of some items. */
  private async partialReturns(
    tenant: TenantFixture,
    saleId: string,
    items: Line[]
  ) {
    const left = items.map((item) => item.quantity);
    const rounds = 1 + this.pick(2);
    for (let round = 0; round < rounds; round += 1) {
      const position = this.pick(items.length);
      const available = left[position] ?? 0;
      if (available > 0) {
        const returnedQuantity = 1 + this.pick(available);
        left[position] = available - returnedQuantity;
        // biome-ignore lint/performance/noAwaitInLoops: a second return sees the first one
        await this.giveBack(tenant, saleId, [{ position, returnedQuantity }]);
      }
    }
  }

  /** A generated sale on one of the last days, then returned, returned in full, cancelled or kept. */
  async generatedSale(store: Store & { variants: Variant[] }) {
    const day = dateFrom(store.today, -1 - this.pick(GENERATED_DAYS));
    const items = Array.from({ length: 1 + this.pick(4) }, (_, position) => ({
      cents: 1 + this.pick(30_000),
      quantity: 1 + this.pick(5),
      variant: store.variants[position] as Variant,
    }));
    const subtotal = items.reduce(
      (total, item) => total + item.cents * item.quantity,
      0
    );
    const adjustments = this.adjustments(subtotal);
    const discounted = adjustments.some((entry) => entry.kind === "discount");
    const confirmed = await this.sell(
      store.tenant,
      await this.instantOf(store.timezone, day, this.pick(86_400)),
      items,
      adjustments
    );
    const fate = this.pick(10);
    if (fate < 3) {
      await this.partialReturns(store.tenant, confirmed.sale.id, items);
    } else if (fate === 3) {
      await this.giveBack(
        store.tenant,
        confirmed.sale.id,
        items.map((item, position) => ({
          position,
          returnedQuantity: item.quantity,
        }))
      );
      this.counts.fullyReturned += 1;
    } else if (fate === 4) {
      await this.as(store.tenant, "sale:cancel", (tx, identity) =>
        cancelSale(tx, identity, {
          commandId: randomUUID(),
          commandVersion: 1,
          saleId: confirmed.sale.id,
        })
      );
      this.counts.cancelled += 1;
    }
    if (fate <= 3) {
      this.counts.returned += 1;
      this.counts.returnedWithDiscount += discounted ? 1 : 0;
    }
  }
}

/** A sale worked out by hand, alone on its date (days before the generated ones), with its returns. */
async function handWorked(
  fixture: Fixture,
  store: Store,
  daysBack: number,
  sale: {
    adjustments: Adjustments;
    expected: string;
    items: Line[];
    returns: { position: number; returnedQuantity: number }[][];
  }
) {
  const day = dateFrom(store.today, daysBack);
  const confirmed = await fixture.sell(
    store.tenant,
    await fixture.instantOf(store.timezone, day, 43_200),
    sale.items,
    sale.adjustments
  );
  for (const items of sale.returns) {
    // biome-ignore lint/performance/noAwaitInLoops: the second return of an item sees the first one
    await fixture.giveBack(store.tenant, confirmed.sale.id, items);
  }
  const series = await fixture.as(store.tenant, "report:read", (tx, identity) =>
    readDailySales(tx, identity, { from: day, to: day })
  );
  assert.deepEqual(series, { count: [1], from: day, net: [sale.expected] });
  const summary = await fixture.summary(store.tenant, { from: day, to: day });
  assert.equal(summary.daily[0]?.netSales, sale.expected);
}

/** Sales a second around midnight, the sales worked out by hand, and the generated ones. */
async function seedStore(fixture: Fixture, timezone: string): Promise<Store> {
  const store = await fixture.store(timezone);
  const { tenant, today, variants } = store;
  const [first, second, third] = variants as [Variant, Variant, Variant];

  // a second before and a second after the midnight that opens yesterday, in the store's own zone
  const beforeMidnight = await fixture.sell(
    tenant,
    await fixture.instantOf(timezone, dateFrom(today, -2), 86_399),
    [{ cents: 1000, quantity: 1, variant: first }],
    []
  );
  const afterMidnight = await fixture.sell(
    tenant,
    await fixture.instantOf(timezone, dateFrom(today, -1), 1),
    [{ cents: 2000, quantity: 1, variant: first }],
    []
  );
  assert.equal(beforeMidnight.sale.occurredOn, dateFrom(today, -2));
  assert.equal(afterMidnight.sale.occurredOn, dateFrom(today, -1));

  // three items of 1.00 and a discount of 0.10: 0.03 each, and the cent left
  // goes to the first position (a tie of remainders); the first item comes
  // back: 3.00 - 0.10 - (1.00 - 0.04) = 1.94
  await handWorked(fixture, store, -GENERATED_DAYS - 2, {
    adjustments: [
      { kind: "discount", value: { amount: "0.10", type: "fixed" } },
    ],
    expected: "1.94",
    items: [first, second, third].map((variant) => ({
      cents: 100,
      quantity: 1,
      variant,
    })),
    returns: [[{ position: 0, returnedQuantity: 1 }]],
  });
  // 3 x 1.00 and 1 x 1.00 with a discount of 0.05: 0.04 and 0.01; one unit of
  // the first item comes back twice, and its share of the discount is taken on
  // the two units together, round half up (0.04 x 2 / 3 = 0.0267 -> 0.03):
  // 4.00 - 0.05 - (2.00 - 0.03) = 1.98 (line by line it would be 1.97)
  await handWorked(fixture, store, -GENERATED_DAYS - 1, {
    adjustments: [
      { kind: "discount", value: { amount: "0.05", type: "fixed" } },
    ],
    expected: "1.98",
    items: [
      { cents: 100, quantity: 3, variant: first },
      { cents: 100, quantity: 1, variant: second },
    ],
    returns: [
      [{ position: 0, returnedQuantity: 1 }],
      [{ position: 0, returnedQuantity: 1 }],
    ],
  });
  // 2 x 1.00 with a discount of 0.01; one unit comes back, and its share of the
  // discount is exactly half a cent, rounded up: 2.00 - 0.01 - (1.00 - 0.01) = 1.00
  await handWorked(fixture, store, -GENERATED_DAYS - 3, {
    adjustments: [
      { kind: "discount", value: { amount: "0.01", type: "fixed" } },
    ],
    expected: "1.00",
    items: [{ cents: 100, quantity: 2, variant: first }],
    returns: [[{ position: 0, returnedQuantity: 1 }]],
  });

  for (let index = 0; index < GENERATED_SALES_PER_STORE; index += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: the generator is sequential, so the seed replays the same sales
    await fixture.generatedSale(store);
  }
  return store;
}

/**
 * Some generated sales moved to the far end of the 182 days with an UPDATE of
 * the sale's dates only: the owner dates a sale at most 30 days back. A gate
 * fixture, never done with real data.
 */
async function moveSomeBack(admin: AdminPool, stores: Store[]) {
  const moved = await admin.query(
    `UPDATE public.sales
        SET occurred_at = occurred_at - make_interval(days => $2),
            occurred_on = occurred_on - $2::int
      WHERE id IN (
        SELECT ranked.id FROM (
          SELECT sale.id,
            row_number() OVER (PARTITION BY sale.organization_id ORDER BY sale.id DESC) AS latest
          FROM public.sales AS sale
          WHERE sale.organization_id = ANY($1)
        ) AS ranked
        WHERE ranked.latest <= $3
      )`,
    [
      stores.map((store) => store.tenant.organizationId),
      MOVED_BACK_DAYS,
      MOVED_BACK_PER_STORE,
    ]
  );
  assert.equal(moved.rowCount, MOVED_BACK_PER_STORE * stores.length);
}

/** The rule has something to prove: the fixture really holds what it must handle. */
async function assertFixtureNotEmpty(
  admin: AdminPool,
  fixture: Fixture,
  stores: Store[]
) {
  const generated = await admin.query<{
    cancelled: string;
    returned_with_discount: string;
    sales: string;
  }>(
    `SELECT
       (SELECT count(*) FROM public.sales WHERE organization_id = ANY($1))::text AS sales,
       (SELECT count(*) FROM public.sale_cancellations WHERE organization_id = ANY($1))::text AS cancelled,
       (SELECT count(DISTINCT returned.sale_id)
          FROM public.sale_return_items AS returned
          JOIN public.sale_adjustments AS adjustment
            ON adjustment.organization_id = returned.organization_id
           AND adjustment.sale_id = returned.sale_id
           AND adjustment.kind = 'discount'
         WHERE returned.organization_id = ANY($1))::text AS returned_with_discount`,
    [stores.map((store) => store.tenant.organizationId)]
  );
  const [row] = generated.rows;
  assert.ok(row);
  assert.equal(Number(row.sales), fixture.counts.sales);
  assert.equal(Number(row.cancelled), fixture.counts.cancelled);
  assert.ok(fixture.counts.cancelled >= 1, "no cancelled sale generated");
  // three of each store are worked out by hand, plus the generated ones
  assert.ok(
    Number(row.returned_with_discount) > 3 * stores.length,
    "no generated return of a discounted sale"
  );
  console.log(
    `gate-note: daily-sales fixture ${JSON.stringify(fixture.counts)}`
  );
}

/** `readDailySales` equals `readPeriodSummary(...).daily` date by date. */
async function assertEquivalence(fixture: Fixture, stores: Store[]) {
  let comparedDays = 0;
  let daysWithSales = 0;
  for (const store of stores) {
    const { today } = store;
    const windows: EconomicsPeriod[] = [
      { from: dateFrom(today, 1 - MAX_DAILY_SALES_DAYS), to: today },
      { from: dateFrom(today, -61), to: today },
      { from: dateFrom(today, -30), to: dateFrom(today, -1) },
      { from: dateFrom(today, -2), to: dateFrom(today, -1) },
      {
        from: dateFrom(today, -MOVED_BACK_DAYS - GENERATED_DAYS - 3),
        to: dateFrom(today, -MOVED_BACK_DAYS),
      },
    ];
    for (const period of windows) {
      // biome-ignore lint/performance/noAwaitInLoops: each window is its own pair of reads
      const series = await fixture.as(store.tenant, "report:read", (tx, id) =>
        readDailySales(tx, id, period)
      );
      const summary = await fixture.summary(store.tenant, period);
      assert.equal(series.from, period.from);
      assert.equal(series.net.length, summary.daily.length);
      assert.equal(series.count.length, summary.daily.length);
      for (const [index, day] of summary.daily.entries()) {
        const where = `${store.timezone} ${day.date}`;
        assert.equal(series.net[index], day.netSales, `${where}: net`);
        assert.equal(series.count[index], day.salesCount, `${where}: count`);
        comparedDays += 1;
        daysWithSales += day.salesCount > 0 ? 1 : 0;
      }
    }
  }
  assert.ok(daysWithSales >= 60, `only ${daysWithSales} dates had sales`);
  return { comparedDays, daysWithSales };
}

/** Another organization, a capability without the report and a bad period. */
async function assertScope(
  admin: AdminPool,
  fixture: Fixture,
  [first, second]: Store[]
) {
  assert.ok(first && second);
  const empty = await createTenantFixture(admin, "daily sales empty");
  const longest = {
    from: dateFrom(first.today, 1 - MAX_DAILY_SALES_DAYS),
    to: first.today,
  };
  const emptySeries = await fixture.as(empty, "report:read", (tx, identity) =>
    readDailySales(tx, identity, longest)
  );
  assert.equal(emptySeries.net.length, MAX_DAILY_SALES_DAYS);
  assert.ok(emptySeries.net.every((net) => net === "0.00"));
  assert.ok(emptySeries.count.every((count) => count === 0));

  // the statement asked for the first store inside the second one's context finds nothing (RLS)
  const crossed = await fixture.as(second.tenant, "report:read", (tx) =>
    tx.execute(dailySalesQuery(first.tenant.organizationId, longest))
  );
  assert.equal(crossed.rows.length, MAX_DAILY_SALES_DAYS);
  assert.ok(
    (crossed.rows as { count: number }[]).every(
      (row) => Number(row.count) === 0
    )
  );

  await assert.rejects(
    fixture.as(first.tenant, "sale:create", (tx, identity) =>
      readDailySales(tx, identity, { from: first.today, to: first.today })
    ),
    (error: unknown) =>
      error instanceof TenantAuthorizationError &&
      error.message === "capability_denied"
  );
  const refused = await Promise.allSettled(
    [
      { from: dateFrom(first.today, -MAX_DAILY_SALES_DAYS), to: first.today },
      { from: first.today, to: dateFrom(first.today, -1) },
      { from: "2026-02-30", to: "2026-03-01" },
    ].map((period) =>
      fixture.as(first.tenant, "report:read", (tx, identity) =>
        readDailySales(tx, identity, period)
      )
    )
  );
  for (const outcome of refused) {
    assert.equal(outcome.status, "rejected");
    assert.ok(
      outcome.status === "rejected" &&
        outcome.reason instanceof InvalidEconomicsPeriodError
    );
  }
}

async function indexesOfSales(admin: AdminPool) {
  const result = await admin.query<{ columns: string[]; name: string }>(
    `SELECT index_class.relname AS name,
            array(
              SELECT attribute.attname::text
                FROM unnest(idx.indkey) WITH ORDINALITY AS key (attnum, ord)
                JOIN pg_attribute AS attribute
                  ON attribute.attrelid = idx.indrelid AND attribute.attnum = key.attnum
               ORDER BY key.ord
            ) AS columns
       FROM pg_index AS idx
       JOIN pg_class AS index_class ON index_class.oid = idx.indexrelid
      WHERE idx.indrelid = 'public.sales'::regclass`
  );
  return result.rows;
}

/** The plan of the statement: `sales` is read by an index of the organization, never whole. */
async function explainPlan(admin: AdminPool, fixture: Fixture, store: Store) {
  const indexes = await indexesOfSales(admin);
  const plan = await fixture.as(
    store.tenant,
    "report:read",
    async (tx, identity) => {
      // the gate's tables are tiny: without this the planner reads them whole
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      const explained = await tx.execute(
        sql`EXPLAIN (FORMAT JSON) ${dailySalesQuery(identity.organizationId, {
          from: dateFrom(store.today, 1 - MAX_DAILY_SALES_DAYS),
          to: store.today,
        })}`
      );
      const [row] = explained.rows as { "QUERY PLAN": [{ Plan: PlanNode }] }[];
      assert.ok(row);
      return row["QUERY PLAN"][0].Plan;
    }
  );
  const scans = scansOf(plan, "sales").map((scan) => ({
    indexes: indexesOf(scan),
    node: scan["Node Type"] ?? null,
  }));
  assert.ok(scans.length > 0);
  const byOrganization = indexes
    .filter((index) => index.columns[0] === "organization_id")
    .map((index) => index.name);
  const byOrganizationAndDate = indexes
    .filter(
      (index) =>
        index.columns[0] === "organization_id" &&
        index.columns[1] === "occurred_on"
    )
    .map((index) => index.name);
  const used = scans.flatMap((scan) => scan.indexes);
  for (const scan of scans) {
    assert.notEqual(scan.node, "Seq Scan");
    assert.ok(
      scan.indexes.length > 0 &&
        scan.indexes.every((name) => byOrganization.includes(name)),
      `sales read by ${scan.node} on ${scan.indexes.join(", ")}`
    );
  }
  if (byOrganizationAndDate.length > 0) {
    // once the index exists, the plan must use it
    assert.ok(
      used.some((name) => byOrganizationAndDate.includes(name)),
      `the plan reads sales by ${used.join(", ")}`
    );
  }
  console.log(
    `gate-note: daily-sales plan ${JSON.stringify({ byOrganizationAndDate, scans })}`
  );
  return byOrganizationAndDate.length > 0
    ? `EXPLAIN: sales is read by the (organization_id, occurred_on) index (${used.join(", ")})`
    : `EXPLAIN: sales is read by an index led by organization_id (${used.join(", ")}); there is NO (organization_id, occurred_on) index, so the dates are filtered among all the organization's sales`;
}

async function run() {
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, gateBranchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);

  const admin = createDatabase(adminUrl, { maxConnections: 2 });
  let runtime: ReturnType<typeof createDatabase> | undefined;
  let loginRole: string | undefined;
  const tests: string[] = [];
  const seed = Number(
    process.env.POLARIS_DAILY_SALES_SEED ?? Date.now() % 1_000_000_000
  );
  console.log(`gate-note: daily-sales seed ${seed}`);

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

    loginRole = `polaris_daily_sales_gate_${randomUUID().replaceAll("-", "")}`;
    const loginPassword = randomBytes(24).toString("hex");
    await admin.pool.query(
      `CREATE ROLE "${loginRole}" WITH LOGIN INHERIT PASSWORD '${loginPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
    );
    await admin.pool.query(`GRANT "${runtimeRole}" TO "${loginRole}"`);
    runtime = createDatabase(
      temporaryRuntimeUrl(adminUrl, loginRole, loginPassword),
      { maxConnections: 10 }
    );
    const fixture = new Fixture(admin.pool, runtime.db, seed);

    const stores: Store[] = [];
    for (const timezone of ZONES) {
      // biome-ignore lint/performance/noAwaitInLoops: one store after the other keeps the seed's sales in order
      stores.push(await seedStore(fixture, timezone));
    }
    tests.push(
      "a sale a second before midnight and one a second after fall on their own dates, and three sales worked out by hand (the discount split with a tie, 1.94; one item returned in two times, 1.98; a share of the discount of exactly half a cent, 1.00) are the same in the series and in the summary, in São Paulo, Tokyo and Auckland"
    );
    await moveSomeBack(admin.pool, stores);
    await assertFixtureNotEmpty(admin.pool, fixture, stores);

    const { comparedDays, daysWithSales } = await assertEquivalence(
      fixture,
      stores
    );
    tests.push(
      `the SQL series equals periodSummary.daily (netSales and salesCount) date by date: ${comparedDays} dates compared, ${daysWithSales} with sales, in 5 windows of up to 182 days per store, over fixed and percentage discounts, partial, repeated and full returns, cancellations and freight`
    );

    await assertScope(admin.pool, fixture, stores);
    tests.push(
      "an organization without sales gets 182 dates of 0.00 and 0; the statement for another organization finds nothing under RLS; another capability, 183 dates, an inverted period and an impossible date are refused"
    );

    tests.push(await explainPlan(admin.pool, fixture, stores[0] as Store));

    console.log(
      JSON.stringify(
        {
          branch,
          database: serverRow.database_name,
          seed,
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
  console.error(
    `Daily sales PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
