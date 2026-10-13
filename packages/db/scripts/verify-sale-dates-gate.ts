import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  calendarDateInTimeZone,
  SaleCommandConflictError,
  SaleOccurredInFutureError,
} from "@polaris/domain/sales/confirm-sale";
import { SaleOccurredTooOldError } from "@polaris/domain/sales/sale-dates";
import { createDatabase } from "../src/client";
import { getSale, listSales } from "../src/sale-query-repository";
import { confirmSale } from "../src/sale-repository";
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

const expectedDatabase = process.env.POLARIS_SALES_GATE_DATABASE ?? "neondb";
const minutes = 60_000;

type RuntimeDatabase = ReturnType<typeof createDatabase>;
type ErrorClass = abstract new (...args: never[]) => Error;

/** Shifts a `YYYY-MM-DD` calendar date by whole days. */
function shiftDay(day: string, days: number): string {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + days))
    .toISOString()
    .slice(0, 10);
}

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
    tests.push(
      "migrations 0000-0038 (and any later ones) were replayed from scratch"
    );

    const columns = await admin.pool.query<{
      column_name: string;
      is_nullable: string;
    }>(
      "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sales' AND column_name IN ('occurred_on', 'recorded_at', 'client_created_at')"
    );
    const byName = new Map(
      columns.rows.map((row) => [row.column_name, row.is_nullable])
    );
    assert.equal(byName.get("occurred_on"), "NO");
    assert.equal(byName.get("recorded_at"), "YES");
    assert.equal(byName.has("client_created_at"), false);
    tests.push(
      "sales has a mandatory occurred_on date and the device time is recorded_at (client_created_at is gone)"
    );

    const saoPaulo = "America/Sao_Paulo";
    const tokyo = "Asia/Tokyo";
    const tenantA = await createTenantFixture(admin.pool, "A", saoPaulo);
    const tenantTokyo = await createTenantFixture(admin.pool, "Tokyo", tokyo);
    const loginSuffix = randomUUID().replaceAll("-", "");
    loginRole = `polaris_dates_gate_${loginSuffix}`;
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

    // ---------------------------------------------------------------- helpers
    const sell = (
      tenant: TenantFixture,
      variantId: string,
      options: {
        commandId?: string;
        occurredAt: string;
        recordedAt?: string | null;
      }
    ) =>
      withTenantAs(
        runtimeDatabase.db,
        tenant,
        "sale:create",
        (transaction, identity) =>
          confirmSale(transaction, identity, {
            adjustments: [],
            commandId: options.commandId ?? randomUUID(),
            commandVersion: 1,
            items: [
              {
                chargedUnitPrice: "19.90",
                listedUnitPrice: "20.00",
                quantity: 1,
                variantId,
              },
            ],
            occurredAt: options.occurredAt,
            payment: { anticipationRequested: false, method: "pix" },
            paymentProfile: null,
            recordedAt: options.recordedAt ?? null,
            requestId: randomUUID(),
          })
      );

    const saleCount = async (tenant: TenantFixture) => {
      const result = await admin.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM public.sales WHERE organization_id = $1",
        [tenant.organizationId]
      );
      return Number(result.rows[0]?.count);
    };

    const stockOf = async (tenant: TenantFixture, variantId: string) => {
      const result = await admin.pool.query<{ quantity: number }>(
        "SELECT quantity FROM public.inventory_balances WHERE organization_id = $1 AND variant_id = $2",
        [tenant.organizationId, variantId]
      );
      return result.rows[0]?.quantity ?? 0;
    };

    const movementDates = async (tenant: TenantFixture, commandId: string) => {
      const result = await admin.pool.query<{ occurred_on: string }>(
        "SELECT occurred_on::text FROM public.stock_movements WHERE organization_id = $1 AND command_id = $2 ORDER BY command_index",
        [tenant.organizationId, commandId]
      );
      return result.rows.map((row) => row.occurred_on);
    };

    const storedHeader = async (tenant: TenantFixture, saleId: string) => {
      const result = await admin.pool.query<{
        confirmed_at: Date;
        occurred_at: Date;
        occurred_on: string;
        recorded_at: Date | null;
      }>(
        "SELECT confirmed_at, occurred_at, occurred_on::text, recorded_at FROM public.sales WHERE organization_id = $1 AND id = $2",
        [tenant.organizationId, saleId]
      );
      const [row] = result.rows;
      assert.ok(row);
      return row;
    };

    async function expectRejectedWithoutEffects(
      tenant: TenantFixture,
      variantId: string,
      options: { occurredAt: string },
      expected: ErrorClass,
      label: string
    ) {
      const salesBefore = await saleCount(tenant);
      const stockBefore = await stockOf(tenant, variantId);
      await assert.rejects(
        () => sell(tenant, variantId, options),
        expected,
        label
      );
      assert.equal(await saleCount(tenant), salesBefore, `${label}: no sale`);
      assert.equal(
        await stockOf(tenant, variantId),
        stockBefore,
        `${label}: stock unchanged`
      );
    }

    // --------------------------------------------------------------- fixtures
    const productA = await createSellableProduct(rt, tenantA, "datas", {
      cost: "10.00",
      quantity: 100,
    });
    const productTokyo = await createSellableProduct(rt, tenantTokyo, "datas", {
      cost: "10.00",
      quantity: 100,
    });
    const today = calendarDateInTimeZone(new Date(), saoPaulo);
    const todayTokyo = calendarDateInTimeZone(new Date(), tokyo);

    // ------------------------------- 1. the commercial date and its evidence
    const beforeSale = Date.now();
    const plain = await sell(tenantA, productA.variantId, {
      occurredAt: new Date(Date.now() - 2 * 60 * minutes).toISOString(),
    });
    const afterSale = Date.now();
    assert.equal(plain.sale.recordedAt, null);
    assert.ok(plain.sale.confirmedAt.getTime() >= beforeSale - 1000);
    assert.ok(plain.sale.confirmedAt.getTime() <= afterSale + 1000);
    assert.equal(
      plain.sale.occurredOn,
      calendarDateInTimeZone(plain.sale.occurredAt, saoPaulo)
    );
    const deviceTime = new Date(Date.now() - 3 * 60 * minutes).toISOString();
    const withEvidence = await sell(tenantA, productA.variantId, {
      occurredAt: new Date(Date.now() - 60 * minutes).toISOString(),
      recordedAt: deviceTime,
    });
    assert.equal(withEvidence.sale.recordedAt?.toISOString(), deviceTime);
    const evidenceRow = await storedHeader(tenantA, withEvidence.sale.id);
    assert.equal(evidenceRow.recorded_at?.toISOString(), deviceTime);
    assert.notEqual(
      evidenceRow.recorded_at?.getTime(),
      evidenceRow.confirmed_at.getTime(),
      "the device time is evidence only; the server clock confirms"
    );
    assert.ok(
      withEvidence.sale.confirmedAt.getTime() >=
        plain.sale.confirmedAt.getTime(),
      "confirmation time never goes backwards between sequential sales"
    );
    const detail = await withTenantAs(
      runtimeDatabase.db,
      tenantA,
      "sale:read",
      (transaction, identity) =>
        getSale(transaction, identity, withEvidence.sale.id)
    );
    assert.equal(detail.sale.sale.occurredOn, withEvidence.sale.occurredOn);
    assert.equal(
      detail.sale.sale.recordedAt?.toISOString(),
      deviceTime,
      "the read model returns the stored dates"
    );
    tests.push(
      "a sale stores the commercial instant, the commercial date in the organization's calendar, the optional device time as evidence only, and the server-clock confirmation time (never before an earlier sale's)"
    );

    // ------------------------------ 2. the retroactive window (30 days, BRT)
    const edge = shiftDay(today, -30);
    const tooOld = shiftDay(today, -31);
    const atEdge = await sell(tenantA, productA.variantId, {
      occurredAt: `${edge}T12:00:00-03:00`,
    });
    assert.equal(atEdge.sale.occurredOn, edge);
    assert.deepEqual(await movementDates(tenantA, atEdge.sale.commandId), [
      edge,
    ]);
    await expectRejectedWithoutEffects(
      tenantA,
      productA.variantId,
      { occurredAt: `${tooOld}T23:59:00-03:00` },
      SaleOccurredTooOldError,
      "the previous local date is outside the 30-day window"
    );
    await expectRejectedWithoutEffects(
      tenantA,
      productA.variantId,
      { occurredAt: "2020-01-01T12:00:00-03:00" },
      SaleOccurredTooOldError,
      "a sale from years ago is outside the window"
    );
    // the same instant, one second apart, falls on either side of local midnight
    const lastSecondOfTooOld = `${tooOld}T23:59:59-03:00`;
    const firstSecondOfEdge = `${edge}T00:00:00-03:00`;
    await expectRejectedWithoutEffects(
      tenantA,
      productA.variantId,
      { occurredAt: lastSecondOfTooOld },
      SaleOccurredTooOldError,
      "23:59:59 of the 31st day back is refused"
    );
    const firstSecond = await sell(tenantA, productA.variantId, {
      occurredAt: firstSecondOfEdge,
    });
    assert.equal(firstSecond.sale.occurredOn, edge);
    tests.push(
      "the sale 30 calendar days back is accepted down to its first second and the one before it (31 days) is refused with no sale, movement, or stock change"
    );

    // ------------------- 3. the stock ledger follows the commercial date
    const retro = await sell(tenantA, productA.variantId, {
      occurredAt: `${shiftDay(today, -10)}T10:00:00-03:00`,
    });
    assert.equal(retro.sale.occurredOn, shiftDay(today, -10));
    assert.deepEqual(await movementDates(tenantA, retro.sale.commandId), [
      shiftDay(today, -10),
    ]);
    const lateNight = await sell(tenantA, productA.variantId, {
      occurredAt: `${shiftDay(today, -3)}T22:30:00-03:00`,
    });
    // 22:30 in Sao Paulo is already the next day in UTC: the date is the organization's
    assert.equal(
      lateNight.sale.occurredAt.toISOString().slice(0, 10),
      shiftDay(today, -2)
    );
    assert.equal(lateNight.sale.occurredOn, shiftDay(today, -3));
    assert.deepEqual(await movementDates(tenantA, lateNight.sale.commandId), [
      shiftDay(today, -3),
    ]);
    tests.push(
      "the ledger movement date equals the sale's commercial date in the organization's calendar, not the confirmation day and not the UTC date"
    );

    // ------------------------------------ 4. the organization's time zone
    const tokyoEdge = await sell(tenantTokyo, productTokyo.variantId, {
      occurredAt: `${shiftDay(todayTokyo, -30)}T00:30:00+09:00`,
    });
    assert.equal(tokyoEdge.sale.occurredOn, shiftDay(todayTokyo, -30));
    await expectRejectedWithoutEffects(
      tenantTokyo,
      productTokyo.variantId,
      { occurredAt: `${shiftDay(todayTokyo, -31)}T23:30:00+09:00` },
      SaleOccurredTooOldError,
      "Tokyo counts the window in Tokyo's calendar"
    );
    // one instant, two organizations, two commercial dates
    const sharedInstant = `${shiftDay(todayTokyo, -2)}T00:30:00+09:00`;
    const inTokyo = await sell(tenantTokyo, productTokyo.variantId, {
      occurredAt: sharedInstant,
    });
    const inSaoPaulo = await sell(tenantA, productA.variantId, {
      occurredAt: sharedInstant,
    });
    assert.equal(inTokyo.sale.occurredOn, shiftDay(todayTokyo, -2));
    assert.equal(inSaoPaulo.sale.occurredOn, shiftDay(todayTokyo, -3));
    tests.push(
      "the retroactive window and the commercial date follow each organization's own time zone: the same instant is one calendar day apart in Tokyo and Sao Paulo"
    );

    // --------------------------------------- 5. the future tolerance (5 min)
    await expectRejectedWithoutEffects(
      tenantA,
      productA.variantId,
      { occurredAt: new Date(Date.now() + 10 * minutes).toISOString() },
      SaleOccurredInFutureError,
      "ten minutes ahead of the server clock is refused"
    );
    await expectRejectedWithoutEffects(
      tenantA,
      productA.variantId,
      { occurredAt: "2099-01-01T00:00:00Z" },
      SaleOccurredInFutureError,
      "a date in the far future is refused"
    );
    const skewed = await sell(tenantA, productA.variantId, {
      occurredAt: new Date(Date.now() + 3 * minutes).toISOString(),
    });
    assert.equal(
      skewed.sale.occurredOn,
      calendarDateInTimeZone(skewed.sale.occurredAt, saoPaulo)
    );
    tests.push(
      "a commercial time up to 5 minutes ahead (device clock skew) is accepted and anything later is refused without effects"
    );

    // --------------------- 6. replay keeps working and compares the new field
    const replayCommand = randomUUID();
    const original = await sell(tenantA, productA.variantId, {
      commandId: replayCommand,
      occurredAt: `${shiftDay(today, -5)}T09:00:00-03:00`,
      recordedAt: deviceTime,
    });
    const salesBeforeReplay = await saleCount(tenantA);
    const stockBeforeReplay = await stockOf(tenantA, productA.variantId);
    const replay = await sell(tenantA, productA.variantId, {
      commandId: replayCommand,
      occurredAt: `${shiftDay(today, -5)}T09:00:00-03:00`,
      recordedAt: deviceTime,
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.sale.id, original.sale.id);
    assert.equal(replay.sale.occurredOn, original.sale.occurredOn);
    assert.equal(
      replay.sale.confirmedAt.getTime(),
      original.sale.confirmedAt.getTime()
    );
    assert.equal(await saleCount(tenantA), salesBeforeReplay);
    assert.equal(await stockOf(tenantA, productA.variantId), stockBeforeReplay);
    for (const [label, changed] of [
      [
        "a different commercial time",
        {
          occurredAt: `${shiftDay(today, -5)}T10:00:00-03:00`,
          recordedAt: deviceTime,
        },
      ],
      [
        "a different device time",
        {
          occurredAt: `${shiftDay(today, -5)}T09:00:00-03:00`,
          recordedAt: new Date(Date.now() - 4 * 60 * minutes).toISOString(),
        },
      ],
      [
        "no device time",
        {
          occurredAt: `${shiftDay(today, -5)}T09:00:00-03:00`,
          recordedAt: null,
        },
      ],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: each conflicting replay is checked against the same committed sale in turn
      await assert.rejects(
        () =>
          sell(tenantA, productA.variantId, {
            commandId: replayCommand,
            ...changed,
          }),
        SaleCommandConflictError,
        `same command with ${label} conflicts`
      );
    }
    assert.equal(await saleCount(tenantA), salesBeforeReplay);
    tests.push(
      "repeating a command replays the stored sale (same date, same confirmation time, no new rows or stock) and a different commercial or device time is a conflict"
    );

    // ----------------- 6b. replay of a sale that has left the retroactive window
    const agedCommand = randomUUID();
    const agedAt = `${shiftDay(today, -29)}T09:00:00-03:00`;
    const aged = await sell(tenantA, productA.variantId, {
      commandId: agedCommand,
      occurredAt: agedAt,
    });
    const sixtyDaysBack = shiftDay(today, -60);
    // Age the committed sale as an operator with table ownership would see it
    // after the calendar moved on; the runtime role itself can never do this.
    await admin.pool.query("ALTER TABLE public.sales DISABLE TRIGGER USER");
    try {
      await admin.pool.query(
        "UPDATE public.sales SET occurred_at = $3::timestamptz, occurred_on = $4::date WHERE organization_id = $1 AND id = $2",
        [
          tenantA.organizationId,
          aged.sale.id,
          `${sixtyDaysBack}T12:00:00Z`,
          sixtyDaysBack,
        ]
      );
    } finally {
      await admin.pool.query("ALTER TABLE public.sales ENABLE TRIGGER USER");
    }
    const agedReplay = await sell(tenantA, productA.variantId, {
      commandId: agedCommand,
      occurredAt: `${sixtyDaysBack}T12:00:00Z`,
    });
    assert.equal(
      agedReplay.replayed,
      true,
      "the stored sale is replayed even though it is now older than the window"
    );
    assert.equal(agedReplay.sale.id, aged.sale.id);
    await assert.rejects(
      () =>
        sell(tenantA, productA.variantId, {
          commandId: agedCommand,
          occurredAt: `${sixtyDaysBack}T13:00:00Z`,
        }),
      SaleCommandConflictError,
      "a different instant on the old command is a conflict, not a window error"
    );
    await expectRejectedWithoutEffects(
      tenantA,
      productA.variantId,
      { occurredAt: `${sixtyDaysBack}T09:00:00+00:00` },
      SaleOccurredTooOldError,
      "the same instant as a NEW command is outside the window"
    );
    tests.push(
      "a command that already exists is answered by the replay logic even when its sale is now older than the window, while a new command at that instant is refused"
    );

    // -------- 6c. the 0038 backfill expression equals what the server stores
    const backfill = await admin.pool.query<{ checked: string; wrong: string }>(
      `SELECT count(*)::text AS checked,
              count(*) FILTER (WHERE (sale.occurred_at AT TIME ZONE organization.timezone)::date <> sale.occurred_on)::text AS wrong
       FROM public.sales AS sale
       JOIN public.organizations AS organization ON organization.id = sale.organization_id
       WHERE sale.organization_id IN ($1, $2) AND sale.id <> $3`,
      [tenantA.organizationId, tenantTokyo.organizationId, aged.sale.id]
    );
    assert.ok(
      Number(backfill.rows[0]?.checked) > 5,
      "the migration role sees organizations through FORCE RLS, so the backfill join finds the sales"
    );
    assert.equal(
      backfill.rows[0]?.wrong,
      "0",
      "the backfill expression gives the same commercial date as the application for São Paulo and Tokyo sales"
    );
    tests.push(
      "the organization-calendar date of an instant (the expression the 0038 backfill used) equals the date the application stores, in two time zones, and the migration role can read organizations to apply it"
    );
    // ------------------------------------------------- 7. database guards
    await assert.rejects(
      () =>
        admin.pool.query(
          "INSERT INTO public.sales (organization_id, command_id, occurred_at, item_count, adjustment_count) VALUES ($1, $2, now(), 1, 0)",
          [tenantA.organizationId, randomUUID()]
        ),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23502",
      "a sale without its commercial date is refused by the schema"
    );
    const listed = await withTenantAs(
      runtimeDatabase.db,
      tenantA,
      "sale:read",
      (transaction, identity) => listSales(transaction, identity, { limit: 50 })
    );
    assert.ok(listed.sales.length > 0);
    tests.push(
      "the schema refuses a sale without occurred_on, and the sale list still reads every dated sale"
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
    `Sale dates PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
