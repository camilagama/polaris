import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  GoalLimitReachedError,
  GoalNotActiveError,
  GoalNotFoundError,
  GoalPeriodEndedError,
  GoalVersionConflictError,
  InvalidGoalError,
} from "@polaris/domain/goals/goal";
import { createDatabase } from "../src/client";
import {
  cancelGoal,
  createGoal,
  evaluateActiveGoals,
  listGoals,
  listGoalTargetChanges,
  settleGoals,
  updateGoal,
} from "../src/goal-repository";
import { createSaleReturn } from "../src/sale-return-repository";
import {
  TenantAuthorizationError,
  withAuthorizedTenantTransaction,
} from "../src/tenant-transaction";
import {
  confirmPlainSale,
  createSellableProduct,
  createTenantFixture,
  disposableHostPattern,
  expectSqlState,
  gateBranchPattern,
  journalMigrationCount,
  poolerPattern,
  redactedFailure,
  requiredEnvironment,
  runtimeRole,
  type TenantFixture,
  temporaryRuntimeUrl,
  withRuntimeSqlContext,
  withTenantAs,
} from "./sales-gate-support";

/**
 * Goals (plan PR70) on a real PostgreSQL 18: a goal for a period measured by net
 * sales, the estimated result or the number of sales, with progress derived from
 * the period result; completion that never reopens by itself; a missed period;
 * every target change kept; and the defences of the database itself.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

type ErrorClass = abstract new (...args: never[]) => Error;

async function expectRejects(
  operation: () => Promise<unknown>,
  expected: ErrorClass,
  label: string
) {
  await assert.rejects(
    operation,
    (error: unknown) => {
      assert.ok(error instanceof expected, `${label}: got ${String(error)}`);
      return true;
    },
    label
  );
}

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
      "goals A"
    );
    const tenantB: TenantFixture = await createTenantFixture(
      admin.pool,
      "goals B"
    );
    // this gate tests the goals themselves and the technical ceiling of 20: the plan limit
    // (1 on Free, 3 on Pro) is raised for its tenants and has its own gate
    await admin.pool.query(
      `INSERT INTO public.entitlement_grants (organization_id, key, limit_value, reason, granted_by, expires_at)
       SELECT id, 'goals.active.max', 25, 'goals gate', 'gate', now() + interval '1 day' FROM public.organizations WHERE id = ANY($1)`,
      [[tenantA.organizationId, tenantB.organizationId]]
    );
    loginRole = `polaris_goals_gate_${randomUUID().replaceAll("-", "")}`;
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
    const asGoals = <T>(
      tenant: TenantFixture,
      operation: Parameters<typeof withTenantAs<T>>[3]
    ) => withTenantAs(db, tenant, "goal:manage", operation);
    /** The economics are read in one repeatable-read snapshot. */
    const evaluate = (tenant: TenantFixture) =>
      withAuthorizedTenantTransaction(
        db,
        {
          authenticatedUserId: tenant.userId,
          capability: "goal:manage",
          isolationLevel: "repeatable read",
          requestedOrganizationId: tenant.organizationId,
        },
        (tx, identity) => evaluateActiveGoals(tx, identity)
      );
    /** What the handler does: evaluate in a snapshot, then settle in a short transaction. */
    const refresh = async (tenant: TenantFixture) => {
      const progress = await evaluate(tenant);
      const applied = await asGoals(tenant, (tx, identity) =>
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
      return { applied, progress };
    };
    const today = (
      await admin.pool.query<{ today: string }>(
        "SELECT to_char((now() AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD') AS today"
      )
    ).rows[0]?.today as string;

    // ------------------------------------------------- the data: three sales
    const product = await createSellableProduct(rt, tenantA, "G-P1", {
      cost: "10.00",
      quantity: 50,
    });
    const sellOne = () =>
      confirmPlainSale(rt, tenantA, [
        {
          chargedUnitPrice: "150.00",
          quantity: 1,
          variantId: product.variantId,
        },
      ]);
    const firstSale = await sellOne();
    await sellOne();
    await sellOne();
    // net sales of the week: 450.00 over 3 sales

    // ------------------------------------------------------------ 1. creating
    const create = (
      kind: string,
      target: string,
      startsOn: string,
      endsOn: string,
      name?: string
    ) =>
      asGoals(tenantA, (tx, identity) =>
        createGoal(tx, identity, {
          endsOn,
          kind,
          name: name ?? null,
          requestId: randomUUID(),
          startsOn,
          target,
        })
      );
    const reachable = await create(
      "net_sales",
      "400",
      dateFrom(today, -7),
      dateFrom(today, 10),
      "Vendas da semana"
    );
    const slow = await create(
      "sale_count",
      "10",
      dateFrom(today, -7),
      dateFrom(today, 10)
    );
    const past = await create(
      "operating_result",
      "5000",
      dateFrom(today, -40),
      dateFrom(today, -30)
    );
    // an operating-result goal is settled only when its period has ended
    const opGoal = await create(
      "operating_result",
      "100",
      dateFrom(today, -7),
      dateFrom(today, 10)
    );
    // a period that ended yesterday and was not read yet
    const ended = await create(
      "sale_count",
      "50",
      dateFrom(today, -5),
      dateFrom(today, -1)
    );
    await expectRejects(
      () =>
        asGoals(tenantA, (tx, identity) =>
          updateGoal(tx, identity, {
            expectedVersion: ended.version,
            id: ended.id,
            target: "60",
          })
        ),
      GoalPeriodEndedError,
      "a goal whose period ended is settled by the next read, not edited"
    );
    const future = await create(
      "net_sales",
      "100",
      dateFrom(today, 1),
      dateFrom(today, 20)
    );
    assert.equal(reachable.target, "400.00");
    assert.equal(slow.target, "10");
    assert.equal(reachable.status, "active");
    for (const [label, args] of [
      ["unknown kind", ["profit", "100", today, today]],
      ["zero target", ["net_sales", "0", today, today]],
      ["fractional count", ["sale_count", "1.5", today, today]],
      ["end before start", ["net_sales", "100", today, dateFrom(today, -1)]],
      [
        "longer than 366 days",
        ["net_sales", "100", dateFrom(today, -10), dateFrom(today, 400)],
      ],
      ["start before 2000", ["net_sales", "100", "1999-12-31", "2000-01-10"]],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: each probe is verified on its own
      await expectRejects(
        () => create(args[0], args[1], args[2], args[3]),
        InvalidGoalError,
        label
      );
    }
    tests.push(
      "goals of the three kinds are created with exact targets (money with two places, a count whole); an unknown kind, a zero or fractional target, an inverted or too long period and a start before 2000 are refused"
    );

    // -------------------------------- 2. progress, completion and the missed
    const first = await refresh(tenantA);
    const byId = new Map(first.progress.map((entry) => [entry.goalId, entry]));
    assert.equal(byId.get(reachable.id)?.evaluation.progress, "450.00");
    assert.equal(byId.get(reachable.id)?.evaluation.reached, true);
    assert.equal(byId.get(slow.id)?.evaluation.progress, "3");
    assert.equal(byId.get(slow.id)?.settlement, null);
    assert.equal(byId.get(past.id)?.settlement, "missed");
    assert.equal(
      byId.get(future.id)?.evaluation.progress,
      "0.00",
      "a goal that has not started measures nothing"
    );
    assert.equal(byId.get(future.id)?.settlement, null);
    assert.equal(byId.get(opGoal.id)?.evaluation.reached, true);
    assert.equal(
      byId.get(opGoal.id)?.settlement,
      null,
      "reached mid-period, but an operating result settles only when the period closes"
    );
    assert.equal(byId.get(ended.id)?.settlement, "missed");
    assert.deepEqual(
      [...first.applied].sort(),
      [reachable.id, past.id, ended.id].sort()
    );
    const settled = await asGoals(tenantA, (tx, identity) =>
      listGoals(tx, identity)
    );
    const status = (id: string) => settled.find((goal) => goal.id === id);
    assert.equal(status(reachable.id)?.status, "completed");
    assert.equal(status(reachable.id)?.achievedValue, "450.00");
    assert.notEqual(status(reachable.id)?.settledAt, null);
    assert.equal(status(past.id)?.status, "missed");
    assert.equal(status(slow.id)?.status, "active");
    assert.equal(status(future.id)?.status, "active");
    tests.push(
      "a goal completes as soon as its target is reached (net sales 450.00 over 400.00, recording the achieved value), one whose period ended without it is missed, one that is short stays active and one that has not started measures nothing"
    );

    // ------------------------------------------- 3. settling is idempotent
    const again = await refresh(tenantA);
    assert.deepEqual(again.applied, []);
    assert.equal(
      again.progress.some((entry) => entry.goalId === reachable.id),
      false,
      "settled goals are not evaluated again"
    );
    // two concurrent settlements of the same goal apply it once
    const hot = await create(
      "sale_count",
      "1",
      dateFrom(today, -7),
      dateFrom(today, 10)
    );
    const hotProgress = (await evaluate(tenantA)).find(
      (entry) => entry.goalId === hot.id
    );
    assert.equal(hotProgress?.settlement, "completed");
    const settleHot = () =>
      asGoals(tenantA, (tx, identity) =>
        settleGoals(tx, identity, [
          {
            achievedValue: "3",
            expectedVersion: hot.version,
            goalId: hot.id,
            settlement: "completed",
          },
        ])
      );
    const raced = await Promise.all([settleHot(), settleHot(), settleHot()]);
    assert.equal(raced.flat().length, 1, "exactly one settlement wins");
    assert.equal(
      (
        await asGoals(tenantA, (tx, identity) =>
          listGoals(tx, identity, { status: "completed" })
        )
      ).length,
      2
    );
    tests.push(
      "settling is idempotent and safe under concurrency: a settled goal is not evaluated again and three simultaneous settlements of one goal apply once"
    );

    // ----------------- 4. a completed goal never reopens when the numbers fall
    await withTenantAs(db, tenantA, "sale:return", (tx, identity) =>
      createSaleReturn(tx, identity, {
        commandId: randomUUID(),
        commandVersion: 1,
        items: [{ position: 0, restockedQuantity: 1, returnedQuantity: 1 }],
        saleId: firstSale.sale.id,
      })
    );
    const afterReturn = await refresh(tenantA);
    assert.equal(
      afterReturn.progress.some((entry) => entry.goalId === reachable.id),
      false
    );
    const stillDone = (
      await asGoals(tenantA, (tx, identity) => listGoals(tx, identity))
    ).find((goal) => goal.id === reachable.id);
    assert.equal(
      stillDone?.status,
      "completed",
      "net sales fell to 300.00 but the goal stays completed"
    );
    assert.equal(stillDone?.achievedValue, "450.00");
    await expectRejects(
      () =>
        asGoals(tenantA, (tx, identity) =>
          updateGoal(tx, identity, {
            expectedVersion: stillDone?.version as number,
            id: reachable.id,
            target: "10",
          })
        ),
      GoalNotActiveError,
      "a completed goal is read-only"
    );
    tests.push(
      "a completed goal stays completed (with its achieved value) when a later return drops net sales below the target, and it is read-only"
    );

    // ---------------------------- 5. changing the target is kept and audited
    const edited = await asGoals(tenantA, (tx, identity) =>
      updateGoal(tx, identity, {
        expectedVersion: slow.version,
        id: slow.id,
        requestId: randomUUID(),
        target: "5",
      })
    );
    assert.equal(edited.changed, true);
    assert.equal(edited.goal.target, "5");
    assert.equal(edited.goal.version, 2);
    const unchanged = await asGoals(tenantA, (tx, identity) =>
      updateGoal(tx, identity, { expectedVersion: 2, id: slow.id, target: "5" })
    );
    assert.equal(unchanged.changed, false);
    const renamed = await asGoals(tenantA, (tx, identity) =>
      updateGoal(tx, identity, {
        expectedVersion: 2,
        id: slow.id,
        name: "  Meta de vendas  ",
      })
    );
    assert.equal(renamed.goal.name, "Meta de vendas");
    assert.equal(renamed.goal.version, 3);
    const history = await asGoals(tenantA, (tx, identity) =>
      listGoalTargetChanges(tx, identity, slow.id)
    );
    assert.deepEqual(
      history.map((change) => [change.previousTarget, change.newTarget]),
      [["10", "5"]],
      "the change is kept with its previous and new value, once"
    );
    await expectRejects(
      () =>
        asGoals(tenantA, (tx, identity) =>
          updateGoal(tx, identity, {
            expectedVersion: 1,
            id: slow.id,
            target: "7",
          })
        ),
      GoalVersionConflictError,
      "a stale version"
    );
    await expectRejects(
      () =>
        asGoals(tenantA, (tx, identity) =>
          updateGoal(tx, identity, {
            expectedVersion: 3,
            id: slow.id,
            target: "0",
          })
        ),
      InvalidGoalError,
      "a zero target"
    );
    tests.push(
      "an active goal's target can change: each change is kept (previous and new value, once), an identical change leaves nothing, a stale version or a zero target is refused"
    );

    // ----- 6. a settlement computed before an edit is not applied after it
    const racing = await create(
      "sale_count",
      "9",
      dateFrom(today, -7),
      dateFrom(today, 10)
    );
    await asGoals(tenantA, (tx, identity) =>
      updateGoal(tx, identity, {
        expectedVersion: racing.version,
        id: racing.id,
        target: "2",
      })
    );
    const skipped = await asGoals(tenantA, (tx, identity) =>
      settleGoals(tx, identity, [
        {
          achievedValue: "3",
          expectedVersion: racing.version,
          goalId: racing.id,
          settlement: "completed",
        },
      ])
    );
    assert.deepEqual(skipped, [], "a stale settlement is skipped");
    const next = await refresh(tenantA);
    assert.ok(
      next.applied.includes(racing.id),
      "the next read evaluates it at the new target and completes it"
    );
    tests.push(
      "a settlement evaluated at an old version is skipped after the target changed, and the next read completes the goal at the new target"
    );

    // ------------------------------------------------------- 7. cancelling
    const cancelled = await asGoals(tenantA, (tx, identity) =>
      cancelGoal(tx, identity, {
        expectedVersion: future.version,
        id: future.id,
      })
    );
    assert.equal(cancelled.goal.status, "cancelled");
    const cancelledAgain = await asGoals(tenantA, (tx, identity) =>
      cancelGoal(tx, identity, {
        expectedVersion: cancelled.goal.version,
        id: future.id,
      })
    );
    assert.equal(cancelledAgain.changed, false);
    await expectRejects(
      () =>
        asGoals(tenantA, (tx, identity) =>
          updateGoal(tx, identity, {
            expectedVersion: cancelled.goal.version,
            id: future.id,
            target: "200",
          })
        ),
      GoalNotActiveError,
      "a cancelled goal is read-only"
    );
    await expectRejects(
      () =>
        asGoals(tenantA, (tx, identity) =>
          cancelGoal(tx, identity, { expectedVersion: 1, id: reachable.id })
        ),
      GoalVersionConflictError,
      "a stale version"
    );
    tests.push(
      "an active goal can be cancelled (repeating changes nothing) and a cancelled one is final and read-only"
    );

    // the number of active goals is bounded
    let guard = 0;
    for (;;) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: created in order
        await create(
          "sale_count",
          "99",
          dateFrom(today, 1),
          dateFrom(today, 5)
        );
      } catch (error) {
        assert.ok(error instanceof GoalLimitReachedError, String(error));
        break;
      }
      guard += 1;
      assert.ok(guard < 25, "the limit must stop the creation");
    }
    assert.equal(
      (
        await asGoals(tenantA, (tx, identity) =>
          listGoals(tx, identity, { status: "active" })
        )
      ).length,
      20
    );
    tests.push(
      "an operating-result goal reached mid-period is not settled until the period closes, a goal whose period ended cannot be edited and is missed by the next read, and an organization is limited to 20 active goals"
    );

    // ------------------------------ 8. isolation, capabilities and the database
    await expectRejects(
      () =>
        asGoals(tenantB, (tx, identity) =>
          cancelGoal(tx, identity, { expectedVersion: 1, id: slow.id })
        ),
      GoalNotFoundError,
      "another organization's goal"
    );
    assert.equal(
      (await asGoals(tenantB, (tx, identity) => listGoals(tx, identity)))
        .length,
      0
    );
    await expectRejects(
      () =>
        withTenantAs(db, tenantA, "report:read", (tx, identity) =>
          listGoals(tx, identity)
        ),
      TenantAuthorizationError,
      "report:read does not manage goals"
    );
    for (const [label, statement, params, state] of [
      [
        "an unknown kind",
        "INSERT INTO public.goals (organization_id, kind, target, starts_on, ends_on) VALUES ($1, 'profit', 1, '2026-10-01', '2026-10-31')",
        [tenantA.organizationId],
        "23514",
      ],
      [
        "a fractional count target",
        "INSERT INTO public.goals (organization_id, kind, target, starts_on, ends_on) VALUES ($1, 'sale_count', 1.5, '2026-10-01', '2026-10-31')",
        [tenantA.organizationId],
        "23514",
      ],
      [
        "a money target with three places",
        "INSERT INTO public.goals (organization_id, kind, target, starts_on, ends_on) VALUES ($1, 'net_sales', 1.005, '2026-10-01', '2026-10-31')",
        [tenantA.organizationId],
        "23514",
      ],
      [
        "a period of 367 days",
        "INSERT INTO public.goals (organization_id, kind, target, starts_on, ends_on) VALUES ($1, 'net_sales', 1, '2026-01-01', '2027-01-02')",
        [tenantA.organizationId],
        "23514",
      ],
      [
        "a goal completed without a settlement",
        "INSERT INTO public.goals (organization_id, kind, target, starts_on, ends_on, status) VALUES ($1, 'net_sales', 1, '2026-10-01', '2026-10-31', 'completed')",
        [tenantA.organizationId],
        "23514",
      ],
      [
        "an active goal with an achieved value",
        "INSERT INTO public.goals (organization_id, kind, target, starts_on, ends_on, achieved_value) VALUES ($1, 'net_sales', 1, '2026-10-01', '2026-10-31', 5)",
        [tenantA.organizationId],
        "23514",
      ],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: each probe is verified before the next one starts
      await expectSqlState(
        () =>
          withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
            client.query(statement, [...params])
          ),
        state,
        `the database refuses ${label}`
      );
    }
    await expectSqlState(
      () =>
        withRuntimeSqlContext(runtimeUrl, tenantB, (client) =>
          client.query(
            "INSERT INTO public.goals (organization_id, kind, target, starts_on, ends_on) VALUES ($1, 'net_sales', 1, '2026-10-01', '2026-10-31')",
            [tenantA.organizationId]
          )
        ),
      "42501",
      "RLS refuses a goal for an organization that is not the current one"
    );
    for (const [label, statement] of [
      ["kind", "UPDATE public.goals SET kind = 'net_sales'"],
      ["starts_on", "UPDATE public.goals SET starts_on = starts_on"],
      [
        "organization_id",
        "UPDATE public.goals SET organization_id = organization_id",
      ],
      ["id", "UPDATE public.goals SET id = gen_random_uuid()"],
      ["DELETE goals", "DELETE FROM public.goals"],
      [
        "history UPDATE",
        "UPDATE public.goal_target_changes SET new_target = 1",
      ],
      ["history DELETE", "DELETE FROM public.goal_target_changes"],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: each probe is verified before the next one starts
      await expectSqlState(
        () =>
          withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
            client.query(statement)
          ),
        "42501",
        `the runtime role cannot touch ${label}`
      );
    }
    tests.push(
      "another organization cannot see or change these goals, report:read does not manage them, PostgreSQL itself refuses an unknown kind, a fractional count, a three-place money target, a 367-day period and an incoherent settlement, and the runtime role can neither rewrite a goal's kind, period or identity nor delete a goal or touch its target history"
    );

    // ------------------------------------------------------------ 9. audit
    const audit = await admin.pool.query<{ event_type: string; n: string }>(
      `SELECT event_type, count(*)::text AS n FROM public.tenant_audit_event
        WHERE organization_id = $1 AND entity_type = 'goal'
        GROUP BY event_type`,
      [tenantA.organizationId]
    );
    const counts = new Map(
      audit.rows.map((row) => [row.event_type, Number(row.n)])
    );
    for (const eventType of [
      "goal.created",
      "goal.completed",
      "goal.missed",
      "goal.target_changed",
      "goal.updated",
      "goal.cancelled",
    ]) {
      assert.ok((counts.get(eventType) ?? 0) >= 1, `audit event ${eventType}`);
    }
    assert.equal(
      counts.get("goal.target_changed"),
      2,
      "the two target changes (slow and racing), no more"
    );
    assert.equal(counts.get("goal.missed"), 2);
    tests.push(
      "every creation, target change, rename, completion, miss and cancellation leaves an audit event, and repeated or refused ones leave none"
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
  console.error(`Goals PostgreSQL gate failed (${redactedFailure(error)})`);
  process.exitCode = 1;
});
