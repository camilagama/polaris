import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  dashboardCards,
  resultQuality,
} from "@polaris/domain/economics/period-summary";
import { createDatabase } from "../src/client";
import {
  EconomicsSnapshotRequiredError,
  InvalidEconomicsPeriodError,
  InvalidTopProductsError,
  readPeriodFacts,
  readPeriodResult,
  readPeriodSummary,
} from "../src/economics-repository";
import {
  createExpense,
  listExpenseCategories,
  voidExpense,
} from "../src/expense-repository";
import { createPaymentProfile } from "../src/payment-profile-repository";
import { deleteProduct } from "../src/product-repository";
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
  recentInstant,
  redactedFailure,
  requiredEnvironment,
  runtimeRole,
  type TenantFixture,
  temporaryRuntimeUrl,
  withTenantAs,
} from "./sales-gate-support";

/**
 * The economics of a period (plan PR66 and PR67) on a real PostgreSQL 18: the
 * facts the engine needs are read from real sales, adjustments, fee snapshots,
 * returns, cancellations and expenses, and the result is checked against
 * figures worked out by hand and against independent SQL aggregates.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

function dateFrom(day: string, days: number): string {
  const [year, month, date] = day.split("-").map(Number);
  const shifted = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, date ?? 1));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
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
      "disposable direct Neon connection is PostgreSQL 18 with every migration replayed from scratch"
    );

    const tenantA: TenantFixture = await createTenantFixture(
      admin.pool,
      "economics A"
    );
    const tenantB: TenantFixture = await createTenantFixture(
      admin.pool,
      "economics B"
    );
    loginRole = `polaris_economics_gate_${randomUUID().replaceAll("-", "")}`;
    const loginPassword = randomBytes(24).toString("hex");
    await admin.pool.query(
      `CREATE ROLE "${loginRole}" WITH LOGIN INHERIT PASSWORD '${loginPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
    );
    await admin.pool.query(`GRANT "${runtimeRole}" TO "${loginRole}"`);
    const runtimeUrl = temporaryRuntimeUrl(adminUrl, loginRole, loginPassword);
    const runtimeDatabase = createDatabase(runtimeUrl, { maxConnections: 10 });
    runtime = runtimeDatabase;
    const { db } = runtimeDatabase;
    const rt = { adminPool: admin.pool, db };
    const as = <T>(
      tenant: TenantFixture,
      capability: string,
      operation: Parameters<typeof withTenantAs<T>>[3]
    ) => withTenantAs(db, tenant, capability, operation);
    const today = (
      await admin.pool.query<{ today: string }>(
        "SELECT to_char((now() AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD') AS today"
      )
    ).rows[0]?.today as string;
    const period = { from: dateFrom(today, -7), to: today };

    // --------------------------------------------------------------- fixtures
    const p1 = await createSellableProduct(rt, tenantA, "E-P1", {
      cost: "10.00",
      quantity: 100,
    });
    const p2 = await createSellableProduct(rt, tenantA, "E-P2 sem custo", {
      cost: null,
      quantity: 20,
    });
    const profile = await as(tenantA, "organization:manage", (tx, identity) =>
      createPaymentProfile(tx, identity, {
        name: "Maquininha da economia",
        rules: [
          {
            anticipationFee: { mode: "none" as const },
            expectedSettlementDays: 1,
            method: "pix",
            processingFee: {
              fixedAmount: null,
              mode: "percentage" as const,
              percentage: "1.500000",
            },
          },
        ],
      })
    );
    const sell = (
      items: {
        chargedUnitPrice: string;
        listedUnitPrice: string;
        quantity: number;
        variantId: string;
      }[],
      adjustments: Parameters<typeof confirmSale>[2]["adjustments"],
      withProfile: boolean
    ) =>
      as(tenantA, "sale:create", (tx, identity) =>
        confirmSale(tx, identity, {
          adjustments,
          commandId: randomUUID(),
          commandVersion: 1,
          items,
          occurredAt: recentInstant(3),
          payment: { anticipationRequested: false, method: "pix" },
          paymentProfile: withProfile
            ? { expectedVersion: profile.version, id: profile.id }
            : null,
          requestId: randomUUID(),
        })
      );

    // S1: 3 x 89.90, discount 10.00, freight 12.00, profile (1.5% fee)
    const s1 = await sell(
      [
        {
          chargedUnitPrice: "89.90",
          listedUnitPrice: "100.00",
          quantity: 3,
          variantId: p1.variantId,
        },
      ],
      [
        { kind: "discount", value: { amount: "10.00", type: "fixed" } },
        { kind: "freight", value: { amount: "12.00", type: "fixed" } },
      ],
      true
    );
    // S2: one item with a known cost and one with an unknown cost, no profile
    const s2 = await sell(
      [
        {
          chargedUnitPrice: "50.00",
          listedUnitPrice: "50.00",
          quantity: 2,
          variantId: p1.variantId,
        },
        {
          chargedUnitPrice: "30.00",
          listedUnitPrice: "30.00",
          quantity: 1,
          variantId: p2.variantId,
        },
      ],
      [],
      false
    );
    // S3: 2 x 60.00 with a discount of 12.00; one unit comes back, restocked
    const s3 = await sell(
      [
        {
          chargedUnitPrice: "60.00",
          listedUnitPrice: "60.00",
          quantity: 2,
          variantId: p1.variantId,
        },
      ],
      [{ kind: "discount", value: { amount: "12.00", type: "fixed" } }],
      false
    );
    await as(tenantA, "sale:return", (tx, identity) =>
      createSaleReturn(tx, identity, {
        commandId: randomUUID(),
        commandVersion: 1,
        items: [{ position: 0, restockedQuantity: 1, returnedQuantity: 1 }],
        saleId: s3.sale.id,
      })
    );
    // S4: cancelled
    const s4 = await sell(
      [
        {
          chargedUnitPrice: "70.00",
          listedUnitPrice: "70.00",
          quantity: 1,
          variantId: p1.variantId,
        },
      ],
      [],
      false
    );
    await as(tenantA, "sale:cancel", (tx, identity) =>
      cancelSale(tx, identity, {
        commandId: randomUUID(),
        commandVersion: 1,
        saleId: s4.sale.id,
      })
    );

    // expenses: a delivery linked to S1 (counts in S1's margin), a linked one
    // voided, one linked to the cancelled sale, operating ones, and old ones
    const categories = await as(tenantA, "expense:create", (tx, identity) =>
      listExpenseCategories(tx, identity)
    );
    const delivery = categories.find((c) => c.systemKey === "delivery");
    const rent = categories.find((c) => c.systemKey === "rent");
    assert.ok(delivery && rent);
    const expense = (
      amount: string,
      categoryId: string,
      competenceOn: string,
      saleId: string | null
    ) =>
      as(tenantA, "expense:create", (tx, identity) =>
        createExpense(tx, identity, {
          amount,
          categoryId,
          competenceOn,
          description: `despesa ${amount}`,
          saleId,
        })
      );
    await expense("15.00", delivery.id, today, s1.sale.id);
    const voidedLinked = await expense("99.00", delivery.id, today, s1.sale.id);
    await as(tenantA, "expense:create", (tx, identity) =>
      voidExpense(tx, identity, {
        expectedVersion: voidedLinked.version,
        id: voidedLinked.id,
      })
    );
    await expense("40.00", delivery.id, today, s4.sale.id);
    await expense("200.00", rent.id, dateFrom(today, -1), null);
    await expense("1000.00", rent.id, dateFrom(today, -40), null);
    await expense("25.00", rent.id, dateFrom(today, -25), null);
    const voidedOperating = await expense("500.00", rent.id, today, null);
    await as(tenantA, "expense:create", (tx, identity) =>
      voidExpense(tx, identity, {
        expectedVersion: voidedOperating.version,
        id: voidedOperating.id,
      })
    );

    // one consistent snapshot, as the repository requires
    const asReport = <T>(
      tenant: TenantFixture,
      operation: Parameters<typeof withTenantAs<T>>[3]
    ) =>
      withAuthorizedTenantTransaction(
        db,
        {
          authenticatedUserId: tenant.userId,
          capability: "report:read",
          isolationLevel: "repeatable read",
          requestedOrganizationId: tenant.organizationId,
        },
        operation
      );

    // ------------------------------- 1. the result, worked out by hand
    const result = await asReport(tenantA, (tx, identity) =>
      readPeriodResult(tx, identity, period)
    );
    assert.deepEqual(result, {
      anticipationFees: "0.00",
      cogs: "60.00",
      commercialSurcharges: "12.00",
      contributionMargin: "376.62",
      discounts: "22.00",
      estimatedOperatingResult: "136.62",
      grossProfit: "383.70",
      grossSales: "519.70",
      itemLines: 4,
      linkedExpenseCount: 1,
      linkedExpenses: "15.00",
      netSales: "443.70",
      operatingExpenseCount: 2,
      operatingExpenses: "240.00",
      processingFees: "4.08",
      returns: "54.00",
      salesCount: 3,
      unitsSold: 7,
      unknown: { anticipationFees: 0, costItems: 1, processingFees: 2 },
    });
    tests.push(
      "the period result matches the figures worked out by hand: gross 519.70, discounts 22.00, returns 54.00 (the discount share is given back), COGS 60.00 (the restocked unit is not consumed), a 4.08 processing fee from the snapshot, a linked delivery of 15.00, operating expenses 240.00 (200.00 with no sale plus the 40.00 delivery of the cancelled sale: the cost was real), estimated result 136.62; the cancelled sale itself, the voided expenses and the expenses outside the period count for nothing"
    );

    // the dashboard cards and the account of what is incomplete, on the same data
    assert.deepEqual(dashboardCards(result), {
      items: 7,
      marginPercent: "84.88",
      netSales: "443.70",
      operatingResult: "136.62",
      salesCount: 3,
      ticket: "147.90",
    });
    assert.deepEqual(resultQuality(result), {
      anticipationFeesUnknown: 0,
      itemLines: 4,
      itemLinesWithUnknownCost: 1,
      level: "partial",
      linkedExpenses: 1,
      missing: ["unknown_cost", "unknown_processing_fee"],
      operatingExpenses: 2,
      processingFeesUnknown: 2,
      salesCount: 3,
    });
    tests.push(
      "the dashboard cards (net sales 443.70, margin 84.88%, 3 sales, ticket 147.90, 7 items) and the quality account (one item without cost, two sales without a processing fee, expenses present, level partial) match the real data"
    );

    // -------------------- 2. independent SQL aggregates agree with the engine
    const oracle = await admin.pool.query<{
      cogs: string;
      discounts: string;
      gross: string;
      surcharges: string;
    }>(
      `SELECT
         COALESCE(sum(i.charged_unit_price * i.quantity), 0)::text AS gross,
         round(COALESCE(sum(i.unit_cost * i.quantity), 0), 2)::text AS cogs,
         COALESCE((SELECT sum(a.amount) FROM public.sale_adjustments a WHERE a.sale_id = ANY($2) AND a.kind = 'discount'), 0)::text AS discounts,
         COALESCE((SELECT sum(a.amount) FROM public.sale_adjustments a WHERE a.sale_id = ANY($2) AND a.kind <> 'discount'), 0)::text AS surcharges
       FROM public.sale_items i WHERE i.sale_id = ANY($2) AND i.organization_id = $1`,
      [tenantA.organizationId, [s1.sale.id, s2.sale.id, s3.sale.id]]
    );
    const [row] = oracle.rows;
    assert.ok(row);
    // exact decimal text, no floating point
    assert.equal(row.gross, result.grossSales);
    assert.equal(row.discounts, result.discounts);
    assert.equal(row.surcharges, result.commercialSurcharges);
    // all of S3's cost counts in the oracle; the engine gives back the restocked unit (10.00)
    assert.equal(
      (BigInt(row.cogs.replace(".", "")) - 1000n).toString(),
      result.cogs.replace(".", "")
    );
    tests.push(
      "independent SQL aggregates over the same rows agree with the engine (gross sales, discounts, surcharges and the cost before the restocked unit)"
    );

    // ----------------------------------------- 3. the facts, sale by sale
    const facts = await asReport(tenantA, (tx, identity) =>
      readPeriodFacts(tx, identity, period)
    );
    assert.equal(facts.sales.length, 4);
    assert.equal(facts.sales.filter((sale) => sale.cancelled).length, 1);
    const read1 = facts.sales.find(
      (sale) =>
        sale.items.length === 1 &&
        sale.adjustments.some((a) => a.kind === "freight")
    );
    assert.deepEqual(read1?.linkedExpenses, ["15.00"]);
    assert.equal(read1?.processingFee, "4.08");
    const read2 = facts.sales.find((sale) => sale.items.length === 2);
    assert.equal(
      read2?.processingFee,
      null,
      "no profile: the fee is unknown, not zero"
    );
    assert.equal(
      read2?.items.find((item) => item.unitCost === null) !== undefined,
      true,
      "the unknown cost stays null"
    );
    tests.push(
      "the read facts keep an unknown fee and an unknown cost as null (never zero), the linked expense on its sale and the cancellation"
    );

    // ----------------------------------------------- 4. periods and scoping
    const earlier = await asReport(tenantA, (tx, identity) =>
      readPeriodResult(tx, identity, {
        from: dateFrom(today, -30),
        to: dateFrom(today, -20),
      })
    );
    assert.equal(earlier.salesCount, 0);
    assert.equal(earlier.operatingExpenses, "25.00");
    assert.equal(earlier.estimatedOperatingResult, "-25.00");
    const other = await asReport(tenantB, (tx, identity) =>
      readPeriodResult(tx, identity, period)
    );
    assert.equal(other.salesCount, 0);
    assert.equal(other.operatingExpenses, "0.00");
    assert.equal(other.grossSales, "0.00");
    assert.equal(resultQuality(other).level, "no_data");
    assert.equal(
      resultQuality(earlier).level,
      "complete",
      "a period with only expenses is not missing anything"
    );
    tests.push(
      "a period without sales still carries its operating expenses (a negative result), and another organization sees none of it"
    );

    // ------------------------------------------- 5. guards on the input
    await assert.rejects(
      () =>
        as(tenantA, "report:read", (tx, identity) =>
          readPeriodResult(tx, identity, period)
        ),
      EconomicsSnapshotRequiredError,
      "read committed is refused: the period needs one snapshot"
    );
    await assert.rejects(
      () =>
        as(tenantA, "sale:read", (tx, identity) =>
          readPeriodResult(tx, identity, period)
        ),
      TenantAuthorizationError,
      "another capability is not enough"
    );
    for (const bad of [
      { from: today, to: dateFrom(today, -1) },
      { from: "2026-02-30", to: today },
      { from: dateFrom(today, -400), to: today },
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each probe is verified on its own
      await assert.rejects(
        () =>
          asReport(tenantA, (tx, identity) =>
            readPeriodResult(tx, identity, bad)
          ),
        InvalidEconomicsPeriodError,
        "an inverted, impossible or too long period"
      );
    }
    tests.push(
      "reading a period needs report:read and a repeatable-read snapshot, and an inverted, impossible or longer-than-366-days period is refused as invalid input"
    );

    // ---------------- 6. the daily series and the most sold products (D2)
    // a retroactive sale five days ago, of a product deleted afterwards
    const p3 = await createSellableProduct(rt, tenantA, "E-P3 excluído", {
      cost: "5.00",
      quantity: 1,
    });
    const s5 = await as(tenantA, "sale:create", (tx, identity) =>
      confirmSale(tx, identity, {
        adjustments: [],
        commandId: randomUUID(),
        commandVersion: 1,
        items: [
          {
            chargedUnitPrice: "45.00",
            listedUnitPrice: "45.00",
            quantity: 1,
            variantId: p3.variantId,
          },
        ],
        occurredAt: recentInstant(24 * 5),
        payment: { anticipationRequested: false, method: "pix" },
        paymentProfile: null,
        requestId: randomUUID(),
      })
    );
    await as(tenantA, "product:update", (tx, identity) =>
      deleteProduct(tx, identity, {
        expectedVersion: p3.version,
        id: p3.productId,
        requestId: randomUUID(),
      })
    );
    const s5Date = (
      await admin.pool.query<{ day: string }>(
        "SELECT to_char(occurred_on, 'YYYY-MM-DD') AS day FROM public.sales WHERE id = $1",
        [s5.sale.id]
      )
    ).rows[0]?.day;
    assert.ok(s5Date && s5Date < today && s5Date >= period.from);

    const summary = await asReport(tenantA, (tx, identity) =>
      readPeriodSummary(tx, identity, period, { topProducts: 10 })
    );
    const cents = (value: string) => BigInt(value.replace(".", ""));
    assert.equal(summary.daily.length, 8);
    assert.deepEqual(
      summary.daily.map((day) => day.date),
      Array.from({ length: 8 }, (_, index) => dateFrom(period.from, index))
    );
    assert.equal(
      summary.daily.reduce((total, day) => total + cents(day.netSales), 0n),
      cents(summary.result.netSales)
    );
    assert.equal(
      summary.daily.reduce((total, day) => total + day.salesCount, 0),
      summary.result.salesCount
    );
    assert.equal(summary.result.netSales, "488.70");
    assert.equal(summary.result.salesCount, 4);
    for (const day of summary.daily) {
      // biome-ignore lint/performance/noAwaitInLoops: each day is read as its own period
      const alone = await asReport(tenantA, (tx, identity) =>
        readPeriodResult(tx, identity, { from: day.date, to: day.date })
      );
      assert.equal(day.netSales, alone.netSales, `net sales of ${day.date}`);
      assert.equal(day.salesCount, alone.salesCount, `sales of ${day.date}`);
    }
    // worked out by hand: S5 (45.00) is the only sale five days ago (the others are hours old)
    assert.deepEqual(
      summary.daily.find((day) => day.date === s5Date),
      { date: s5Date, netSales: "45.00", salesCount: 1 }
    );
    // independent SQL: the count of not cancelled sales per commercial date
    const perDay = await admin.pool.query<{ day: string; sales: number }>(
      `SELECT to_char(s.occurred_on, 'YYYY-MM-DD') AS day, count(*)::int AS sales
         FROM public.sales s
        WHERE s.organization_id = $1 AND s.occurred_on BETWEEN $2::date AND $3::date
          AND NOT EXISTS (SELECT 1 FROM public.sale_cancellations c WHERE c.organization_id = s.organization_id AND c.sale_id = s.id)
        GROUP BY 1`,
      [tenantA.organizationId, period.from, period.to]
    );
    const oracleDays = new Map(
      perDay.rows.map((entry) => [entry.day, entry.sales])
    );
    for (const day of summary.daily) {
      assert.equal(day.salesCount, oracleDays.get(day.date) ?? 0);
    }
    tests.push(
      "the daily series has one entry per date of the period, adds up to the period's net sales (488.70) and sales (4), each day equals the period summary of that day alone (the cancelled sale is zero on its date, the return lowers the date of its sale, the retroactive sale sits on its commercial date), and an independent SQL count per date agrees"
    );

    assert.deepEqual(summary.topProducts, [
      {
        deleted: false,
        name: "Produto E-P1",
        netSales: "413.70",
        productId: p1.productId,
        quantity: 6,
      },
      {
        deleted: true,
        name: "Produto E-P3 excluído",
        netSales: "45.00",
        productId: p3.productId,
        quantity: 1,
      },
      {
        deleted: false,
        name: "Produto E-P2 sem custo",
        netSales: "30.00",
        productId: p2.productId,
        quantity: 1,
      },
    ]);
    assert.equal(
      summary.topProducts?.reduce((total, entry) => total + entry.quantity, 0),
      summary.result.unitsSold
    );
    assert.equal(
      summary.topProducts?.reduce(
        (total, entry) => total + cents(entry.netSales),
        0n
      ),
      cents(summary.result.netSales)
    );
    assert.equal(summary.reads.products, 3);
    assert.equal(summary.reads.sales, 5);
    tests.push(
      "the most sold products rank by units net of returns (P1 6, then the deleted P3 and P2 with 1 each, by net sales), carry the current name and say when the product was deleted, add up to the units sold and the net sales, and leave out the cancelled sale"
    );

    const two = await asReport(tenantA, (tx, identity) =>
      readPeriodSummary(tx, identity, period, { topProducts: 1 })
    );
    assert.deepEqual(
      two.topProducts?.map((entry) => entry.productId),
      [p1.productId]
    );
    const unranked = await asReport(tenantA, (tx, identity) =>
      readPeriodSummary(tx, identity, period)
    );
    assert.equal(unranked.topProducts, undefined);
    assert.equal(unranked.reads.products, 0);
    assert.deepEqual(unranked.daily, summary.daily);
    const otherSummary = await asReport(tenantB, (tx, identity) =>
      readPeriodSummary(tx, identity, period, { topProducts: 10 })
    );
    assert.deepEqual(otherSummary.topProducts, []);
    assert.ok(
      otherSummary.daily.every(
        (day) => day.netSales === "0.00" && day.salesCount === 0
      )
    );
    for (const topProducts of [0, 11, 1.5]) {
      // biome-ignore lint/performance/noAwaitInLoops: each probe is verified on its own
      await assert.rejects(
        () =>
          asReport(tenantA, (tx, identity) =>
            readPeriodSummary(tx, identity, period, { topProducts })
          ),
        InvalidTopProductsError
      );
    }
    await assert.rejects(
      () =>
        as(tenantA, "sale:read", (tx, identity) =>
          readPeriodSummary(tx, identity, period, { topProducts: 3 })
        ),
      TenantAuthorizationError
    );
    tests.push(
      "the ranking is cut at the limit and only when asked (without it no product is read), another organization sees an all-zero series and no product, a limit outside 1..10 is refused and another capability is not enough"
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
  console.error(`Economics PostgreSQL gate failed (${redactedFailure(error)})`);
  process.exitCode = 1;
});
