import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { windowsMissed } from "@polaris/domain/scheduling/scheduled-jobs";
import { createDatabase } from "../src/client";
import { createOutboxClient } from "../src/outbox-dispatch";
import {
  disposableHostPattern,
  expectSqlState,
  gateBranchPattern,
  journalMigrationCount,
  poolerPattern,
  redactedFailure,
  requiredEnvironment,
  temporaryRuntimeUrl,
} from "./sales-gate-support";

/**
 * The scheduler's state on a real PostgreSQL 18 (plan PR112, ADR 0086): the outbox role reaches it only
 * through three functions; a job is due once per window of its cadence (whole cadences since the epoch,
 * UTC); a live lease is busy and two ticks at once take it once; a failure or a skip gives the lease back
 * without covering the window, a success covers it by the instant the run started; a run that died is
 * taken over, and its late outcome records nothing; one run after a gap reports the windows missed.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const SCHEDULER_FUNCTIONS = [
  "public.claim_scheduled_job(text,integer,integer)",
  "public.complete_scheduled_job(text,uuid)",
  "public.release_scheduled_job(text,uuid,boolean)",
];
const OTHER_ROLES = [
  "polaris_pr11_runtime",
  "polaris_billing_runtime",
  "polaris_catalog_runtime",
  "polaris_admin_runtime",
  "polaris_privacy_runtime",
  "polaris_privacy_owner",
];
const TOKEN = /^[0-9a-f-]{36}$/;
const HOUR = 3600;
const DAY = 86_400;
const LEASE = 960;

async function run() {
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, gateBranchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);

  const owner = createDatabase(adminUrl, { maxConnections: 2 });
  const logins: [string, string][] = [];
  const tests: string[] = [];
  const closers: (() => Promise<unknown>)[] = [];
  const jobs: string[] = [];

  try {
    const server = await owner.pool.query<{
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
    const migrations = await owner.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations"
    );
    assert.equal(Number(migrations.rows[0]?.count), journalMigrationCount());
    tests.push(
      "disposable direct connection is PostgreSQL 18 with every migration replayed from scratch"
    );

    const login = async (group: string, prefix: string) => {
      const role = `${prefix}_${randomUUID().replaceAll("-", "")}`;
      const password = randomBytes(24).toString("hex");
      await owner.pool.query(
        `CREATE ROLE "${role}" WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`
      );
      await owner.pool.query(`GRANT "${group}" TO "${role}"`);
      logins.push([role, group]);
      return temporaryRuntimeUrl(adminUrl, role, password);
    };
    const outboxUrl = await login("polaris_outbox_runtime", "polaris_sch_disp");
    const scheduler = createOutboxClient(outboxUrl);
    closers.push(() => scheduler.close());
    const rival = createOutboxClient(outboxUrl);
    closers.push(() => rival.close());
    const direct = createDatabase(outboxUrl, { maxConnections: 1 });
    closers.push(() => direct.pool.end());

    const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
    const newJob = (label: string) => {
      const id = `gate.job_${label}_${suffix}`;
      jobs.push(id);
      return id;
    };
    const stateOf = async (job: string) => {
      const found = await owner.pool.query<{
        consecutive_failures: number;
        covered_ago: number | null;
        leased: boolean;
        success_recorded: boolean;
      }>(
        `SELECT consecutive_failures, leased_state.leased, covered_at IS NOT NULL AND last_success_at IS NOT NULL AS success_recorded,
                round(extract(epoch FROM now() - covered_at))::integer AS covered_ago
           FROM public.scheduled_job_state,
                LATERAL (SELECT lease_until IS NOT NULL AND token IS NOT NULL AS leased) AS leased_state
          WHERE job_id = $1`,
        [job]
      );
      const [row] = found.rows;
      assert.ok(row, `${job} has a state row`);
      return row;
    };

    // ------------------------------------------------- 1. who reaches what
    const permission = async (text: string, values: unknown[]) =>
      Boolean(
        (await owner.pool.query<{ allowed: boolean }>(text, values)).rows[0]
          ?.allowed
      );
    for (const role of ["polaris_outbox_runtime", ...OTHER_ROLES]) {
      assert.equal(
        // biome-ignore lint/performance/noAwaitInLoops: one role at a time, for a clear failure.
        await permission(
          "SELECT has_any_column_privilege($1, 'public.scheduled_job_state'::regclass, 'SELECT,INSERT,UPDATE,REFERENCES') OR has_table_privilege($1, 'public.scheduled_job_state'::regclass, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS allowed",
          [role]
        ),
        false,
        `${role} does not reach the scheduler state`
      );
    }
    assert.equal(
      await permission(
        "SELECT has_table_privilege('polaris_outbox_owner', 'public.scheduled_job_state'::regclass, 'SELECT,INSERT,UPDATE') AND NOT has_table_privilege('polaris_outbox_owner', 'public.scheduled_job_state'::regclass, 'DELETE,TRUNCATE') AS allowed",
        []
      ),
      true,
      "the owner reads, inserts and updates the state, and deletes nothing"
    );
    assert.equal(
      await permission(
        "SELECT c.relrowsecurity AND c.relforcerowsecurity AS allowed FROM pg_class c WHERE c.oid = 'public.scheduled_job_state'::regclass",
        []
      ),
      true,
      "row level security is forced"
    );
    for (const signature of SCHEDULER_FUNCTIONS) {
      for (const role of ["polaris_outbox_runtime", ...OTHER_ROLES]) {
        assert.equal(
          // biome-ignore lint/performance/noAwaitInLoops: privilege probes, in order.
          await permission(
            "SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed",
            [role, signature]
          ),
          role === "polaris_outbox_runtime",
          `${role} on ${signature}`
        );
      }
      assert.equal(
        await permission(
          "SELECT coalesce(bool_or(acl.grantee = 0), false) AS allowed FROM pg_proc p, LATERAL aclexplode(p.proacl) acl WHERE p.oid = $1::regprocedure",
          [signature]
        ),
        false,
        `PUBLIC does not execute ${signature}`
      );
      assert.equal(
        await permission(
          "SELECT p.prosecdef AND pg_get_userbyid(p.proowner) = 'polaris_outbox_owner' AS allowed FROM pg_proc p WHERE p.oid = $1::regprocedure",
          [signature]
        ),
        true,
        `${signature} runs as the outbox owner`
      );
    }
    await expectSqlState(
      () => direct.pool.query("SELECT * FROM public.scheduled_job_state"),
      "42501",
      "the login reads the state only through the functions"
    );
    await expectSqlState(
      () =>
        direct.pool.query(
          "UPDATE public.scheduled_job_state SET consecutive_failures = 0"
        ),
      "42501",
      "the login does not write the state directly"
    );
    tests.push(
      "the outbox runtime reaches the scheduler state only through three SECURITY DEFINER functions of the outbox owner, which no other role or PUBLIC executes; RLS is forced and nothing deletes"
    );

    // ------------------------------------------------- 2. due once per window
    const first = newJob("window");
    const claimed = await scheduler.claimScheduledJob(first, DAY, LEASE);
    assert.equal(claimed.result, "claimed");
    assert.ok(claimed.result === "claimed");
    assert.equal(claimed.missedWindows, 0, "the first run misses nothing");
    assert.equal(claimed.recovered, false);
    assert.match(claimed.token, TOKEN);
    assert.deepEqual(
      await rival.claimScheduledJob(first, DAY, LEASE),
      { result: "busy" },
      "a live lease is busy for another tick"
    );
    assert.equal(
      await scheduler.completeScheduledJob(first, claimed.token),
      true
    );
    assert.deepEqual(
      await rival.claimScheduledJob(first, DAY, LEASE),
      { result: "not_due" },
      "the window is covered once a run succeeded"
    );
    assert.deepEqual(await scheduler.claimScheduledJob(first, DAY, LEASE), {
      result: "not_due",
    });
    const afterSuccess = await stateOf(first);
    assert.equal(afterSuccess.leased, false);
    assert.equal(afterSuccess.success_recorded, true);
    tests.push(
      "a job is due once per window: claimed, busy while leased, not due after a success in the same window"
    );

    // ------------------------------------------------- 3. catch-up: one run covers every missed window
    const gap = newJob("gap");
    const firstRun = await scheduler.claimScheduledJob(gap, HOUR, LEASE);
    assert.ok(firstRun.result === "claimed");
    assert.equal(
      await scheduler.completeScheduledJob(gap, firstRun.token),
      true
    );
    // the last run started four whole windows ago: three were skipped
    await owner.pool.query(
      "UPDATE public.scheduled_job_state SET covered_at = now() - interval '4 hours' WHERE job_id = $1",
      [gap]
    );
    const catchUp = await scheduler.claimScheduledJob(gap, HOUR, LEASE);
    assert.ok(catchUp.result === "claimed");
    assert.equal(catchUp.missedWindows, 3);
    assert.equal(
      catchUp.missedWindows,
      windowsMissed(new Date(Date.now() - 4 * HOUR * 1000), new Date(), HOUR),
      "the database and the domain count the windows the same way"
    );
    assert.equal(
      await scheduler.completeScheduledJob(gap, catchUp.token),
      true
    );
    assert.deepEqual(
      await rival.claimScheduledJob(gap, HOUR, LEASE),
      { result: "not_due" },
      "a single run covered all the windows: the catch-up does not repeat"
    );
    tests.push(
      "after a gap one run is due, reports the windows it missed, and covers them: no second run in the window"
    );

    // ------------------------------------------------- 4. failure and skip leave the window uncovered
    const failing = newJob("failing");
    const attempt = await scheduler.claimScheduledJob(failing, HOUR, LEASE);
    assert.ok(attempt.result === "claimed");
    assert.equal(
      await scheduler.releaseScheduledJob(failing, attempt.token, "failed"),
      true
    );
    let state = await stateOf(failing);
    assert.equal(state.consecutive_failures, 1);
    assert.equal(state.success_recorded, false, "a failure covers nothing");
    assert.equal(state.leased, false);
    const retry = await rival.claimScheduledJob(failing, HOUR, LEASE);
    assert.ok(retry.result === "claimed", "the next tick runs it again");
    assert.equal(
      await rival.releaseScheduledJob(failing, retry.token, "skipped"),
      true
    );
    state = await stateOf(failing);
    assert.equal(state.consecutive_failures, 1, "a skip is not a failure");
    const third = await scheduler.claimScheduledJob(failing, HOUR, LEASE);
    assert.ok(third.result === "claimed");
    assert.equal(
      await scheduler.completeScheduledJob(failing, third.token),
      true
    );
    state = await stateOf(failing);
    assert.equal(state.consecutive_failures, 0, "a success clears the count");
    assert.equal(state.success_recorded, true);
    tests.push(
      "a failure is counted and a skip is not; neither covers the window, so the next tick runs the job again; a success clears the count"
    );

    // ------------------------------------------------- 5. a run that died is taken over
    const dying = newJob("dying");
    const doomed = await scheduler.claimScheduledJob(dying, HOUR, LEASE);
    assert.ok(doomed.result === "claimed");
    await owner.pool.query(
      "UPDATE public.scheduled_job_state SET lease_until = now() - interval '1 second' WHERE job_id = $1",
      [dying]
    );
    const successor = await rival.claimScheduledJob(dying, HOUR, LEASE);
    assert.ok(successor.result === "claimed", "an expired lease is taken over");
    assert.equal(successor.recovered, true);
    assert.notEqual(successor.token, doomed.token);
    assert.equal(
      await scheduler.completeScheduledJob(dying, doomed.token),
      false,
      "the late outcome of the dead run records nothing"
    );
    assert.equal(
      await scheduler.releaseScheduledJob(dying, doomed.token, "failed"),
      false
    );
    state = await stateOf(dying);
    assert.equal(state.leased, true, "the successor still holds the lease");
    assert.equal(state.consecutive_failures, 0);
    assert.equal(
      await rival.completeScheduledJob(dying, successor.token),
      true
    );
    assert.equal(
      await rival.completeScheduledJob(dying, successor.token),
      false,
      "an outcome is recorded once"
    );
    tests.push(
      "a run whose lease ended is taken over (recovered), and the old run's late outcome neither covers nor fails anything"
    );

    // ------------------------------------------------- 6. the window is counted from the start of the run
    const long = newJob("long");
    const slow = await scheduler.claimScheduledJob(long, HOUR, LEASE);
    assert.ok(slow.result === "claimed");
    // the run started two windows ago and has only now ended
    await owner.pool.query(
      "UPDATE public.scheduled_job_state SET last_started_at = now() - interval '2 hours' WHERE job_id = $1",
      [long]
    );
    assert.equal(await scheduler.completeScheduledJob(long, slow.token), true);
    state = await stateOf(long);
    assert.ok(
      Math.abs((state.covered_ago ?? 0) - 2 * HOUR) <= 5,
      "the window reference is the start of the run, not its end"
    );
    const later = await scheduler.claimScheduledJob(long, HOUR, LEASE);
    assert.ok(
      later.result === "claimed",
      "a run that outlived its window does not cover the next one"
    );
    assert.equal(later.missedWindows, 1);
    await scheduler.releaseScheduledJob(long, later.token, "skipped");
    tests.push(
      "a success covers the windows up to the instant the run started, so a run that crossed a boundary does not swallow the next window"
    );

    // ------------------------------------------------- 7. a cadence change takes effect without a migration
    const cadence = newJob("cadence");
    const slowCadence = await scheduler.claimScheduledJob(cadence, DAY, LEASE);
    assert.ok(slowCadence.result === "claimed");
    assert.equal(
      await scheduler.completeScheduledJob(cadence, slowCadence.token),
      true
    );
    await owner.pool.query(
      "UPDATE public.scheduled_job_state SET covered_at = now() - interval '2 minutes' WHERE job_id = $1",
      [cadence]
    );
    assert.deepEqual(
      await scheduler.claimScheduledJob(cadence, DAY, LEASE),
      { result: "not_due" },
      "two minutes ago is the same day"
    );
    const faster = await scheduler.claimScheduledJob(cadence, 60, LEASE);
    assert.ok(
      faster.result === "claimed",
      "the same state is due under a one minute cadence"
    );
    assert.equal(faster.missedWindows, 1);
    await scheduler.releaseScheduledJob(cadence, faster.token, "skipped");
    tests.push(
      "the cadence is an argument of the claim, not stored: changing it in the registry needs no migration"
    );

    // ------------------------------------------------- 8. two ticks at once take the lease once
    const racing = newJob("race");
    const results = await Promise.all(
      Array.from({ length: 6 }, (_unused, index) =>
        (index % 2 === 0 ? scheduler : rival).claimScheduledJob(
          racing,
          HOUR,
          LEASE
        )
      )
    );
    assert.equal(
      results.filter((result) => result.result === "claimed").length,
      1
    );
    assert.equal(
      results.filter((result) => result.result === "busy").length,
      5
    );
    tests.push(
      "six simultaneous ticks on two connections take the lease of a new job exactly once"
    );

    // ------------------------------------------------- 9. bad arguments are refused
    const refuse = (call: () => Promise<unknown>, message: string) =>
      expectSqlState(call, "22023", message);
    await refuse(
      () => scheduler.claimScheduledJob("Bad Job", HOUR, LEASE),
      "a job name is lowercase dotted words"
    );
    await refuse(
      () =>
        scheduler.claimScheduledJob(`gate.job_${"x".repeat(80)}`, HOUR, LEASE),
      "a job name has at most 64 characters"
    );
    await refuse(
      () => scheduler.claimScheduledJob(newJob("short"), 30, LEASE),
      "a cadence is at least a minute"
    );
    await refuse(
      () => scheduler.claimScheduledJob(newJob("week"), 604_801, LEASE),
      "a cadence is at most a week"
    );
    await refuse(
      () => scheduler.claimScheduledJob(newJob("lease"), HOUR, 30),
      "a lease is at least a minute"
    );
    await refuse(
      () => scheduler.claimScheduledJob(newJob("lease"), HOUR, 7200),
      "a lease is at most an hour"
    );
    await refuse(
      () =>
        direct.pool.query(
          "SELECT public.complete_scheduled_job('gate.job_x', NULL)"
        ),
      "a completion needs a token"
    );
    assert.equal(
      await scheduler.completeScheduledJob(newJob("never"), randomUUID()),
      false,
      "a token that holds nothing records nothing"
    );
    assert.equal(
      await scheduler.releaseScheduledJob(
        "gate.job_nobody",
        randomUUID(),
        "failed"
      ),
      false
    );
    const refusedRows = await owner.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.scheduled_job_state WHERE job_id = ANY($1::text[])",
      [[`gate.job_${"x".repeat(80)}`, "Bad Job"]]
    );
    assert.equal(
      refusedRows.rows[0]?.count,
      "0",
      "a refused claim leaves no row"
    );
    await expectSqlState(
      () =>
        owner.pool.query(
          "INSERT INTO public.scheduled_job_state (job_id, lease_until) VALUES ($1, now())",
          [`gate.job_incoherent_${suffix}`]
        ),
      "23514",
      "a lease without its token is refused by the table"
    );
    tests.push(
      "names, cadences, leases and tokens out of range are refused (22023) and leave no row; the table refuses a lease without a token"
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
    for (const close of closers.reverse()) {
      // biome-ignore lint/performance/noAwaitInLoops: Cleanups, in order.
      await close().catch(() => undefined);
    }
    await owner.pool
      .query(
        "DELETE FROM public.scheduled_job_state WHERE job_id LIKE 'gate.job\\_%'"
      )
      .catch(() => undefined);
    for (const [role, group] of logins) {
      // biome-ignore lint/performance/noAwaitInLoops: Cleanups, in order.
      await owner.pool.query(`REVOKE "${group}" FROM "${role}"`);
      await owner.pool.query(`DROP ROLE IF EXISTS "${role}"`);
    }
    await owner.pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    `Scheduled jobs PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
